import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPrivileges, sha256 } from '../../src/db/privilege-apply.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Ejecucion controlada de la propuesta 0004 (asignaciones de prefectura) en un PostgreSQL 18 DESECHABLE con la historia de
 * eta15_dev: 0002 y 0003 ya aplicadas y migraciones 0007-0009 aplicadas; 0004 todavia no. No toca eta15_dev.
 */
const applySql = privilegeFile('0004-prefect-assignments-write.apply.sql');
const verifySql = privilegeFile('0004-prefect-assignments-write.verify.sql');
const proposalSql = privilegeFile('0004-prefect-assignments-write.proposal.sql');
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
      `select has_column_privilege('eta15_api', 'prefect_group_assignments', 'group_id', 'SELECT') as w`,
    )
  ).rows[0]!.w;

beforeEach(async () => {
  if (cluster) await cluster.stop();
  cluster = await startApiCluster(5, { catalogWrite: true, studentsWrite: true });
}, 240_000);
afterAll(async () => {
  if (cluster) await cluster.stop();
}, 60_000);

describe('ejecucion controlada de los GRANT 0004 (clúster desechable)', () => {
  it('estado inicial: la tabla de 0009 no hereda ningun privilegio de eta15_api', async () => {
    expect(await canRead()).toBe(false);
  });

  it('el ensayo (ROLLBACK) valida preflight, GRANT y verificador sin dejar cambios', async () => {
    const r = await applyPrivileges(cluster.owner, input(false));
    expect(r).toMatchObject({ committed: false });
    expect(r.grants).toHaveLength(3);
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
      'grant delete on prefect_group_assignments to eta15_api',
      /DELETE previo sobre prefect_group_assignments/,
    ],
    [
      'un TRIGGER previo',
      'grant trigger on prefect_group_assignments to eta15_api',
      /TRIGGER previo/,
    ],
    [
      'escritura previa en role_permissions',
      'grant insert on role_permissions to eta15_api',
      /role_permissions/,
    ],
    [
      'una columna no aprobada (UPDATE)',
      'grant update (starts_on) on prefect_group_assignments to eta15_api',
      /fuera de lo aprobado: prefect_group_assignments\.starts_on/,
    ],
    [
      'una columna no aprobada (SELECT)',
      'grant select (updated_at) on prefect_group_assignments to eta15_api',
      /fuera de lo aprobado: prefect_group_assignments\.updated_at/,
    ],
    [
      'GRANT OPTION previo',
      'grant select on prefect_group_assignments to eta15_api with grant option',
      /GRANT OPTION previo/,
    ],
    [
      'un privilegio de PUBLIC',
      'grant select (id) on prefect_group_assignments to public',
      /PUBLIC o GRANT OPTION previo/,
    ],
  ])(
    'el preflight se detiene con %s y no queda ningun cambio parcial',
    async (_n, tamper, pattern) => {
      await owner(tamper);
      await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(pattern);
      const w = await cluster.owner.query<{ w: boolean }>(
        `select has_column_privilege('eta15_api', 'prefect_group_assignments', 'user_id', 'INSERT') as w`,
      );
      expect(w.rows[0]!.w).toBe(false);
    },
  );

  it('el preflight se detiene si falta un trigger de proteccion de la migracion 0009', async () => {
    await owner('drop trigger pga_guard_insert on prefect_group_assignments');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/pga_guard_insert/);
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si faltan los prerrequisitos de lectura (propuesta 0002)', async () => {
    await owner('revoke all on school_years from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/school_years/);
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta la propuesta 0003 (la API no lee matriculas)', async () => {
    await owner('revoke all on enrollments from eta15_api');
    await owner('revoke all on student_group_assignments from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/propuesta 0003/);
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si la API no puede bloquear user_roles (FOR SHARE necesita algun UPDATE de columna)', async () => {
    await owner('revoke update on user_roles from eta15_api');
    await owner('revoke update (revoked_at, revoked_by) on user_roles from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/user_roles/);
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

describe('transicion: 0009 aplicada y 0004 todavia no', () => {
  it('cambiar las fechas de un ciclo falla con 42501 hasta aplicar 0004; despues funciona', async () => {
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
