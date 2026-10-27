import { join } from 'node:path';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGlite as PGliteCtor } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, bootstrap, grant, revoke } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';

/**
 * Migracion 0009 (asignaciones de grupos a prefectura) en PGlite = PostgreSQL 18.6 en memoria, con todas las migraciones. Las
 * reglas son de la BASE (propietario); la API como rol no propietario se prueba en el clúster desechable. Datos FICTICIOS.
 * Convencion: periodos inclusivos; "hoy" = dia de calendario de America/Mazatlan; sin retroactividad.
 */
let db: PGlite;
let today: string;
const addDays = (iso: string, d: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

const ids: Record<string, string> = {};
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0]!;

/** Error (SQLSTATE y CONSTRAINT) de una operacion que debe fallar. */
async function err(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
  throw new Error('Se esperaba un error y la operacion tuvo exito');
}

const insert = (
  userId: string,
  groupId: string,
  startsOn: string,
  endsOn: string | null = null,
  year = ids.year!,
) =>
  one<{ id: string }>(
    `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, ends_on, created_by)
     values ($1, $2, $3, $4::date, $5::date, $6) returning id`,
    [userId, year, groupId, startsOn, endsOn, ids.boss],
  ).then((r) => r.id);

beforeAll(async () => {
  db = await freshDb();
  today = (
    await one<{ d: string }>(
      `select to_char((now() at time zone 'America/Mazatlan')::date, 'YYYY-MM-DD') d`,
    )
  ).d;
  ids.boss = await addUser(db, 'direccion.ficticia@escuela.test', 'school');
  await bootstrap(db, ids.boss, 'direccion');
  const prefect = async (key: string, email: string) => {
    ids[key] = await addUser(db, email, 'school');
    await grant(db, ids[key]!, 'prefectura', ids.boss!);
  };
  await prefect('p1', 'prefecta.uno@escuela.test');
  await prefect('p2', 'prefecta.dos@escuela.test');
  await prefect('p3', 'prefecta.tres@escuela.test');
  ids.noRole = await addUser(db, 'sin.rol@escuela.test', 'school');
  ids.tech = await addUser(db, 'tecnica@escuela.test', 'technical');
  ids.disabled = await addUser(db, 'inactiva@escuela.test', 'school');
  await grant(db, ids.disabled, 'prefectura', ids.boss);
  await db.query(`update users set status = 'disabled' where id = $1`, [ids.disabled]);

  ids.year = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('Ciclo prefectura', $1, $2) returning id`,
      [addDays(today, -30), addDays(today, 300)],
    )
  ).id;
  ids.otherYear = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('Ciclo siguiente', $1, $2) returning id`,
      [addDays(today, 400), addDays(today, 700)],
    )
  ).id;
  const grp = async (key: string, year: string, code: string, active = true) => {
    ids[key] = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code, is_active) values ($1, 1, $2, $3) returning id`,
        [year, code, active],
      )
    ).id;
  };
  await grp('gA', ids.year, 'A');
  await grp('gB', ids.year, 'B');
  await grp('gC', ids.year, 'C');
  await grp('gD', ids.year, 'D');
  await grp('gOff', ids.year, 'OFF', false);
  await grp('gOther', ids.otherYear, 'A');
}, 60_000);
afterAll(async () => db.close());

describe('0009: estructura', () => {
  it('crea la tabla con UUID v7, sin DELETE posible y con las restricciones esperadas', async () => {
    const id = await insert(ids.p1!, ids.gA!, today);
    const row = await one<{ v: string }>(
      `select substr(id::text, 15, 1) v from prefect_group_assignments where id = $1`,
      [id],
    );
    expect(row.v).toBe('7');
    const c = await db.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'prefect_group_assignments'::regclass order by 1`,
    );
    expect(c.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'pga_created_by_fkey',
        'pga_dates_ordered',
        'pga_group_year_fkey',
        'pga_no_overlap',
        'pga_reason_clean',
        'pga_revocation_consistent',
        'pga_revoked_by_fkey',
        'pga_school_year_fkey',
        'pga_user_fkey',
      ]),
    );
  });

  it('las funciones nuevas son SECURITY INVOKER, con search_path fijo y sin EXECUTE para PUBLIC', async () => {
    const f = await db.query<{ proname: string; definer: boolean; pinned: boolean; open: boolean }>(
      `select p.proname, p.prosecdef as definer,
              coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false) as pinned,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as open
         from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('prefect_assignments_no_delete','pga_guard_insert','pga_guard_update','school_years_guard_prefect_dates')`,
    );
    expect(f.rows).toHaveLength(4);
    for (const r of f.rows)
      expect(r, r.proname).toMatchObject({ definer: false, pinned: true, open: false });
  });
});

describe('alta', () => {
  it('una prefecta puede tener varios grupos y un grupo varias prefectas a la vez (cobertura)', async () => {
    await insert(ids.p1!, ids.gB!, today);
    await insert(ids.p2!, ids.gA!, today); // gA ya tiene a p1
    await insert(ids.p2!, ids.gB!, today);
    const n = await one<{ n: number }>(
      `select count(*)::int n from prefect_group_assignments where group_id = $1 and revoked_at is null`,
      [ids.gA],
    );
    expect(n.n).toBe(2);
  });

  it('asignacion temporal y periodos consecutivos (inclusivos): fin 10, inicio 11 si; el mismo dia no', async () => {
    await insert(ids.p3!, ids.gC!, today, addDays(today, 4));
    await insert(ids.p3!, ids.gC!, addDays(today, 5), addDays(today, 9)); // consecutivo
    expect((await err(insert(ids.p3!, ids.gC!, addDays(today, 9), addDays(today, 12)))).code).toBe(
      '23P01',
    ); // comparte el dia 9
  });

  it('duplicado exacto y periodos traslapados del mismo par: 23P01', async () => {
    await insert(ids.p1!, ids.gD!, addDays(today, 20), addDays(today, 40));
    expect((await err(insert(ids.p1!, ids.gD!, addDays(today, 20), addDays(today, 40)))).code).toBe(
      '23P01',
    );
    expect((await err(insert(ids.p1!, ids.gD!, addDays(today, 30)))).code).toBe('23P01');
  });

  it('solo una cuenta escolar ACTIVA con el rol de prefectura vigente (23514)', async () => {
    expect((await err(insert(ids.noRole!, ids.gA!, today))).constraint).toBe('pga_user_role');
    expect((await err(insert(ids.tech!, ids.gA!, today))).constraint).toBe('pga_user_active');
    expect((await err(insert(ids.disabled!, ids.gA!, today))).constraint).toBe('pga_user_active');
    expect((await err(insert(ids.boss!, ids.gA!, today))).constraint).toBe('pga_user_role'); // Direccion no es prefecta
  });

  it('un rol de prefectura revocado deja de ser elegible, pero no se borra lo ya asignado', async () => {
    const u = await addUser(db, 'rol.revocado@escuela.test', 'school');
    await grant(db, u, 'prefectura', ids.boss!);
    const id = await insert(u, ids.gD!, addDays(today, 100), addDays(today, 110));
    await revoke(db, u, 'prefectura', ids.boss!);
    expect((await err(insert(u, ids.gC!, addDays(today, 100)))).constraint).toBe('pga_user_role');
    const kept = await one<{ n: number }>(
      `select count(*)::int n from prefect_group_assignments where id = $1`,
      [id],
    );
    expect(kept.n).toBe(1);
  });

  it('el grupo debe existir, estar activo y pertenecer al ciclo (FK compuesta)', async () => {
    expect((await err(insert(ids.p1!, ids.gOff!, today))).constraint).toBe('pga_group_active');
    expect((await err(insert(ids.p1!, ids.gOther!, today))).code).toBe('23503'); // grupo de otro ciclo
    await insert(ids.p1!, ids.gOther!, addDays(today, 410), null, ids.otherYear!); // el ciclo siguiente: valido
    expect((await err(insert(ids.p1!, '00000000-0000-4000-8000-000000000001', today))).code).toBe(
      '23503',
    );
  });

  it('el periodo cae dentro del ciclo y no es retroactivo (23514)', async () => {
    expect((await err(insert(ids.p1!, ids.gA!, addDays(today, -1)))).constraint).toBe(
      'pga_no_backdate',
    );
    expect((await err(insert(ids.p1!, ids.gA!, addDays(today, 301)))).constraint).toBe(
      'pga_within_year',
    );
    expect(
      (await err(insert(ids.p1!, ids.gA!, addDays(today, 100), addDays(today, 301)))).constraint,
    ).toBe('pga_within_year');
    expect(
      (await err(insert(ids.p1!, ids.gA!, addDays(today, 100), addDays(today, 99)))).code,
    ).toBe('23514'); // fin antes del inicio
  });

  it('una asignacion nace sin revocacion', async () => {
    const e = await err(
      db.query(
        `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by, revoked_by, revocation_reason)
         values ($1, $2, $3, $4::date, $5, $5, 'motivo')`,
        [ids.p1, ids.year, ids.gC, addDays(today, 200), ids.boss],
      ),
    );
    expect(e.constraint).toBe('pga_born_active');
  });
});

describe('cierre programado, revocacion e historial', () => {
  it('cierre: NULL -> fecha y acortar si; extender, reabrir o cerrar antes de hoy no', async () => {
    const id = await insert(ids.p2!, ids.gC!, today);
    await db.query(`update prefect_group_assignments set ends_on = $2::date where id = $1`, [
      id,
      addDays(today, 30),
    ]);
    await db.query(`update prefect_group_assignments set ends_on = $2::date where id = $1`, [
      id,
      addDays(today, 10),
    ]); // acortar
    expect(
      (
        await err(
          db.query(`update prefect_group_assignments set ends_on = $2::date where id = $1`, [
            id,
            addDays(today, 20),
          ]),
        )
      ).code,
    ).toBe('42501'); // extender
    expect(
      (
        await err(
          db.query(`update prefect_group_assignments set ends_on = null where id = $1`, [id]),
        )
      ).code,
    ).toBe('42501'); // reabrir
    const id2 = await insert(ids.p2!, ids.gD!, addDays(today, 50));
    expect(
      (
        await err(
          db.query(`update prefect_group_assignments set ends_on = $2::date where id = $1`, [
            id2,
            addDays(today, 40),
          ]),
        )
      ).code,
    ).toBe('23514'); // antes del inicio (check de orden)
    expect(
      (
        await err(
          db.query(`update prefect_group_assignments set ends_on = $2::date where id = $1`, [
            id2,
            addDays(today, 301),
          ]),
        )
      ).constraint,
    ).toBe('pga_within_year');
  });

  it('la identidad y el inicio son inmutables (42501)', async () => {
    const id = await insert(ids.p3!, ids.gA!, addDays(today, 60));
    for (const set of [
      `user_id = '${ids.p1}'`,
      `group_id = '${ids.gB}'`,
      `starts_on = '${addDays(today, 61)}'`,
      `created_by = '${ids.p1}'`,
      `school_year_id = '${ids.otherYear}'`,
      `created_at = now() - interval '1 day'`,
    ])
      expect(
        (await err(db.query(`update prefect_group_assignments set ${set} where id = $1`, [id])))
          .code,
        set,
      ).toBe('42501');
  });

  it('revocar fija revoked_at en el servidor, la fila queda como historia inmutable y no bloquea una asignacion nueva', async () => {
    const id = await insert(ids.p1!, ids.gC!, addDays(today, 70), addDays(today, 90));
    await db.query(
      `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Cambio de turno' where id = $1`,
      [id, ids.boss],
    );
    const row = await one<{ revoked_at: Date | null; ends_on: string }>(
      `select revoked_at, ends_on::text from prefect_group_assignments where id = $1`,
      [id],
    );
    expect(row.revoked_at).not.toBeNull();
    expect(row.ends_on).toBe(addDays(today, 90)); // el historial conserva el periodo programado
    // jamas recupera acceso: ningun campo cambia
    for (const set of [
      `revoked_at = null`,
      `revoked_by = null`,
      `revocation_reason = 'otro'`,
      `ends_on = '${addDays(today, 80)}'`,
    ])
      expect(
        (await err(db.query(`update prefect_group_assignments set ${set} where id = $1`, [id])))
          .code,
        set,
      ).toBe('42501');
    // el mismo par y periodo puede asignarse de nuevo (decision nueva, fila nueva)
    const again = await insert(ids.p1!, ids.gC!, addDays(today, 70), addDays(today, 90));
    expect(again).not.toBe(id);
  });

  it('el cliente no elige la hora de revocacion ni revoca a medias; el motivo es obligatorio y limpio', async () => {
    const id = await insert(ids.p3!, ids.gB!, addDays(today, 120));
    expect(
      (
        await err(
          db.query(`update prefect_group_assignments set revoked_at = now() where id = $1`, [id]),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(
            `update prefect_group_assignments set revocation_reason = 'sin quien revoca' where id = $1`,
            [id],
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(`update prefect_group_assignments set revoked_by = $2 where id = $1`, [
            id,
            ids.boss,
          ]),
        )
      ).code,
    ).toBe('23514'); // sin motivo
    for (const reason of ['ab', ' con espacios ', 'con\nsalto', 'x'.repeat(201)])
      expect(
        (
          await err(
            db.query(
              `update prefect_group_assignments set revoked_by = $2, revocation_reason = $3 where id = $1`,
              [id, ids.boss, reason],
            ),
          )
        ).code,
        reason.slice(0, 12),
      ).toBe('23514');
  });

  it('revocar no cambia las fechas', async () => {
    const id = await insert(ids.p3!, ids.gD!, addDays(today, 130));
    expect(
      (
        await err(
          db.query(
            `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'motivo valido', ends_on = $3::date where id = $1`,
            [id, ids.boss, addDays(today, 140)],
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('no hay DELETE ni TRUNCATE (42501)', async () => {
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 3, 'DEL') returning id`,
        [ids.year],
      )
    ).id;
    const id = await insert(ids.p2!, g, addDays(today, 150));
    expect(
      (await err(db.query(`delete from prefect_group_assignments where id = $1`, [id]))).code,
    ).toBe('42501');
    expect(['0A000', '42501']).toContain(
      (await err(db.query(`truncate prefect_group_assignments`))).code,
    );
  });
});

describe('integridad con el ciclo escolar', () => {
  it('las fechas del ciclo no pueden dejar asignaciones fuera (23514); ampliar o mover sin dejar fuera, si', async () => {
    const y = (
      await one<{ id: string }>(
        `insert into school_years (name, starts_on, ends_on) values ('Ciclo fechas', $1, $2) returning id`,
        [addDays(today, 1000), addDays(today, 1300)],
      )
    ).id;
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'F') returning id`,
        [y],
      )
    ).id;
    await insert(ids.p1!, g, addDays(today, 1010), addDays(today, 1100), y);
    const upd = (set: string) => db.query(`update school_years set ${set} where id = $1`, [y]);
    expect((await err(upd(`starts_on = '${addDays(today, 1011)}'`))).constraint).toBe(
      'school_years_prefect_within',
    );
    expect((await err(upd(`ends_on = '${addDays(today, 1099)}'`))).constraint).toBe(
      'school_years_prefect_within',
    );
    await upd(`name = 'Ciclo fechas 2'`); // renombrar no dispara la regla
    await upd(`starts_on = '${addDays(today, 1005)}', ends_on = '${addDays(today, 1400)}'`);
  });
});

describe('0009: conteos de la migracion de prueba (no se asumen)', () => {
  it('de 0008 a 0009: 27 -> 29 permisos, 35 -> 37 asignaciones y 9 -> 13 eventos de auditoria', async () => {
    const dir = join(import.meta.dirname, '..', 'drizzle');
    const migrations = readMigrationFiles({ migrationsFolder: dir });
    const d = new PGliteCtor({ extensions: { btree_gist } });
    for (const m of migrations.slice(0, 9)) for (const stmt of m.sql) await d.exec(stmt);
    const counts = async () => ({
      perms: Number(
        (await d.query<{ n: number }>('select count(*)::int n from permissions')).rows[0]!.n,
      ),
      rp: Number(
        (await d.query<{ n: number }>('select count(*)::int n from role_permissions')).rows[0]!.n,
      ),
      audit: Number(
        (await d.query<{ n: number }>('select count(*)::int n from audit_events')).rows[0]!.n,
      ),
    });
    expect(await counts()).toEqual({ perms: 27, rp: 35, audit: 9 });
    for (const stmt of migrations[9]!.sql) await d.exec(stmt);
    expect(await counts()).toEqual({ perms: 29, rp: 37, audit: 13 });
    // los 4 eventos nuevos son altas/bajas de role_permissions sin actor (migracion)
    const ev = await d.query<{ event_type: string; actor_user_id: string | null }>(
      "select event_type, actor_user_id from audit_events where event_type = 'role.permissions_changed'",
    );
    expect(ev.rows).toHaveLength(13);
    expect(ev.rows.every((e) => e.actor_user_id === null)).toBe(true);
    // idempotencia de la parte RBAC (las sentencias de datos no cambian nada al repetirse)
    const stmts = migrations[9]!.sql;
    const from = stmts.findIndex((x) => x.includes('INSERT INTO "permissions"'));
    for (const stmt of stmts.slice(from)) await d.exec(stmt);
    expect(await counts()).toEqual({ perms: 29, rp: 37, audit: 13 });
    await d.close();
  });
});

describe('0009: nada mas cambia', () => {
  it('RBAC: permisos nuevos solo para Direccion (all) y prefectura (own, solo lectura); prefectura pierde el expediente', async () => {
    const m = await db.query<{ k: string }>(
      `select r.key || '|' || p.key || '|' || rp.scope as k from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key like 'prefect_assignments:%' or (r.key = 'prefectura' and p.key like 'students:%') order by 1`,
    );
    expect(m.rows.map((x) => x.k).sort()).toEqual(
      [
        'direccion|prefect_assignments:manage|all',
        'direccion|prefect_assignments:read|all',
        'prefectura|prefect_assignments:read|own',
        'prefectura|students:read_basic|assigned_groups',
      ].sort(),
    );
    const perms = await db.query<{ key: string; domain: string; is_authority: boolean }>(
      `select key, domain, is_authority from permissions where key like 'prefect_assignments:%' order by 1`,
    );
    expect(perms.rows).toEqual([
      { key: 'prefect_assignments:manage', domain: 'school', is_authority: false },
      { key: 'prefect_assignments:read', domain: 'school', is_authority: false },
    ]);
  });

  it('admin_tecnico, trabajo_social y control_acceso no reciben permisos de asignaciones ni de alumnos', async () => {
    const n = await one<{ n: number }>(
      `select count(*)::int n from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where r.key in ('admin_tecnico', 'trabajo_social', 'control_acceso')
          and (p.key like 'prefect_assignments:%' or p.key like 'students:%' or p.key like 'enrollments:%')`,
    );
    expect(n.n).toBe(0);
  });

  it('un permiso de asignaciones jamas se concede a admin_tecnico: lo impide el esquema (dominio)', async () => {
    const e = await err(
      db.query(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p
          where r.key = 'admin_tecnico' and p.key = 'prefect_assignments:read'`,
      ),
    );
    expect(e.constraint).toBe('role_permissions_domain_match');
  });
});
