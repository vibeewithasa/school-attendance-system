import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTempPostgres, type TempPostgres } from '../helpers/pg-temp.js';

/**
 * Valida la PROPUESTA de separacion de roles (tools/db/proposals/eta15_api-roles.proposal.sql) en un cluster
 * PostgreSQL 18 DESECHABLE que reproduce la disposicion real: base `eta15_dev` propiedad de `eta15_app`,
 * objetos de `eta15_app`, API conectada como `eta15_api`. NO toca la instalacion real: la separacion de roles
 * NO esta implementada ni probada en eta15_dev. Ejecutar con:  pnpm test:pg-temp
 */

let pgt: TempPostgres;
let superuser: pg.Client; // "postgres" del cluster desechable
let owner: pg.Client; // eta15_app en eta15_dev
let api: pg.Client; // eta15_api en eta15_dev

const proposal = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'tools',
    'db',
    'proposals',
    'eta15_api-roles.proposal.sql',
  ),
  'utf8',
);
const step = (name: 'PASO 1' | 'PASO 2' | 'PASO 3') => {
  const body = proposal
    .split(/^-- ===== /m)
    .find((s) => s.startsWith(name))!
    .split('\n')
    .slice(1)
    .join('\n');
  // Sentencias separadas por ';' al final de linea (ninguna contiene ';' internos).
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\')) // sin comentarios ni metacomandos de psql
    .join('\n')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
};

const FAKE = 'hash-ficticio-de-prueba';
const hex = (n: number) => `decode(lpad(to_hex(${n}), 64, '0'), 'hex')`;
let seq = 0;

beforeAll(async () => {
  pgt = await startTempPostgres();
  superuser = await pgt.connect();
  await superuser.query(`create role eta15_app login`);
  await superuser.query(`create database eta15_dev owner eta15_app`);
  owner = await pgt.connect('eta15_app', 'eta15_dev');
  await applyMigrations(owner); // objetos propiedad de eta15_app, como en la instalacion real

  for (const stmt of step('PASO 1')) await superuser.query(stmt); // lo ejecuta un superusuario
  for (const stmt of step('PASO 2')) await owner.query(stmt); // lo ejecuta eta15_app
  // El rol nace SIN LOGIN: no puede conectarse hasta el paso 3 (aqui el cluster usa trust; la contrasena real la teclea una persona)
  await expect(pgt.connect('eta15_api', 'eta15_dev')).rejects.toThrow(/not permitted to log in/i);
  for (const stmt of step('PASO 3')) await superuser.query(stmt); // habilita LOGIN
  api = await pgt.connect('eta15_api', 'eta15_dev');
}, 240_000);
afterAll(async () => {
  await pgt?.stop();
}, 60_000);

const tryIt = async (c: pg.Client, sql: string, params: unknown[] = []) => c.query(sql, params);

describe('separacion de roles (propuesta) en cluster desechable', () => {
  it('eta15_api no es superusuario ni miembro de eta15_app y no puede asumir su rol', async () => {
    const r = await api.query<Record<string, unknown>>(
      `select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit,
              pg_has_role('eta15_api', 'eta15_app', 'MEMBER') as miembro, pg_has_role('eta15_api', 'eta15_app', 'USAGE') as usage
         from pg_roles where rolname = 'eta15_api'`,
    );
    expect(r.rows[0]).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolinherit: false,
      rolconnlimit: 30,
      miembro: false,
      usage: false,
    });
    await expect(tryIt(api, `set role eta15_app`)).rejects.toThrow(/permission denied to set role/);
    await expect(tryIt(api, `set session authorization eta15_app`)).rejects.toThrow(
      /permission denied/,
    );
    const own = await api.query<{ r: boolean }>(`select auth_is_schema_owner() as r`);
    expect(own.rows[0]!.r).toBe(false);
  });
  it('parametros de rol: timeouts y search_path', async () => {
    const r = await api.query<Record<string, string>>(
      `select current_setting('statement_timeout') st, current_setting('idle_in_transaction_session_timeout') it, current_setting('search_path') sp`,
    );
    expect(r.rows[0]).toEqual({ st: '15s', it: '30s', sp: 'public' });
  });
  it('no puede crear, alterar ni borrar objetos (sin CREATE, sin propiedad)', async () => {
    for (const sql of [
      `create table public.intruso (id int)`,
      `alter table users add column x int`,
      `drop table sessions`,
      `drop trigger audit_events_no_update_delete on audit_events`,
      `alter table audit_events disable trigger audit_events_no_update_delete`,
      `create function public.f() returns int language sql as 'select 1'`,
      `create or replace function auth_is_schema_owner() returns boolean language sql as 'select true'`,
      `alter function auth_lock_authority(uuid, text) owner to eta15_api`,
      `create schema intruso`,
    ]) {
      await expect(tryIt(api, sql), sql).rejects.toThrow(/permission denied|must be owner/i);
    }
  });
  it('sin TEMPORARY no puede crear funciones/tablas temporales ni adjuntar triggers propios', async () => {
    await expect(tryIt(api, `create temp table t (x int)`)).rejects.toThrow(
      /permission denied to create temporary tables/,
    );
    await expect(
      tryIt(
        api,
        `create function pg_temp.f() returns trigger language plpgsql as $$ begin return new; end $$`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      tryIt(
        api,
        `create trigger aaa before insert on user_roles for each row execute function auth_current_actor()`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it('matriz efectiva de privilegios de tabla (has_table_privilege)', async () => {
    const priv = async (table: string, p: string) =>
      (
        await api.query<{ r: boolean }>(`select has_table_privilege('eta15_api', $1, $2) as r`, [
          table,
          p,
        ])
      ).rows[0]!.r;
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
      expect(await priv(t, 'SELECT'), `${t} SELECT`).toBe(true);
      for (const bad of ['TRUNCATE', 'TRIGGER', 'REFERENCES'])
        expect(await priv(t, bad), `${t} ${bad}`).toBe(false);
    }
    expect(await priv('audit_events', 'INSERT')).toBe(true);
    expect(await priv('audit_events', 'UPDATE')).toBe(false);
    expect(await priv('audit_events', 'DELETE')).toBe(false);
    for (const t of ['users', 'user_roles', 'roles', 'permissions', 'school_years', 'groups']) {
      expect(await priv(t, 'DELETE'), `${t} DELETE`).toBe(false);
    }
    expect(await priv('roles', 'UPDATE')).toBe(false);
    expect(await priv('school_years', 'INSERT')).toBe(false); // el catalogo se abrira cuando existan sus endpoints
  });
  it('privilegios por columna: no puede tocar account_domain, created_by ni el id', async () => {
    const col = async (c: string) =>
      (
        await api.query<{ r: boolean }>(
          `select has_column_privilege('eta15_api', 'users', $1, 'UPDATE') as r`,
          [c],
        )
      ).rows[0]!.r;
    expect(await col('status')).toBe(true);
    expect(await col('password_hash')).toBe(true);
    for (const c of ['account_domain', 'created_by', 'id', 'created_at'])
      expect(await col(c), c).toBe(false);
  });
  it('funciones: solo los tres ayudantes son ejecutables por eta15_api; ninguna por PUBLIC', async () => {
    const r = await api.query<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and has_function_privilege('eta15_api', oid, 'EXECUTE') order by 1`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual([
      'auth_current_actor',
      'auth_is_schema_owner',
      'auth_lock_authority',
    ]);
    const open = await api.query(
      `select p.proname from pg_proc p where p.pronamespace='public'::regnamespace
        and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
    );
    expect(open.rows).toEqual([]);
  });
  it('las funciones futuras de eta15_app nacen sin EXECUTE para PUBLIC (privilegios por defecto)', async () => {
    await owner.query(
      `create function public.futura() returns int language sql set search_path = pg_catalog, pg_temp as 'select 1'`,
    );
    const r = await api.query<{ n: number }>(
      `select count(*)::int n from pg_proc p where p.proname='futura' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
    );
    expect(r.rows[0]!.n).toBe(0);
    await owner.query(`drop function public.futura()`);
  });
  it('otro rol cualquiera no puede ni conectarse a eta15_dev (CONNECT revocado a PUBLIC)', async () => {
    await superuser.query(`create role curioso login`);
    await expect(pgt.connect('curioso', 'eta15_dev')).rejects.toThrow(
      /permission denied for database|no CONNECT privilege/i,
    );
  });
});

describe('la API sigue pudiendo operar con los privilegios minimos (nada del flujo depende de privilegios extra)', () => {
  let tecnico: string;
  let direccion: string;
  const addOwner = async (domain: 'school' | 'technical', status = 'active') =>
    (
      await owner.query<{ id: string }>(
        `insert into users (email, display_name, account_domain, status, password_hash) values ($1,'Persona de prueba',$2,$3,$4) returning id`,
        [`api-${domain}-${++seq}@escuela.mx`, domain, status, status === 'pending' ? null : FAKE],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    tecnico = await addOwner('technical');
    direccion = await addOwner('school');
    // Bootstrap: solo el propietario (eta15_app), nunca eta15_api
    for (const [u, role] of [
      [tecnico, 'admin_tecnico'],
      [direccion, 'direccion'],
    ] as const) {
      await owner.query(
        `insert into user_roles (user_id, role_id, domain, grant_source, grant_reference)
         select $1, id, domain, 'bootstrap', 'ACTA-PRUEBA' from roles where key=$2`,
        [u, role],
      );
    }
  });

  it('bootstrap/recovery y permisos de autoridad: eta15_api NO; eta15_app SI', async () => {
    const u = await addOwner('school');
    await expect(
      api.query(
        `insert into user_roles (user_id, role_id, domain, grant_source, grant_reference) select $1, id, domain, 'recovery', 'ACTA-X' from roles where key='direccion'`,
        [u],
      ),
    ).rejects.toThrow(/Solo el propietario del esquema/);
    // role_permissions es de solo lectura para la API: se deniega por privilegio (SQLSTATE 42501), no por el trigger
    await expect(
      api.query(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key='prefectura' and p.key='roles:grant_school'`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(api.query(`delete from role_permissions where false`)).rejects.toMatchObject({
      code: '42501',
    });
    // y el propietario (eta15_app) SI sigue pudiendo editar permisos (el trigger sigue aplicando las reglas de dominio)
    await expect(
      owner.query(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key='prefectura' and p.key='roles:grant_school'`,
      ),
    ).resolves.toBeDefined();
    await owner.query(
      `delete from role_permissions where role_id = (select id from roles where key='prefectura') and permission_id = (select id from permissions where key='roles:grant_school')`,
    );
  });
  it('crea una cuenta pendiente, concede un rol, abre y revoca sesiones y audita', async () => {
    await api.query(`select set_config('eta15.actor_id', $1, false)`, [direccion]);
    const email = `nueva-${++seq}@escuela.mx`;
    await api.query(
      `insert into users (email, display_name, account_domain, created_by) values ($1,'Nueva','school',$2)`,
      [email, direccion],
    );
    const u = (await api.query<{ id: string }>(`select id from users where email=$1`, [email]))
      .rows[0]!.id;
    await api.query(
      `insert into user_roles (user_id, role_id, domain, granted_by) select $1, id, domain, $2 from roles where key='prefectura'`,
      [u, direccion],
    );
    // La cuenta se activa por el flujo de reclamo (token autorizado por Direccion, consumido en la misma transaccion)
    await api.query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,'invite',${hex(9001)}, now() + interval '30 minutes')`,
      [u],
    );
    await api.query(
      `update auth_tokens set authorized_at=now(), authorized_by=$1, verification_method='in_person_id' where token_hash=${hex(9001)}`,
      [direccion],
    );
    await api.query('begin');
    await api.query(`update auth_tokens set used_at = now() where token_hash=${hex(9001)}`);
    await api.query(`update users set status='active', password_hash=$2 where id=$1`, [u, FAKE]);
    await api.query('commit');
    for (let i = 0; i < 6; i++) {
      await api.query(
        `insert into sessions (user_id, token_hash, expires_at, idle_expires_at) values ($1, ${hex(9100 + i)}, now() + interval '8 hours', now() + interval '1 hour')`,
        [u],
      );
    }
    const active = await api.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
      [u],
    );
    expect(active.rows[0]!.n).toBe(5);
    await api.query(`update users set password_hash='otro-hash-ficticio' where id=$1`, [u]);
    const after = await api.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
      [u],
    );
    expect(after.rows[0]!.n).toBe(0);
    const audit = await api.query<{ n: number }>(
      `select count(*)::int n from audit_events where subject_user_id=$1 and event_type='role.granted'`,
      [u],
    );
    expect(audit.rows[0]!.n).toBe(1);
  });
  it('no puede alterar la auditoria, borrar usuarios ni borrar el historial de roles', async () => {
    for (const sql of [
      `update audit_events set outcome='success'`,
      `delete from audit_events`,
      `delete from users`,
      `delete from user_roles`,
      `truncate user_roles`,
    ]) {
      await expect(tryIt(api, sql), sql).rejects.toThrow(
        /permission denied|solo insercion|no se elimina/,
      );
    }
  });
  it('un administrador tecnico (cuenta de la API) sigue sin poder conceder acceso escolar', async () => {
    const u = await addOwner('school');
    await expect(
      api.query(
        `insert into user_roles (user_id, role_id, domain, granted_by) select $1, id, domain, $2 from roles where key='prefectura'`,
        [u, tecnico],
      ),
    ).rejects.toThrow(/roles:grant_school/);
  });
});

describe('tools/db/privileges/0001-role-permissions-select-only.sql', () => {
  const file = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'tools',
      'db',
      'privileges',
      '0001-role-permissions-select-only.sql',
    ),
    'utf8',
  );
  const writes = async () =>
    (
      await owner.query<{ p: string }>(
        `select p from unnest(array['INSERT','UPDATE','DELETE']) p where has_table_privilege('eta15_api','role_permissions',p) order by 1`,
      )
    ).rows.map((r) => r.p);

  it('retira INSERT/DELETE a una instalacion antigua, es idempotente y no toca otras tablas', async () => {
    await owner.query(`grant insert, delete on role_permissions to eta15_api`);
    expect(await writes()).toEqual(['DELETE', 'INSERT']);
    const matrix = () =>
      owner.query(
        `select c.relname, p, has_table_privilege('eta15_api', c.oid, p) as v from pg_class c cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
          where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'role_permissions' order by 1, 2`,
      );
    const before = (await matrix()).rows;
    await owner.query(file);
    expect(await writes()).toEqual([]);
    expect((await matrix()).rows).toEqual(before);
    await owner.query(file); // segunda ejecucion: sin efecto ni error
    expect(await writes()).toEqual([]);
    expect(await api.query(`select count(*)::int n from role_permissions`)).toBeDefined(); // SELECT intacto
  });

  it('falla sin dejar nada aplicado si lo ejecuta quien no es propietario', async () => {
    await expect(api.query(file)).rejects.toThrow(/./);
  });
});
