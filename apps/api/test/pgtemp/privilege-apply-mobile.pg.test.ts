import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPrivileges, sha256 } from '../../src/db/privilege-apply.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Ejecucion controlada de la propuesta 0006 (autenticacion movil aislada) en un PostgreSQL 18 DESECHABLE con la historia que tendria
 * eta15_dev si se aplicaran 0011 y las propuestas 0002 a 0005; 0006 todavia no. No toca eta15_dev.
 */
const applySql = privilegeFile('0006-mobile-auth-write.apply.sql');
const verifySql = privilegeFile('0006-mobile-auth-write.verify.sql');
const proposalSql = privilegeFile('0006-mobile-auth-write.proposal.sql');
const input = (commit: boolean) => ({
  applySql,
  verifySql,
  proposalSql,
  expectedApplySha256: sha256(applySql),
  commit,
});

let cluster: ApiCluster;
const owner = (sql: string) => cluster.owner.query(sql);
const flag = async (sql: string) => (await cluster.owner.query<{ w: boolean }>(sql)).rows[0]!.w;
const canRead = () =>
  flag(`select has_column_privilege('eta15_api', 'mobile_devices', 'status', 'SELECT') as w`);
const canExecute = () =>
  flag(
    `select has_function_privilege('eta15_api', 'public.mobile_actor_can_manage(uuid)'::regprocedure, 'EXECUTE') as w`,
  );

beforeEach(async () => {
  if (cluster) await cluster.stop();
  cluster = await startApiCluster(5, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
  });
}, 240_000);
afterAll(async () => {
  if (cluster) await cluster.stop();
}, 60_000);

describe('ejecucion controlada de los GRANT 0006 (clúster desechable)', () => {
  it('estado inicial: las tablas y funciones de 0011 no dan ningun privilegio a eta15_api', async () => {
    expect(await canRead()).toBe(false);
    expect(await canExecute()).toBe(false);
  });

  it('el ensayo (ROLLBACK) valida preflight, GRANT y verificador sin dejar cambios', async () => {
    const r = await applyPrivileges(cluster.owner, input(false));
    expect(r).toMatchObject({ committed: false });
    expect(r.grants).toHaveLength(16);
    expect(await canRead()).toBe(false);
    expect(await canExecute()).toBe(false);
  });

  it('la ejecucion (COMMIT) aplica el acceso por columna y EXECUTE, el verificador aprueba y es idempotente', async () => {
    expect((await applyPrivileges(cluster.owner, input(true))).committed).toBe(true);
    expect(await canRead()).toBe(true);
    expect(await canExecute()).toBe(true);
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
      'grant delete on mobile_sessions to eta15_api',
      /DELETE previo sobre mobile_sessions/,
    ],
    ['un TRIGGER previo', 'grant trigger on mobile_devices to eta15_api', /TRIGGER previo/],
    [
      'un TRUNCATE previo',
      'grant truncate on mobile_device_requests to eta15_api',
      /TRUNCATE previo/,
    ],
    [
      'escritura previa en role_permissions',
      'grant insert on role_permissions to eta15_api',
      /role_permissions/,
    ],
    [
      'un UPDATE de la clave publica (identidad)',
      'grant update (public_key_jwk) on mobile_devices to eta15_api',
      /fuera de lo aprobado: mobile_devices\.public_key_jwk/,
    ],
    [
      'un UPDATE de una hora fijada por trigger',
      'grant update (approved_at) on mobile_device_requests to eta15_api',
      /fuera de lo aprobado: mobile_device_requests\.approved_at/,
    ],
    [
      'un SELECT de una columna no aprobada',
      'grant select (updated_at) on mobile_device_requests to eta15_api',
      /fuera de lo aprobado: mobile_device_requests\.updated_at/,
    ],
    [
      'GRANT OPTION previo',
      'grant select on mobile_sessions to eta15_api with grant option',
      /GRANT OPTION previo/,
    ],
    [
      'un privilegio de PUBLIC',
      'grant select (id) on mobile_devices to public',
      /PUBLIC o GRANT OPTION previo/,
    ],
    [
      'EXECUTE de PUBLIC sobre una funcion',
      'grant execute on function mobile_actor_can_manage(uuid) to public',
      /PUBLIC o GRANT OPTION previo en la funcion mobile_actor_can_manage/,
    ],
  ])(
    'el preflight se detiene con %s y no queda ningun cambio parcial',
    async (_n, tamper, pattern) => {
      await owner(tamper);
      await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(pattern);
      expect(
        await flag(
          `select has_column_privilege('eta15_api', 'mobile_devices', 'revoke_reason', 'UPDATE') as w`,
        ),
      ).toBe(false);
    },
  );

  it('el preflight se detiene si falta un trigger de proteccion de la migracion 0011', async () => {
    await owner('drop trigger md_guard_update on mobile_devices');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/md_guard_update/);
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta el indice de una sola sesion activa por dispositivo', async () => {
    await owner('drop index ms_one_active_per_device');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /ms_one_active_per_device/,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si falta un permiso movil del catalogo RBAC', async () => {
    await owner(
      "delete from role_permissions where permission_id = (select id from permissions where key = 'mobile_devices:enroll')",
    );
    await owner("delete from permissions where key = 'mobile_devices:enroll'");
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /mobile_devices:enroll/,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si la API no puede leer roles.requires_mfa (la elegibilidad fallaria)', async () => {
    // el SELECT de tabla completa tapa cualquier REVOKE de columna: se retira y se devuelve solo lo anterior a requires_mfa
    await owner('revoke select on roles from eta15_api');
    await owner('grant select (id, key) on roles to eta15_api');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(
      /roles\.requires_mfa/,
    );
    expect(await canRead()).toBe(false);
  });

  it('el preflight se detiene si faltan las proteccion del estado efimero (trigger solo-agregar o llave unica del jti)', async () => {
    await owner('drop trigger mpj_no_update on mobile_proof_jtis');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/mpj_no_update/);
    await owner('alter table mobile_proof_jtis drop constraint mpj_pkey');
    await expect(applyPrivileges(cluster.owner, input(true))).rejects.toThrow(/mpj_pkey/);
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
    expect(await canExecute()).toBe(false);
  });
});
