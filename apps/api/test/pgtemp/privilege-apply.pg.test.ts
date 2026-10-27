import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPrivileges, sha256 } from '../../src/db/privilege-apply.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Ejecucion controlada de la propuesta 0002 en un PostgreSQL 18 DESECHABLE con el mismo estado que eta15_dev tras 0006
 * (el clúster aplica las migraciones y los privilegios reales de eta15_api). No toca eta15_dev.
 */
const applySql = privilegeFile('0002-school-catalog-write.apply.sql');
const verifySql = privilegeFile('0002-school-catalog-write.verify.sql');
const proposalSql = privilegeFile('0002-school-catalog-write.proposal.sql');
const input = (commit: boolean) => ({
  applySql,
  verifySql,
  proposalSql,
  expectedApplySha256: sha256(applySql),
  commit,
});

let cluster: ApiCluster;
const owner = (sql: string) => cluster.owner.query(sql);
const canWrite = async () =>
  (
    await cluster.owner.query<{ w: boolean }>(
      `select has_column_privilege('eta15_api', 'groups', 'expected_entry_time', 'UPDATE') as w`,
    )
  ).rows[0]!.w;

beforeEach(async () => {
  if (cluster) await cluster.stop();
  cluster = await startApiCluster(5);
}, 240_000);
afterAll(async () => {
  if (cluster) await cluster.stop();
}, 60_000);

describe('ejecucion controlada de los GRANT 0002 (clúster desechable)', () => {
  it('el ensayo (ROLLBACK) valida preflight, GRANT y verificador sin dejar cambios', async () => {
    expect(await canWrite()).toBe(false);
    const r = await applyPrivileges(cluster.owner, input(false));
    expect(r.committed).toBe(false);
    expect(r.grants).toHaveLength(4);
    expect(await canWrite()).toBe(false);
  });

  it('la ejecucion (COMMIT) aplica exactamente la escritura por columna y es idempotente', async () => {
    const r = await applyPrivileges(cluster.owner, input(true));
    expect(r.committed).toBe(true);
    expect(await canWrite()).toBe(true);
    await cluster.owner.query(verifySql); // el verificador oficial aprueba el estado final
    const again = await applyPrivileges(cluster.owner, input(true)); // repetir no cambia ni rompe nada
    expect(again.committed).toBe(true);
    await cluster.owner.query(verifySql);
  });

  it('el rol de la API no puede ejecutarla (identidad distinta de eta15_app)', async () => {
    await expect(
      applyPrivileges({ query: (sql) => cluster.pool.query(sql) }, input(true)),
    ).rejects.toThrow();
    expect(await canWrite()).toBe(false);
  });

  it.each([
    ['un DELETE previo', 'grant delete on groups to eta15_api', /DELETE previo sobre groups/],
    ['un TRIGGER previo', 'grant trigger on school_years to eta15_api', /TRIGGER previo/],
    [
      'escritura previa en role_permissions',
      'grant insert on role_permissions to eta15_api',
      /role_permissions/,
    ],
    [
      'una columna no aprobada',
      'grant update (grade) on groups to eta15_api',
      /fuera de lo aprobado: groups\.grade/,
    ],
    [
      'GRANT OPTION previo',
      'grant select on groups to eta15_api with grant option',
      /GRANT OPTION previo/,
    ],
    [
      'un privilegio de PUBLIC',
      'grant select on school_years to public',
      /PUBLIC o GRANT OPTION previo/,
    ],
    ['pertenencia a eta15_app', 'grant eta15_app to eta15_api', /miembro de ningun rol/],
  ])(
    'el preflight se detiene con %s y no queda ningun cambio parcial',
    async (_n, tamper, pattern) => {
      if (tamper.startsWith('grant eta15_app')) {
        // la pertenencia entre roles la concede un superusuario (el propietario no puede)
        const su = await cluster.pgt.connect();
        await su.query(tamper);
        await su.end();
      } else await owner(tamper);
      await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(pattern);
      expect(await canWrite()).toBe(false);
      const ins = await cluster.owner.query<{ w: boolean }>(
        `select has_column_privilege('eta15_api', 'school_years', 'name', 'INSERT') as w`,
      );
      expect(ins.rows[0]!.w).toBe(false);
    },
  );

  it('si el verificador falla despues de los GRANT, se revierten los GRANT (transaccion unica)', async () => {
    const roto = verifySql.replace(
      "RAISE NOTICE 'OK",
      "RAISE EXCEPTION 'forzado'; RAISE NOTICE 'OK",
    );
    await expect(
      applyPrivileges(cluster.owner, { ...input(true), verifySql: roto }),
    ).rejects.toThrow(/forzado/);
    expect(await canWrite()).toBe(false);
  });
});
