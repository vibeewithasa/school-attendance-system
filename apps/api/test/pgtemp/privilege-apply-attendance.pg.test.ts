import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPrivileges, sha256 } from '../../src/db/privilege-apply.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Ejecucion controlada de la propuesta 0005 (asistencia diaria) en un PostgreSQL 18 DESECHABLE con la historia de eta15_dev:
 * 0002, 0003 y 0004 ya aplicadas y migraciones 0007-0010 aplicadas; 0005 todavia no. No toca eta15_dev.
 */
const applySql = privilegeFile('0005-attendance-write.apply.sql');
const verifySql = privilegeFile('0005-attendance-write.verify.sql');
const proposalSql = privilegeFile('0005-attendance-write.proposal.sql');
const input = (commit: boolean) => ({
  applySql,
  verifySql,
  proposalSql,
  expectedApplySha256: sha256(applySql),
  commit,
});

let cluster: ApiCluster;
const owner = (sql: string) => cluster.owner.query(sql);
const canRead = async () =>
  (
    await cluster.owner.query<{ w: boolean }>(
      `select has_column_privilege('eta15_api', 'attendance_days', 'group_id', 'SELECT') as w`,
    )
  ).rows[0]!.w;
const canInsert = async () =>
  (
    await cluster.owner.query<{ w: boolean }>(
      `select has_column_privilege('eta15_api', 'attendance_days', 'created_by', 'INSERT') as w`,
    )
  ).rows[0]!.w;

beforeEach(async () => {
  if (cluster) await cluster.stop();
  cluster = await startApiCluster(5, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
  });
}, 240_000);
afterAll(async () => {
  if (cluster) await cluster.stop();
}, 60_000);

describe('ejecucion controlada de los GRANT 0005 (clúster desechable)', () => {
  it('estado inicial: las tablas de 0010 no heredan ningun privilegio de eta15_api', async () => {
    expect(await canRead()).toBe(false);
  });

  it('el ensayo (ROLLBACK) valida preflight, GRANT y verificador sin dejar cambios', async () => {
    const r = await applyPrivileges(cluster.owner, input(false));
    expect(r).toMatchObject({ committed: false });
    expect(r.grants).toHaveLength(8);
    expect(await canRead()).toBe(false);
  });

  it('la ejecucion (COMMIT) aplica el acceso por columna, el verificador aprueba y es idempotente', async () => {
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    expect(await canRead()).toBe(true);
    await cluster.owner.query(verifySql);
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    await cluster.owner.query(verifySql);
  });

  it('un SHA-256 distinto al revisado se rechaza antes de tocar la base', async () => {
    await expect(
      applyPrivileges(cluster.owner, { ...input(true), expectedApplySha256: sha256('otro') }),
    ).rejects.toThrow(/SHA-256/);
    expect(await canRead()).toBe(false);
  });

  it('el rol de la API no puede ejecutarla (identidad distinta de eta15_app)', async () => {
    await expect(
      applyPrivileges({ query: (sql) => cluster.pool.query(sql) }, input(true)),
    ).rejects.toThrow();
    expect(await canRead()).toBe(false);
  });

  it.each([
    [
      'un DELETE previo',
      'grant delete on attendance_days to eta15_api',
      /DELETE previo sobre attendance_days/,
    ],
    ['un TRIGGER previo', 'grant trigger on attendance_records to eta15_api', /TRIGGER previo/],
    [
      'escritura previa en role_permissions',
      'grant insert on role_permissions to eta15_api',
      /role_permissions/,
    ],
    [
      'un UPDATE previo en el historial',
      'grant update (new_status) on attendance_events to eta15_api',
      /fuera de lo aprobado: attendance_events\.new_status/,
    ],
    [
      'una columna no aprobada (UPDATE)',
      'grant update (finalized_at) on attendance_days to eta15_api',
      /fuera de lo aprobado: attendance_days\.finalized_at/,
    ],
    [
      'una columna no aprobada (SELECT)',
      'grant select (updated_at) on attendance_records to eta15_api',
      /fuera de lo aprobado: attendance_records\.updated_at/,
    ],
    [
      'GRANT OPTION previo',
      'grant select on attendance_events to eta15_api with grant option',
      /GRANT OPTION previo/,
    ],
    [
      'un privilegio de PUBLIC',
      'grant select (id) on attendance_days to public',
      /PUBLIC o GRANT OPTION previo/,
    ],
  ])(
    'el preflight se detiene con %s y no queda ningun cambio parcial',
    async (_n, tamper, pattern) => {
      await owner(tamper);
      await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(pattern);
      expect(await canInsert()).toBe(false);
    },
  );

  it('el preflight se detiene si falta un trigger de proteccion de la migracion 0010', async () => {
    await owner('drop trigger att_days_guard_update on attendance_days');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /att_days_guard_update/,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta la propuesta 0004 (la API no lee las asignaciones de prefectura)', async () => {
    await owner('revoke all on prefect_group_assignments from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /prefect_group_assignments/,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta la propuesta 0003 (la API no lee matriculas ni alumnos)', async () => {
    await owner('revoke all on students from eta15_api');
    await owner('revoke all on student_group_assignments from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /propuestas 0002, 0003 y 0004/,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si la API no puede bloquear filas (FOR SHARE necesita algun UPDATE de columna)', async () => {
    await owner('revoke update (ends_on) on student_group_assignments from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /student_group_assignments/,
    );
    expect(await canRead()).toBe(false);
  });

  it('si el verificador falla despues de los GRANT, se revierten los GRANT (transaccion unica)', async () => {
    const roto = verifySql.replace(
      "RAISE NOTICE 'OK",
      "RAISE EXCEPTION 'forzado'; RAISE NOTICE 'OK",
    );
    await expect(
      applyPrivileges(cluster.owner, { ...input(true), verifySql: roto }),
    ).rejects.toThrow(/forzado/);
    expect(await canRead()).toBe(false);
  });
});

describe('transicion: 0010 aplicada y 0005 todavia no', () => {
  it('cambiar las fechas de un ciclo falla con 42501 hasta aplicar 0005; despues funciona', async () => {
    await owner(
      "insert into school_years (name, starts_on, ends_on) values ('Transicion', '2260-01-01', '2260-12-31')",
    );
    const changeDates = () =>
      cluster.pool.query(
        "update school_years set starts_on = starts_on + 1 where name = 'Transicion'",
      );
    await expect(changeDates()).rejects.toMatchObject({ code: '42501' });
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    await changeDates();
  });
});
