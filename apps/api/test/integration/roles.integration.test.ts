import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '../../src/config/env.js';
import {
  IDENTITY_SQL,
  ownerIdentityProblems,
  runtimeIdentityProblems,
  type IdentityRow,
} from '../../src/db/identity.js';
import { readEnvFile } from '../../scripts/db-identity.js';

/**
 * Separacion de roles en la instalacion REAL (eta15_dev): comprueba la identidad y los privilegios EFECTIVOS de
 * eta15_api (rol de ejecucion) frente a eta15_app (propietario/migrador). Requiere apps/api/.env (eta15_api) y
 * apps/api/.env.migrator (eta15_app); si faltan, FALLA. Ejecutar con:  pnpm test:integration
 *
 * Seguridad de la propia prueba: ningun DDL potencialmente destructivo se EJECUTA sobre objetos existentes.
 *  - Lo destructivo (DROP/ALTER/TRUNCATE/DELETE masivo) se verifica con funciones de privilegio y propiedad.
 *  - Lo que se ejecuta es no destructivo, esta denegado (o va en una transaccion con ROLLBACK):
 *    CREATE de objetos nuevos, UPDATE/DELETE ... WHERE false, INSERT revertido.
 */

const env = loadEnv();
const migratorEnv = readEnvFile('.env.migrator');
let api: pg.Client;
let owner: pg.Client;

const connect = async (e: {
  DB_HOST?: string;
  DB_PORT?: number | string;
  DB_NAME?: string;
  DB_USER?: string;
  DB_PASSWORD?: string;
}) => {
  const c = new pg.Client({
    host: e.DB_HOST ?? '127.0.0.1',
    port: Number(e.DB_PORT ?? 5432),
    database: e.DB_NAME ?? 'eta15_dev',
    user: e.DB_USER,
    password: e.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  return c;
};
/** Ejecuta `fn` dentro de una transaccion que SIEMPRE se revierte. */
async function rolledBack<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    return await fn();
  } finally {
    await c.query('rollback').catch(() => undefined);
  }
}
/**
 * Ejecuta `sql` esperando una DENEGACION (SQLSTATE 42501, independiente del idioma del servidor) dentro de una
 * transaccion revertida. Devuelve el mensaje (solo se compara el de nuestros propios triggers, que es estable).
 */
const denied = async (c: pg.Client, sql: string) => {
  await c.query('begin');
  try {
    await c.query(sql);
  } catch (e) {
    await c.query('rollback');
    const err = e as Error & { code?: string };
    if (err.code !== '42501')
      throw new Error(`se esperaba SQLSTATE 42501 y fue ${err.code}: ${sql}`, { cause: e });
    return err.message;
  }
  await c.query('rollback');
  throw new Error(`SE ESPERABA UNA DENEGACION y la sentencia tuvo exito: ${sql}`);
};

beforeAll(async () => {
  if (!env.DB_PASSWORD)
    throw new Error(
      'Falta DB_PASSWORD de eta15_api en apps/api/.env (tools\\set-db-password.ps1).',
    );
  if (!migratorEnv?.DB_PASSWORD)
    throw new Error(
      'Falta apps/api/.env.migrator con DB_PASSWORD de eta15_app (tools\\set-db-password.ps1 -Target migrator).',
    );
  api = await connect(env);
  owner = await connect(migratorEnv);
});
afterAll(async () => {
  await Promise.allSettled([api?.end(), owner?.end()]);
});

describe('identidades', () => {
  it('la API conecta como eta15_api y NO como el migrador', async () => {
    const row = (await api.query<IdentityRow>(IDENTITY_SQL)).rows[0]!;
    expect(row.usuario).toBe('eta15_api');
    expect(runtimeIdentityProblems(row)).toEqual([]);
    expect(env.DB_USER).not.toBe(migratorEnv!.DB_USER);
  });
  it('el migrador conecta como eta15_app, propietario de la base', async () => {
    const row = (await owner.query<IdentityRow>(IDENTITY_SQL)).rows[0]!;
    expect(row.usuario).toBe('eta15_app');
    expect(ownerIdentityProblems(row)).toEqual([]);
  });
  it('auth_is_schema_owner(): falso para la API, verdadero para el migrador', async () => {
    expect((await api.query<{ r: boolean }>(`select auth_is_schema_owner() as r`)).rows[0]!.r).toBe(
      false,
    );
    expect(
      (await owner.query<{ r: boolean }>(`select auth_is_schema_owner() as r`)).rows[0]!.r,
    ).toBe(true);
  });
  it('eta15_api: atributos minimos, sin membresias y sin poder asumir otro rol', async () => {
    const r = await owner.query<Record<string, unknown>>(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit,
              pg_has_role('eta15_api','eta15_app','MEMBER') as miembro_de_owner,
              (select count(*)::int from pg_auth_members where member = r.oid) as membresias_de_api,
              (select count(*)::int from pg_auth_members where roleid = r.oid) as miembros_de_api
         from pg_roles r where rolname = 'eta15_api'`,
    );
    expect(r.rows[0]).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolinherit: false,
      rolconnlimit: 30,
      miembro_de_owner: false,
      membresias_de_api: 0,
      miembros_de_api: 0,
    });
  });
});

describe('comprobaciones POSITIVAS como eta15_api', () => {
  it('SELECT 1 y lectura de todas las tablas', async () => {
    expect((await api.query(`select 1 as uno`)).rows[0]).toEqual({ uno: 1 });
    for (const t of [
      'users',
      'roles',
      'permissions',
      'role_permissions',
      'user_roles',
      'sessions',
      'auth_tokens',
      'audit_events',
      'school_years',
      'groups',
    ]) {
      await expect(api.query(`select count(*) from public.${t}`), t).resolves.toBeDefined();
    }
  });
  it('lee la semilla de roles y permisos', async () => {
    const r = await api.query<{ roles: number; permisos: number }>(
      `select (select count(*)::int from roles) as roles, (select count(*)::int from permissions) as permisos`,
    );
    expect(r.rows[0]).toEqual({ roles: 5, permisos: 27 }); // 26 de 0004 + catalog:manage_school (0006)
  });
  it('puede ejecutar los tres ayudantes autorizados', async () => {
    const r = await api.query<Record<string, unknown>>(
      `select auth_is_schema_owner() as dueno, auth_lock_authority('00000000-0000-7000-8000-000000000000','roles:grant_school') as autoridad, auth_current_actor() as actor`,
    );
    expect(r.rows[0]).toEqual({ dueno: false, autoridad: false, actor: null });
  });
  it('INSERT permitido (auditoria) y lectura de permisos por rol; todo revertido', async () => {
    // 0006 dejo 6 eventos role.permissions_changed en eta15_dev: se compara contra esa linea base
    const baseline = (await owner.query<{ n: number }>(`select count(*)::int n from audit_events`))
      .rows[0]!.n;
    await rolledBack(api, async () => {
      await api.query(
        `insert into audit_events (event_type, outcome, details) values ('auth.prueba', 'success', '{"nota":"prueba de integracion"}')`,
      );
      const n = await api.query<{ n: number }>(`select count(*)::int n from audit_events`);
      expect(n.rows[0]!.n).toBe(baseline + 1);
      const grants = await api.query<{ n: number }>(
        `select count(*)::int n from user_roles ur join role_permissions rp on rp.role_id = ur.role_id`,
      );
      expect(grants.rows[0]!.n).toBe(0); // la consulta de permisos del servicio de sesiones es ejecutable
    });
    const after = await owner.query<{ n: number }>(`select count(*)::int n from audit_events`);
    expect(after.rows[0]!.n).toBe(baseline); // nada persistio
  });
  it('UPDATE sobre columnas autorizadas (users, user_roles, sessions, auth_tokens): permitido', async () => {
    await rolledBack(api, async () => {
      await api.query(`update users set display_name = display_name where false`);
      await api.query(
        `update users set status = status, password_hash = password_hash where false`,
      );
      await api.query(
        `update user_roles set revoked_at = revoked_at, revoked_by = revoked_by where false`,
      );
      await api.query(
        `update sessions set last_seen_at = now(), revoked_reason = revoked_reason where false`,
      );
      await api.query(
        `update auth_tokens set used_at = used_at, invalidated_at = invalidated_at where false`,
      );
    });
  });
});

describe('comprobaciones NEGATIVAS como eta15_api (operaciones efectivas)', () => {
  it('no puede crear tablas, funciones, esquemas ni objetos temporales', async () => {
    expect(await denied(api, `create table public.intruso_x (id int)`)).toMatch(/./);
    expect(
      await denied(
        api,
        `create function public.intruso_f() returns int language sql as 'select 1'`,
      ),
    ).toBeTruthy();
    expect(await denied(api, `create schema intruso_s`)).toBeTruthy();
    expect(await denied(api, `create temp table intruso_t (id int)`)).toMatch(/./);
  });
  it('no puede asumir el rol del propietario', async () => {
    expect(await denied(api, `set role eta15_app`)).toBeTruthy();
    expect(await denied(api, `set session authorization eta15_app`)).toBeTruthy();
  });
  it('no puede crear triggers (sin privilegio TRIGGER)', async () => {
    expect(
      await denied(
        api,
        `create trigger intruso before insert on user_roles for each row execute function auth_current_actor()`,
      ),
    ).toBeTruthy();
  });
  it('no puede ejecutar funciones privilegiadas ni de trigger', async () => {
    for (const call of [
      `select user_roles_enforce_grant()`,
      `select set_updated_at()`,
      `select audit_events_immutable()`,
      `select roles_guard()`,
    ]) {
      expect(await denied(api, call), call).toBeTruthy();
    }
  });
  it('no puede alterar la auditoria (UPDATE/DELETE sin filas: la denegacion es de privilegio)', async () => {
    expect(await denied(api, `update audit_events set outcome = 'failure' where false`)).toMatch(
      /./,
    );
    expect(await denied(api, `delete from audit_events where false`)).toMatch(/./);
  });
  it('no puede borrar usuarios ni el historial de roles, ni modificar roles y permisos', async () => {
    for (const sql of [
      `delete from users where false`,
      `delete from user_roles where false`,
      `update roles set requires_mfa = false where false`,
      `update permissions set domain = domain where false`,
      `insert into roles (key, name, domain) select 'x','x','school' where false`,
    ]) {
      expect(await denied(api, sql), sql).toBeTruthy();
    }
  });
  it('no puede modificar columnas restringidas de users', async () => {
    for (const col of ['account_domain', 'created_by', 'id']) {
      expect(await denied(api, `update users set ${col} = ${col} where false`), col).toMatch(/./);
    }
  });
  it('no puede ver ni modificar el historial de Drizzle', async () => {
    expect(await denied(api, `select * from drizzle.__drizzle_migrations`)).toMatch(/./);
    expect(
      await denied(api, `update drizzle.__drizzle_migrations set hash = hash where false`),
    ).toBeTruthy();
  });
  it('role_permissions es de SOLO LECTURA: INSERT, UPDATE y DELETE denegados por privilegio (SQLSTATE 42501), tambien para permisos de autoridad', async () => {
    // `denied` exige SQLSTATE 42501: se deniega ANTES de llegar al trigger, sin depender del idioma del servidor.
    for (const key of ['roles:grant_school', 'students:read']) {
      await denied(
        api,
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key='prefectura' and p.key='${key}'`,
      );
    }
    await denied(api, `delete from role_permissions where false`);
    await denied(
      api,
      `delete from role_permissions where permission_id = (select id from permissions where key='roles:grant_school')`,
    );
    await denied(api, `update role_permissions set scope = scope where false`);
  });
});

describe('privilegios EFECTIVOS (catalogo, sin ejecutar DDL destructivo)', () => {
  const priv = async (table: string, p: string) =>
    (
      await owner.query<{ r: boolean }>(`select has_table_privilege('eta15_api', $1, $2) as r`, [
        `public.${table}`,
        p,
      ])
    ).rows[0]!.r;
  const anyColumn = async (table: string, p: 'INSERT' | 'UPDATE') =>
    (
      await owner.query<{ r: boolean }>(
        `select has_any_column_privilege('eta15_api', $1, $2) as r`,
        [`public.${table}`, p],
      )
    ).rows[0]!.r;
  const colUpdate = async (table: string) =>
    (
      await owner.query<{ r: boolean }>(
        `select has_any_column_privilege('eta15_api', $1, 'UPDATE') as r`,
        [`public.${table}`],
      )
    ).rows[0]!.r;

  // [SELECT, INSERT, UPDATE en alguna columna, DELETE]
  const matrix: Record<string, [boolean, boolean, boolean, boolean]> = {
    users: [true, true, true, false],
    roles: [true, false, false, false],
    permissions: [true, false, false, false],
    role_permissions: [true, false, false, false], // solo lectura (tools/db/privileges/0001)
    user_roles: [true, true, true, false],
    sessions: [true, true, true, true],
    auth_tokens: [true, true, true, true],
    audit_events: [true, true, false, false],
    // escritura del catalogo: SOLO por columna (0002 aplicada el 2026-10-26; ver el test de columnas exactas)
    school_years: [true, true, true, false],
    groups: [true, true, true, false],
  };
  it('matriz exacta de SELECT/INSERT/UPDATE/DELETE por tabla', async () => {
    for (const [table, [s, i, u, d]] of Object.entries(matrix)) {
      expect(await priv(table, 'SELECT'), `${table} SELECT`).toBe(s);
      expect(await anyColumn(table, 'INSERT'), `${table} INSERT(col)`).toBe(i);
      expect(await colUpdate(table), `${table} UPDATE(col)`).toBe(u);
      expect(await priv(table, 'DELETE'), `${table} DELETE`).toBe(d);
    }
  });
  it('catalogo: INSERT y UPDATE por las columnas aprobadas, sin privilegio de tabla ni GRANT OPTION (0002)', async () => {
    for (const table of ['school_years', 'groups']) {
      expect(await priv(table, 'INSERT'), `${table} INSERT de tabla`).toBe(false);
      expect(await priv(table, 'UPDATE'), `${table} UPDATE de tabla`).toBe(false);
    }
    const r = await owner.query<{ t: string; p: string; cols: string }>(
      `select table_name t, privilege_type p, string_agg(column_name, ',' order by column_name) cols
         from information_schema.column_privileges
        where grantee = 'eta15_api' and table_name in ('school_years','groups') and privilege_type in ('INSERT','UPDATE') and is_grantable = 'NO'
        group by 1, 2 order by 1, 2`,
    );
    expect(r.rows).toEqual([
      { t: 'groups', p: 'INSERT', cols: 'code,expected_entry_time,grade,school_year_id,shift' },
      { t: 'groups', p: 'UPDATE', cols: 'code,expected_entry_time,is_active,shift' },
      { t: 'school_years', p: 'INSERT', cols: 'ends_on,name,starts_on' },
      { t: 'school_years', p: 'UPDATE', cols: 'ends_on,is_active,name,starts_on' },
    ]);
  });
  it('nunca TRUNCATE, TRIGGER ni REFERENCES en ninguna tabla', async () => {
    for (const table of Object.keys(matrix)) {
      for (const p of ['TRUNCATE', 'TRIGGER', 'REFERENCES'])
        expect(await priv(table, p), `${table} ${p}`).toBe(false);
    }
  });
  it('no es propietaria ni miembro del propietario de ninguna tabla ni funcion (no puede ALTER/DROP)', async () => {
    const r = await owner.query<{ objeto: string }>(
      `select c.relname as objeto from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','i')
          and pg_has_role('eta15_api', c.relowner, 'USAGE')
       union all
       select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and pg_has_role('eta15_api', p.proowner, 'USAGE')`,
    );
    expect(r.rows).toEqual([]);
  });
  it('EXECUTE: solo los tres ayudantes; ninguna funcion es ejecutable por PUBLIC', async () => {
    const mine = await owner.query<{ proname: string }>(
      `select proname from pg_proc where pronamespace='public'::regnamespace and has_function_privilege('eta15_api', oid, 'EXECUTE') order by 1`,
    );
    expect(mine.rows.map((x) => x.proname)).toEqual([
      'auth_current_actor',
      'auth_is_schema_owner',
      'auth_lock_authority',
    ]);
    const open = await owner.query(
      `select p.proname from pg_proc p where p.pronamespace='public'::regnamespace
        and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
    );
    expect(open.rows).toEqual([]);
  });
  it('base: PUBLIC sin CONNECT/TEMPORARY/CREATE en eta15_dev; eta15_api con CONNECT, sin CREATE ni TEMPORARY', async () => {
    const r = await owner.query<Record<string, boolean>>(
      `select has_database_privilege('eta15_api','eta15_dev','CONNECT') as connect,
              has_database_privilege('eta15_api','eta15_dev','CREATE') as crea,
              has_database_privilege('eta15_api','eta15_dev','TEMPORARY') as temp,
              exists (select 1 from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                       where d.datname='eta15_dev' and a.grantee = 0) as public_con_privilegios`,
    );
    expect(r.rows[0]).toEqual({
      connect: true,
      crea: false,
      temp: false,
      public_con_privilegios: false,
    });
  });
  it('esquemas: USAGE en public sin CREATE; sin acceso al esquema drizzle', async () => {
    const r = await owner.query<Record<string, boolean>>(
      `select has_schema_privilege('eta15_api','public','USAGE') as uso_public, has_schema_privilege('eta15_api','public','CREATE') as crea_public,
              has_schema_privilege('eta15_api','drizzle','USAGE') as uso_drizzle`,
    );
    expect(r.rows[0]).toEqual({ uso_public: true, crea_public: false, uso_drizzle: false });
  });
  it('privilegios por defecto: las funciones futuras de eta15_app no nacen ejecutables por PUBLIC', async () => {
    const r = await owner.query<{ acl: string }>(
      `select defaclacl::text as acl from pg_default_acl where defaclobjtype = 'f' and pg_get_userbyid(defaclrole) = 'eta15_app'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.acl).not.toMatch(/(^|[{,])=X\//); // sin entrada de PUBLIC con EXECUTE
  });
  it('RESIDUAL CONOCIDO: PUBLIC conserva CONNECT en beauty_pos y postgres, asi que eta15_api puede conectarse (no hay aislamiento total)', async () => {
    const r = await owner.query<Record<string, boolean>>(
      `select has_database_privilege('eta15_api','beauty_pos','CONNECT') as beauty_pos, has_database_privilege('eta15_api','postgres','CONNECT') as postgres`,
    );
    expect(r.rows[0]).toEqual({ beauty_pos: true, postgres: true });
  });
});
