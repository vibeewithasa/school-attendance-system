import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_HASH,
  addSession,
  addUser,
  asApi,
  bootstrap,
  createApiRole,
  grant,
  hashN,
  sessionReasons,
} from './helpers/auth-fixtures.js';
import { failure, freshDb } from './helpers/pglite.js';

/**
 * Pruebas de ESQUEMA de Auth/RBAC (migraciones 0003-0005) en PGlite = PostgreSQL 18.6 en memoria.
 * Cuentas y hashes ficticios. No tocan eta15_dev. No son pruebas de la API (aun no hay endpoints).
 * Privilegios, bootstrap y recuperacion: auth-privileges.test.ts y auth-recovery.test.ts.
 */

describe('users', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });
  const ins = (email: string, extra: Record<string, string> = {}) => {
    const cols = Object.keys(extra);
    return db.query(
      `insert into users (email, display_name, account_domain${cols.map((c) => ', ' + c).join('')})
       values ($1, 'X', 'school'${cols.map((c) => ', ' + extra[c]).join('')})`,
      [email],
    );
  };

  it('acepta una cuenta pendiente sin contrasena', async () => {
    await ins('ana@escuela.mx');
  });
  it('rechaza correos duplicados', async () => {
    expect((await failure(ins('ana@escuela.mx'))).code).toBe('23505');
  });
  it('rechaza correos no normalizados, mal formados o demasiado largos', async () => {
    for (const bad of [
      'Ana@Escuela.mx',
      ' ana2@escuela.mx',
      'ana3@escuela.mx ',
      'sin-arroba',
      'a@b',
      'a b@c.mx',
    ]) {
      expect((await failure(ins(bad))).code, bad).toBe('23514');
    }
    expect((await failure(ins('a'.repeat(250) + '@x.mx'))).code).toBe('23514');
  });
  it('rechaza estado o dominio invalidos y nombre vacio', async () => {
    expect((await failure(ins('e1@escuela.mx', { status: "'bloqueado'" }))).code).toBe('23514');
    expect((await failure(ins('e2@escuela.mx', { account_domain: "'otro'" }))).code).toBeDefined();
    expect(
      (
        await failure(
          db.query(
            `insert into users (email, display_name, account_domain) values ('e3@escuela.mx','  ','school')`,
          ),
        )
      ).code,
    ).toBe('23514');
  });
  it('una cuenta activa exige contrasena y un correo personal activo exige verificacion', async () => {
    expect((await failure(ins('e4@escuela.mx', { status: "'active'" }))).code).toBe('23514');
    const personal = (verified: string) =>
      db.query(
        `insert into users (email, email_kind, email_verified_at, display_name, account_domain, status, password_hash)
         values ('personal@gmail.com','personal', ${verified}, 'X','school','active','${FAKE_HASH}')`,
      );
    expect((await failure(personal('null'))).code).toBe('23514');
    await personal('now()');
  });
  it('account_domain es inmutable y updated_at cambia en un UPDATE real', async () => {
    expect(
      (
        await failure(
          db.query(`update users set account_domain='technical' where email='ana@escuela.mx'`),
        )
      ).message,
    ).toMatch(/account_domain es inmutable/);
    await db.query(`update users set updated_at='2000-01-01' where email='ana@escuela.mx'`);
    await db.query(`update users set display_name='Ana M.' where email='ana@escuela.mx'`);
    const r = await db.query<{ ok: boolean }>(
      `select updated_at > '2000-01-01' as ok from users where email='ana@escuela.mx'`,
    );
    expect(r.rows[0]!.ok).toBe(true);
  });
});

describe('roles, permisos y separacion de dominios', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });
  const addRolePerm = (
    roleKey: string,
    permKey: string,
    roleDomain?: string,
    permDomain?: string,
  ) =>
    db.query(
      `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
       select r.id, coalesce($3, r.domain), p.id, coalesce($4, p.domain), 'all' from roles r, permissions p
        where r.key=$1 and p.key=$2`,
      [roleKey, permKey, roleDomain ?? null, permDomain ?? null],
    );

  it('un rol tecnico no recibe un permiso escolar y viceversa', async () => {
    expect((await failure(addRolePerm('admin_tecnico', 'students:read'))).code).toBe('23514');
    expect((await failure(addRolePerm('prefectura', 'audit:read'))).code).toBe('23514');
  });
  it('declarar un dominio falso para saltarse la regla viola la FK compuesta', async () => {
    expect(
      (await failure(addRolePerm('admin_tecnico', 'students:read', undefined, 'technical'))).code,
    ).toBe('23503');
    expect(
      (await failure(addRolePerm('admin_tecnico', 'students:read', 'school', 'school'))).code,
    ).toBe('23503');
  });
  it('todos los permisos sembrados tienen dominio valido y los de autoridad estan marcados', async () => {
    const r = await db.query<{ key: string }>(
      `select key from permissions where is_authority order by key`,
    );
    expect(r.rows.map((x) => x.key)).toEqual([
      'roles:grant_school',
      'roles:grant_technical',
      'roles:manage_school',
      'roles:manage_technical',
      'users:manage_school',
      'users:manage_technical',
    ]);
    const bad = await db.query<{ n: number }>(
      `select count(*)::int n from permissions where domain not in ('school','technical','shared')`,
    );
    expect(bad.rows[0]!.n).toBe(0);
  });
  it('ninguna fila sembrada mezcla dominios (verificacion global en la base)', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from role_permissions where permission_domain <> 'shared' and permission_domain <> role_domain`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
  it('rechaza un scope invalido y valida la politica de sesion del rol', async () => {
    const f = await failure(
      db.query(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'todos' from roles r, permissions p where r.key='prefectura' and p.key='reports:read'`,
      ),
    );
    expect(f.code).toBe('23514');
    const insertRole = (key: string, idle: number, abs: number, max = 5) =>
      db.query(
        `insert into roles (key, name, domain, session_idle_minutes, session_absolute_minutes, max_concurrent_sessions) values ($1,'x','school',$2,$3,$4)`,
        [key, idle, abs, max],
      );
    expect((await failure(insertRole('r_idle_gt_abs', 100, 50))).code).toBe('23514');
    expect((await failure(insertRole('r_zero', 0, 50))).code).toBe('23514');
    expect((await failure(insertRole('Mala-Clave', 10, 50))).code).toBe('23514');
    expect((await failure(insertRole('r_max_0', 10, 50, 0))).code).toBe('23514');
  });
  it('se pueden crear roles nuevos como filas (los roles no son un conjunto cerrado)', async () => {
    await db.query(
      `insert into roles (key, name, domain) values ('orientacion', 'Orientacion', 'school')`,
    );
    await addRolePerm('orientacion', 'catalog:read');
  });
  it('clave y dominio de un rol son inmutables; un rol de sistema no se borra ni deja de serlo', async () => {
    expect(
      (await failure(db.query(`update roles set domain='technical' where key='orientacion'`)))
        .message,
    ).toMatch(/inmutables/);
    expect(
      (await failure(db.query(`update roles set key='otra' where key='orientacion'`))).message,
    ).toMatch(/inmutables/);
    expect((await failure(db.query(`delete from roles where key='prefectura'`))).message).toMatch(
      /sistema/,
    );
    expect(
      (await failure(db.query(`update roles set is_system=false where key='prefectura'`))).message,
    ).toMatch(/dejar de serlo/);
  });
  it('un permiso no cambia de clave, dominio ni de marca de autoridad', async () => {
    for (const set of ["domain='shared'", "key='otro:permiso'", 'is_authority=false']) {
      expect(
        (await failure(db.query(`update permissions set ${set} where key='roles:grant_school'`)))
          .message,
        set,
      ).toMatch(/inmutables/);
    }
  });
  it('los cambios de politica de MFA o de sesion de un rol quedan auditados', async () => {
    await db.query(`update roles set session_idle_minutes = 20 where key='orientacion'`);
    await db.query(`update roles set requires_mfa = true where key='orientacion'`);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type='role.updated' and details->>'role'='orientacion'`,
    );
    expect(r.rows[0]!.n).toBe(2);
    await db.query(`update roles set description = 'solo texto' where key='orientacion'`);
    const r2 = await db.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type='role.updated'`,
    );
    expect(r2.rows[0]!.n).toBe(2);
  });
});

describe('sesiones', () => {
  let db: PGlite;
  let u: string;
  beforeAll(async () => {
    db = await freshDb();
    u = await addUser(db, 's@escuela.mx', 'school');
  });
  afterAll(async () => {
    await db.close();
  });
  const insert = (n: number, cols: Record<string, string> = {}, hashSql = hashN(n)) => {
    const names = Object.keys(cols);
    return db.query(
      `insert into sessions (user_id, token_hash, created_at, expires_at, idle_expires_at${names.map((c) => ', ' + c).join('')})
       values ($1, ${hashSql}, now(), now() + interval '8 hours', now() + interval '1 hour'${names.map((c) => ', ' + cols[c]).join('')})`,
      [u],
    );
  };

  it('acepta una sesion valida y rechaza token_hash repetido', async () => {
    await insert(10);
    expect((await failure(insert(10))).code).toBe('23505');
  });
  it('el hash mide exactamente 32 bytes (la BD solo valida longitud; la app es quien hashea)', async () => {
    expect((await failure(insert(11, {}, `'\\x6162'::bytea`))).code).toBe('23514');
    expect((await failure(insert(12, {}, `decode(repeat('ab', 33), 'hex')`))).code).toBe('23514');
  });
  it('la inactividad no puede superar la caducidad absoluta', async () => {
    const f = await failure(
      db.query(
        `insert into sessions (user_id, token_hash, expires_at, idle_expires_at)
         values ($1, ${hashN(13)}, now() + interval '1 hour', now() + interval '2 hours')`,
        [u],
      ),
    );
    expect(f.code).toBe('23514');
  });
  it('revocacion y motivo van siempre juntos y el motivo es de la lista', async () => {
    expect((await failure(insert(14, { revoked_at: 'now()' }))).code).toBe('23514');
    expect((await failure(insert(15, { revoked_reason: "'logout'" }))).code).toBe('23514');
    expect(
      (await failure(insert(16, { revoked_at: 'now()', revoked_reason: "'porque_si'" }))).code,
    ).toBe('23514');
    await insert(17, { revoked_at: 'now()', revoked_reason: "'logout'" });
  });
  it('tipo de cliente y user_agent acotados', async () => {
    expect((await failure(insert(18, { client_type: "'desktop'" }))).code).toBe('23514');
    expect((await failure(insert(19, { user_agent: `'${'x'.repeat(300)}'` }))).code).toBe('23514');
  });
  it('solo las sesiones vigentes pasan el predicado de validez (expiradas y revocadas no)', async () => {
    const mk = (n: number, created: string, expires: string, idle: string, revoked = false) =>
      db.query(
        `insert into sessions (user_id, token_hash, created_at, last_seen_at, expires_at, idle_expires_at, revoked_at, revoked_reason)
         values ($1, ${hashN(n)}, now() - interval '${created}', now() - interval '${created}', now() + interval '${expires}', now() + interval '${idle}'
                 ${revoked ? ", now(), 'admin'" : ', null, null'})`,
        [u],
      );
    await mk(30, '3 hours', '-1 hour', '-2 hours'); // caducada (absoluta)
    await mk(31, '3 hours', '5 hours', '-30 minutes'); // caducada por inactividad
    await mk(32, '1 hour', '5 hours', '30 minutes', true); // revocada
    await mk(33, '1 hour', '5 hours', '30 minutes'); // vigente
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from sessions
        where user_id=$1 and token_hash in (${[30, 31, 32, 33].map(hashN).join(',')})
          and revoked_at is null and now() < least(expires_at, idle_expires_at)`,
      [u],
    );
    expect(r.rows[0]!.n).toBe(1);
  });
});

describe('sesiones: guardas de la base de datos', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('no se abre sesion para cuentas pendientes ni deshabilitadas', async () => {
    const pend = await addUser(db, 'pend@escuela.mx', 'school', 'pending');
    const dis = await addUser(db, 'dis@escuela.mx', 'school', 'disabled');
    expect((await failure(addSession(db, pend, 1))).message).toMatch(/Solo las cuentas activas/);
    expect((await failure(addSession(db, dis, 2))).message).toMatch(/Solo las cuentas activas/);
  });
  it('el tope de 5 sesiones concurrentes se aplica en la base: la mas antigua se revoca (concurrency)', async () => {
    const u = await addUser(db, 'cap@escuela.mx', 'school');
    for (let i = 0; i < 6; i++) await addSession(db, u, 100 + i, 60 - i * 10); // la 100 es la mas antigua
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
      [u],
    );
    expect(r.rows[0]!.n).toBe(5);
    const old = await db.query<{ reason: string | null }>(
      `select revoked_reason reason from sessions where user_id=$1 and token_hash=${hashN(100)}`,
      [u],
    );
    expect(old.rows[0]!.reason).toBe('concurrency');
  });
  it('el tope es configurable por rol y se aplica el menor entre los roles del usuario', async () => {
    const boss = await addUser(db, 'boss@escuela.mx', 'school');
    await bootstrap(db, boss, 'direccion');
    const u = await addUser(db, 'cap2@escuela.mx', 'school');
    await grant(db, u, 'prefectura', boss);
    await db.query(`update roles set max_concurrent_sessions = 2 where key = 'prefectura'`);
    for (let i = 0; i < 3; i++) await addSession(db, u, 200 + i, 30 - i * 10);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
      [u],
    );
    expect(r.rows[0]!.n).toBe(2);
  });
  it('cambiar la contrasena revoca todas las sesiones (password_changed)', async () => {
    const u = await addUser(db, 'pw@escuela.mx', 'school');
    await addSession(db, u, 300);
    await addSession(db, u, 301);
    await db.query(`update users set password_hash = 'otro-hash-ficticio' where id = $1`, [u]);
    expect(await sessionReasons(db, u)).toEqual(['password_changed', 'password_changed']);
  });
  it('deshabilitar la cuenta revoca todas las sesiones (disabled)', async () => {
    const u = await addUser(db, 'off@escuela.mx', 'school');
    await addSession(db, u, 310);
    await db.query(`update users set status = 'disabled' where id = $1`, [u]);
    expect(await sessionReasons(db, u)).toEqual(['disabled']);
  });
});

describe('audit_events: proteccion frente a la API y limites frente al propietario', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    await db.query(
      `insert into audit_events (event_type, outcome, details) values ('auth.login', 'failure', '{"motivo":"prueba"}')`,
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it('el rol de la API puede insertar y consultar', async () => {
    await asApi(db, () =>
      db.query(`insert into audit_events (event_type, outcome) values ('auth.logout', 'success')`),
    );
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type <> 'role.permissions_changed'`,
    );
    expect(r.rows[0]!.n).toBe(2);
  });
  it('el rol de la API (aun con todos los privilegios de tabla) no puede UPDATE, DELETE ni TRUNCATE', async () => {
    for (const sql of [
      `update audit_events set outcome='success'`,
      `delete from audit_events`,
      `truncate audit_events`,
    ]) {
      expect((await failure(asApi(db, () => db.query(sql)))).message, sql).toMatch(
        /solo insercion/,
      );
    }
  });
  it('el rol de la API no puede deshabilitar ni eliminar el trigger (no es propietario)', async () => {
    const f1 = await failure(
      asApi(db, () =>
        db.query(`alter table audit_events disable trigger audit_events_no_update_delete`),
      ),
    );
    const f2 = await failure(
      asApi(db, () => db.query(`drop trigger audit_events_no_update_delete on audit_events`)),
    );
    expect(f1.message).toMatch(/must be owner/i);
    expect(f2.message).toMatch(/must be owner/i);
  });
  it('LIMITE CONOCIDO: el propietario SI puede deshabilitar el trigger y alterar eventos; no hay inmutabilidad absoluta', async () => {
    await db.query(`alter table audit_events disable trigger audit_events_no_update_delete`);
    await db.query(`update audit_events set outcome = 'success' where event_type = 'auth.login'`); // el propietario lo logra
    await db.query(`alter table audit_events enable always trigger audit_events_no_update_delete`);
    expect((await failure(db.query(`delete from audit_events`))).message).toMatch(/solo insercion/);
  });
  it('valida tipo de evento, resultado, que details sea un objeto y que el actor exista', async () => {
    const ins = (type: string, outcome: string, details: string) =>
      db.query(`insert into audit_events (event_type, outcome, details) values ($1,$2,$3::jsonb)`, [
        type,
        outcome,
        details,
      ]);
    expect((await failure(ins('Login', 'success', '{}'))).code).toBe('23514');
    expect((await failure(ins('auth.login', 'quizas', '{}'))).code).toBe('23514');
    expect((await failure(ins('auth.login', 'success', '[1]'))).code).toBe('23514');
    const f = await failure(
      db.query(
        `insert into audit_events (event_type, outcome, actor_user_id) values ('auth.login','success','00000000-0000-7000-8000-000000000000')`,
      ),
    );
    expect(f.code).toBe('23503');
  });
});
