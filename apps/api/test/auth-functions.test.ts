import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, asApi, bootstrap, createApiRole } from './helpers/auth-fixtures.js';
import { failure, freshDb } from './helpers/pglite.js';

/**
 * Revision de las funciones SQL de las migraciones (0001, 0003-0005) en PGlite = PostgreSQL 18.6:
 * SECURITY DEFINER/INVOKER, search_path, EXECUTE de PUBLIC y uso indebido por roles sin privilegios.
 */

const EXPECTED_FUNCTIONS = [
  'att_days_guard_insert',
  'att_days_guard_update',
  'att_records_guard_insert',
  'att_records_guard_update',
  'attendance_events_no_update',
  'attendance_no_delete',
  'audit_events_immutable',
  'auth_current_actor',
  'auth_is_schema_owner',
  'auth_lock_authority',
  'auth_tokens_guard_insert',
  'auth_tokens_guard_update',
  'enrollments_guard_insert',
  'enrollments_guard_update',
  'permissions_guard',
  'pga_guard_insert',
  'pga_guard_update',
  'prefect_assignments_no_delete',
  'role_permissions_audit',
  'role_permissions_guard',
  'roles_audit_update',
  'roles_guard',
  'school_records_no_delete',
  'school_years_guard_attendance_dates',
  'school_years_guard_dates',
  'school_years_guard_prefect_dates',
  'sessions_before_insert',
  'set_updated_at',
  'sga_guard_insert',
  'sga_guard_update',
  'students_guard_update',
  'user_roles_audit_and_revoke',
  'user_roles_enforce_grant',
  'user_roles_guard_update',
  'user_roles_no_delete',
  'users_enforce_creator',
  'users_guard_update',
  'users_revoke_sessions',
];

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await createApiRole(db);
});
afterAll(async () => {
  await db.close();
});

describe('inventario de funciones', () => {
  it('son exactamente las esperadas (cualquier funcion nueva debe revisarse y declararse aqui)', async () => {
    const r = await db.query<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual(EXPECTED_FUNCTIONS);
  });
  it('ninguna es SECURITY DEFINER y todas fijan search_path = pg_catalog, pg_temp', async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace`,
    );
    for (const f of r.rows) {
      expect(f.prosecdef, `${f.proname} DEFINER`).toBe(false);
      expect(f.proconfig, `${f.proname} search_path`).toContain('search_path=pg_catalog, pg_temp');
    }
  });
  it('NINGUNA funcion es ejecutable por PUBLIC (ni siquiera las de trigger ya existentes en 0001)', async () => {
    const r = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe('uso directo por roles no autorizados', () => {
  beforeAll(async () => {
    await db.exec(`create role intruso nologin`);
    await db.exec(`grant usage on schema public to intruso`);
    await db.exec(`grant select on all tables in schema public to intruso`); // peor caso razonable: solo lectura
  });
  const asIntruso = async <T>(fn: () => Promise<T>) => {
    await db.exec(`set role intruso`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
    }
  };

  it('no tiene EXECUTE sobre ninguna funcion del esquema', async () => {
    const r = await db.query<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and has_function_privilege('intruso', oid, 'EXECUTE')`,
    );
    expect(r.rows).toEqual([]);
  });
  it('no puede invocar los ayudantes ni las funciones de trigger', async () => {
    for (const call of [
      `select auth_is_schema_owner()`,
      `select auth_current_actor()`,
      `select auth_lock_authority('00000000-0000-7000-8000-000000000000', 'roles:grant_school')`,
      `select user_roles_enforce_grant()`,
    ]) {
      const f = await failure(asIntruso(() => db.query(call)));
      expect(f.message, call).toMatch(/permission denied for function/);
    }
  });
  it('con EXECUTE (rol de la API) tampoco puede invocar una funcion de trigger como funcion normal', async () => {
    const f = await failure(asApi(db, () => db.query(`select user_roles_enforce_grant()`)));
    expect(f.message).toMatch(
      /permission denied for function|trigger functions can only be called as triggers/,
    );
  });
  it('un helper invocado directamente por la API no revela ni concede nada nuevo (solo informa de su propio estado)', async () => {
    const boss = await addUser(db, 'boss@escuela.mx', 'school');
    await bootstrap(db, boss, 'direccion');
    const owner = await asApi(db, () =>
      db.query<{ r: boolean }>(`select auth_is_schema_owner() as r`),
    );
    expect(owner.rows[0]!.r).toBe(false); // la API simulada no es propietaria
    const lock = await asApi(db, () =>
      db.query<{ r: boolean }>(`select auth_lock_authority($1, 'roles:grant_school') as r`, [boss]),
    );
    expect(lock.rows[0]!.r).toBe(true); // informa que el titular tiene autoridad: no la modifica ni la transfiere
  });
});

describe('triggers: no se pueden usar para saltarse la politica', () => {
  it('sin EXECUTE de los ayudantes, la API ni siquiera puede operar (la dependencia del rol futuro queda explicita)', async () => {
    await db.exec(`create role api_sin_execute nologin`);
    await db.exec(`grant usage on schema public to api_sin_execute`);
    await db.exec(`grant select, insert, update on all tables in schema public to api_sin_execute`);
    await db.exec(`set role api_sin_execute`);
    try {
      const f = await failure(
        db.query(
          `insert into users (email, display_name, account_domain, created_by) values ('z@escuela.mx','Z','school',null)`,
        ),
      );
      expect(f.message).toMatch(/permission denied for function auth_is_schema_owner/);
    } finally {
      await db.exec(`reset role`);
    }
  });
  it('con los privilegios propuestos para la API (sin TRIGGER) no se puede adjuntar un trigger propio a las tablas', async () => {
    const f = await failure(
      asApi(db, async () => {
        await db.exec(
          `create function pg_temp.malicioso() returns trigger language plpgsql as $$ begin return new; end $$`,
        );
        await db.exec(
          `create trigger aaa_malicioso before insert on user_roles for each row execute function pg_temp.malicioso()`,
        );
      }),
    );
    expect(f.message).toMatch(/permission denied for table user_roles/);
    await db.exec(`drop function if exists pg_temp.malicioso()`);
    const t = await db.query<{ n: number }>(
      `select count(*)::int n from pg_trigger where tgname = 'aaa_malicioso'`,
    );
    expect(t.rows[0]!.n).toBe(0);
  });
  it('no puede crear funciones permanentes en el esquema (no tiene CREATE)', async () => {
    const f = await failure(
      asApi(db, () =>
        db.query(
          `create function public.malicioso() returns trigger language plpgsql as $$ begin return new; end $$`,
        ),
      ),
    );
    expect(f.message).toMatch(/permission denied for schema public/);
  });
  it('la API no puede cambiar la propiedad ni los privilegios de las funciones', async () => {
    for (const sql of [
      `alter function auth_lock_authority(uuid, text) owner to api_runtime`,
      `grant execute on function user_roles_enforce_grant() to public`,
      `create or replace function auth_is_schema_owner() returns boolean language sql as 'select true'`,
    ]) {
      const f = await failure(asApi(db, () => db.query(sql)));
      expect(f.message, sql).toMatch(/must be owner|permission denied/i);
    }
  });
});

describe('invariantes del estado inicial (la semilla 0004 cumple las restricciones definitivas de 0005)', () => {
  it('los permisos de autoridad solo estan en direccion (escolares) y admin_tecnico (tecnicos)', async () => {
    const r = await db.query<{ role: string; perm: string }>(
      `select r.key role, p.key perm from role_permissions rp join roles r on r.id=rp.role_id join permissions p on p.id=rp.permission_id
        where p.is_authority order by 1, 2`,
    );
    const byRole = new Map<string, string[]>();
    for (const x of r.rows) byRole.set(x.role, [...(byRole.get(x.role) ?? []), x.perm]);
    expect([...byRole.keys()].sort()).toEqual(['admin_tecnico', 'direccion']);
    expect(byRole.get('direccion')).toEqual([
      'roles:grant_school',
      'roles:manage_school',
      'users:manage_school',
    ]);
    expect(byRole.get('admin_tecnico')).toEqual([
      'roles:grant_technical',
      'roles:manage_technical',
      'users:manage_technical',
    ]);
  });
  it('ninguna fila sembrada viola el dominio ni el alcance declarado (revalidacion global)', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from role_permissions where permission_domain not in ('shared', role_domain)`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
  it('un rol nuevo agregado por la API sin permisos de autoridad no puede obtenerlos despues', async () => {
    const f = await failure(
      asApi(db, async () => {
        await db.query(
          `insert into roles (key, name, domain) values ('rol_nuevo', 'Nuevo', 'school')`,
        );
        await db.query(
          `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
           select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key='rol_nuevo' and p.key='roles:grant_school'`,
        );
      }),
    );
    expect(f.message).toMatch(/permisos de autoridad solo los cambia el propietario/);
  });
});

describe('red de seguridad de la migracion 0005', () => {
  it('la aserción final hace fallar la migracion si una funcion queda abierta a PUBLIC', async () => {
    const sql = readFileSync(
      join(import.meta.dirname, '..', 'drizzle', '0005_auth_integrity.sql'),
      'utf8',
    );
    const statements = sql.split('--> statement-breakpoint');
    const assertion = statements[statements.length - 1]!;
    expect(assertion).toContain('Funciones ejecutables por PUBLIC');
    await db.exec(
      `create function public.funcion_abierta() returns int language sql set search_path = pg_catalog, pg_temp as 'select 1'`,
    );
    const f = await failure(db.exec(assertion));
    expect(f.message).toMatch(/Funciones ejecutables por PUBLIC: funcion_abierta/);
    await db.exec(`drop function public.funcion_abierta()`);
    await db.exec(assertion); // sin la funcion abierta, la aserción pasa
  });
  it('detecta tambien SECURITY DEFINER y search_path sin fijar', async () => {
    const sql = readFileSync(
      join(import.meta.dirname, '..', 'drizzle', '0005_auth_integrity.sql'),
      'utf8',
    );
    const statements = sql.split('--> statement-breakpoint');
    const assertion = statements[statements.length - 1]!;
    await db.exec(
      `create function public.definer_fn() returns int language sql security definer set search_path = pg_catalog, pg_temp as 'select 1'`,
    );
    await db.exec(`revoke all on function public.definer_fn() from public`);
    expect((await failure(db.exec(assertion))).message).toMatch(
      /SECURITY DEFINER sin revision: definer_fn/,
    );
    await db.exec(`drop function public.definer_fn()`);
    await db.exec(`create function public.sin_path() returns int language sql as 'select 1'`);
    await db.exec(`revoke all on function public.sin_path() from public`);
    expect((await failure(db.exec(assertion))).message).toMatch(/sin search_path fijo: sin_path/);
    await db.exec(`drop function public.sin_path()`);
  });
});

describe('DEMOSTRACION: el privilegio TRIGGER rompe la politica de concesion (por eso nunca se concede a la API)', () => {
  it('un rol con TRIGGER adjunta un trigger propio que cambia granted_by y se autoasciende a direccion', async () => {
    const dbx = await freshDb();
    try {
      await dbx.exec(`create role api_con_trigger nologin`);
      await dbx.exec(`grant usage on schema public to api_con_trigger`);
      await dbx.exec(
        `grant select, insert, update, trigger on all tables in schema public to api_con_trigger`,
      );
      await dbx.exec(
        `grant execute on function auth_is_schema_owner(), auth_lock_authority(uuid, text), auth_current_actor() to api_con_trigger`,
      );
      const boss = await addUser(dbx, 'boss@escuela.mx', 'school');
      await bootstrap(dbx, boss, 'direccion');
      const pref = await addUser(dbx, 'pref@escuela.mx', 'school');
      await dbx.query(
        `insert into user_roles (user_id, role_id, domain, granted_by) select $1, id, 'school', $2 from roles where key='prefectura'`,
        [pref, boss],
      );

      await dbx.exec(`set role api_con_trigger`);
      await dbx.exec(
        `create function pg_temp.reescribe() returns trigger language plpgsql as $$ begin new.granted_by := '${boss}'; return new; end $$`,
      );
      await dbx.exec(
        `create trigger aaa_reescribe before insert on user_roles for each row execute function pg_temp.reescribe()`,
      );
      // La prefecta intenta concederse direccion (granted_by = ella misma): el trigger propio lo reescribe antes de las guardas.
      await dbx.query(
        `insert into user_roles (user_id, role_id, domain, granted_by) select $1, id, 'school', $1 from roles where key='direccion'`,
        [pref],
      );
      await dbx.exec(`reset role`);
      const r = await dbx.query<{ n: number }>(
        `select count(*)::int n from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1 and r.key='direccion' and ur.revoked_at is null`,
        [pref],
      );
      expect(r.rows[0]!.n).toBe(1); // ESCALAMIENTO CONSEGUIDO: documenta el riesgo, no una garantia
    } finally {
      await dbx.close();
    }
  });
});
