import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPrivileges, sha256 } from '../../src/db/privilege-apply.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Ejecucion controlada de la propuesta 0003 (alumnos) en un PostgreSQL 18 DESECHABLE con la misma historia que eta15_dev:
 * roles y privilegios aplicados con 0000-0006 y migracion 0007 posterior. No toca eta15_dev.
 */
const applySql = privilegeFile('0003-students-write.apply.sql');
const verifySql = privilegeFile('0003-students-write.verify.sql');
const proposalSql = privilegeFile('0003-students-write.proposal.sql');
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
      `select has_column_privilege('eta15_api', 'students', 'given_names', 'SELECT') as w`,
    )
  ).rows[0]!.w;

beforeEach(async () => {
  if (cluster) await cluster.stop();
  // Como eta15_dev: la propuesta 0002 (catalogo) ya esta aplicada; 0003 la exige en su preflight.
  cluster = await startApiCluster(5, { catalogWrite: true });
}, 240_000);
afterAll(async () => {
  if (cluster) await cluster.stop();
}, 60_000);

describe('ejecucion controlada de los GRANT 0003 (clúster desechable)', () => {
  it('estado inicial: las tablas de 0007 no heredan ningun privilegio de eta15_api', async () => {
    expect(await canRead()).toBe(false);
  });

  it('el ensayo (ROLLBACK) valida preflight, GRANT y verificador sin dejar cambios', async () => {
    const r = await applyPrivileges(cluster.owner, input(false));
    expect(r).toMatchObject({ committed: false });
    expect(r.grants).toHaveLength(9);
    expect(await canRead()).toBe(false);
  });

  it('la ejecucion (COMMIT) aplica el acceso por columna, el verificador aprueba y es idempotente', async () => {
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    expect(await canRead()).toBe(true);
    await cluster.owner.query(verifySql);
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    await cluster.owner.query(verifySql);
  });

  it('el rol de la API no puede ejecutarla (identidad distinta de eta15_app)', async () => {
    await expect(
      applyPrivileges({ query: (sql) => cluster.pool.query(sql) }, input(true)),
    ).rejects.toThrow();
    expect(await canRead()).toBe(false);
  });

  it.each([
    ['un DELETE previo', 'grant delete on students to eta15_api', /DELETE previo sobre students/],
    ['un TRIGGER previo', 'grant trigger on enrollments to eta15_api', /TRIGGER previo/],
    [
      'escritura previa en role_permissions',
      'grant insert on role_permissions to eta15_api',
      /role_permissions/,
    ],
    [
      'una columna no aprobada (UPDATE)',
      'grant update (student_id) on enrollments to eta15_api',
      /fuera de lo aprobado: enrollments\.student_id/,
    ],
    [
      'una columna no aprobada (SELECT)',
      'grant select (updated_at) on student_group_assignments to eta15_api',
      /fuera de lo aprobado: student_group_assignments\.updated_at/,
    ],
    [
      'GRANT OPTION previo',
      'grant select on students to eta15_api with grant option',
      /GRANT OPTION previo/,
    ],
    [
      'un privilegio de PUBLIC',
      'grant select on enrollments to public',
      /PUBLIC o GRANT OPTION previo/,
    ],
  ])(
    'el preflight se detiene con %s y no queda ningun cambio parcial',
    async (_n, tamper, pattern) => {
      await owner(tamper);
      await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(pattern);
      const w = await cluster.owner.query<{ w: boolean }>(
        `select has_column_privilege('eta15_api', 'student_group_assignments', 'starts_on', 'INSERT') as w`,
      );
      expect(w.rows[0]!.w).toBe(false);
    },
  );

  it('el preflight se detiene si falta la migracion 0007 o un trigger de proteccion', async () => {
    await owner('drop trigger students_no_delete on students');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/students_no_delete/);
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

describe('prerrequisito: propuesta 0002 (catalogo)', () => {
  it('el preflight se detiene si eta15_api no puede leer ni bloquear school_years', async () => {
    await owner('revoke all on school_years from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /school_years.*propuesta 0002/s,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta el trigger school_years_guard_dates', async () => {
    await owner('drop trigger school_years_guard_dates on school_years');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /school_years_guard_dates/,
    );
    expect(await canRead()).toBe(false);
  });
});

describe('transicion: 0007 + 0002 aplicadas y 0003 todavia no', () => {
  const changeDates = () =>
    cluster.pool.query(
      "update school_years set starts_on = starts_on + 1 where name = 'Transicion'",
    );

  it('cambiar las fechas de un ciclo falla con 42501 hasta aplicar 0003; despues funciona (el resto del catalogo no depende de 0003)', async () => {
    await owner(
      "insert into school_years (name, starts_on, ends_on) values ('Transicion', '2260-01-01', '2260-12-31')",
    );
    // renombrar no dispara el trigger de fechas
    await cluster.pool.query(
      "update school_years set name = 'Transicion' where name = 'Transicion'",
    );
    await expect(changeDates()).rejects.toMatchObject({ code: '42501' });
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    await changeDates();
  });
});
