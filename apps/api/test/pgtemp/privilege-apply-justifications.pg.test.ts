import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPrivileges, sha256 } from '../../src/db/privilege-apply.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Ejecucion controlada de la propuesta 0007 (recepcion de justificantes) en un PostgreSQL 18 DESECHABLE con la historia de eta15_dev:
 * 0002, 0003 y 0004 ya aplicadas y las migraciones aplicadas; 0007 todavia no. No toca eta15_dev.
 */
const applySql = privilegeFile('0007-justifications-write.apply.sql');
const verifySql = privilegeFile('0007-justifications-write.verify.sql');
const proposalSql = privilegeFile('0007-justifications-write.proposal.sql');
const input = (commit: boolean) => ({
  applySql,
  verifySql,
  proposalSql,
  expectedApplySha256: sha256(applySql),
  commit,
});

let cluster: ApiCluster;
const owner = (sql: string) => cluster.owner.query(sql);
const can = async (col: string, priv: 'SELECT' | 'INSERT') =>
  (
    await cluster.owner.query<{ w: boolean }>(
      `select has_column_privilege('eta15_api', 'justification_receipts', '${col}', '${priv}') as w`,
    )
  ).rows[0]!.w;
const canRead = () => can('folio', 'SELECT');

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

describe('ejecucion controlada de los GRANT 0007 (clúster desechable)', () => {
  it('estado inicial: la tabla de 0013 no hereda ningun privilegio de eta15_api', async () => {
    expect(await canRead()).toBe(false);
  });

  it('el ensayo (ROLLBACK) valida preflight, GRANT y verificador sin dejar cambios', async () => {
    const r = await applyPrivileges(cluster.owner, input(false));
    expect(r).toMatchObject({ committed: false });
    expect(r.grants).toHaveLength(2);
    expect(await canRead()).toBe(false);
  });

  it('la ejecucion (COMMIT) aplica el acceso por columna, el verificador aprueba y es idempotente', async () => {
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    expect(await canRead()).toBe(true);
    expect(await can('student_id', 'INSERT')).toBe(true);
    expect(await can('received_at', 'INSERT')).toBe(false);
    expect(await can('folio', 'INSERT')).toBe(false);
    await cluster.owner.query(verifySql);
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    await cluster.owner.query(verifySql);
  });

  it('un SHA-256 distinto al revisado se rechaza antes de tocar la base; el rol de la API no puede ejecutarla', async () => {
    await expect(
      applyPrivileges(cluster.owner, { ...input(true), expectedApplySha256: sha256('otro') }),
    ).rejects.toThrow(/SHA-256/);
    await expect(
      applyPrivileges({ query: (sql) => cluster.pool.query(sql) }, input(true)),
    ).rejects.toThrow();
    expect(await canRead()).toBe(false);
  });

  it.each([
    [
      'un UPDATE previo',
      'grant update (status) on justification_receipts to eta15_api',
      /fuera de lo aprobado: justification_receipts\.status/,
    ],
    [
      'un DELETE previo',
      'grant delete on justification_receipts to eta15_api',
      /DELETE previo sobre justification_receipts/,
    ],
    ['un TRIGGER previo', 'grant trigger on justification_receipts to eta15_api', /TRIGGER previo/],
    [
      'una columna no aprobada (INSERT)',
      'grant insert (received_at) on justification_receipts to eta15_api',
      /fuera de lo aprobado: justification_receipts\.received_at/,
    ],
    [
      'escritura previa en role_permissions',
      'grant insert on role_permissions to eta15_api',
      /role_permissions/,
    ],
    [
      'GRANT OPTION previo',
      'grant select on justification_receipts to eta15_api with grant option',
      /GRANT OPTION previo/,
    ],
    [
      'un privilegio de PUBLIC',
      'grant select (id) on justification_receipts to public',
      /PUBLIC o GRANT OPTION previo/,
    ],
  ])(
    'el preflight se detiene con %s y no queda ningun cambio parcial',
    async (_n, tamper, pattern) => {
      await owner(tamper);
      await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(pattern);
      expect(await can('student_id', 'INSERT')).toBe(false);
    },
  );

  it('el preflight se detiene si falta un trigger de proteccion de la migracion 0013', async () => {
    await owner('drop trigger jr_no_update on justification_receipts');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/jr_no_update/);
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta la propuesta 0003 (la API no lee matriculas ni alumnos)', async () => {
    await owner('revoke all on students from eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /propuestas 0002 y 0003/,
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
