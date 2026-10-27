import type { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGlite as PGliteCtor } from '@electric-sql/pglite';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Grant } from '../src/modules/access-control/authorize.js';
import {
  createPrefectAssignmentsService,
  pgGroupAssignments,
  type PrefectContext,
} from '../src/modules/prefect-assignments/prefect-assignments.service.js';
import { createStudentsService } from '../src/modules/students/students.service.js';
import { addUser, bootstrap, createApiRole, grant } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * Servicio de asignaciones de prefectura y puerto `assigned_groups` con "hoy" inyectado (fin de ciclo, fechas inclusivas, cuenta
 * bloqueada, base sin la tabla). PGlite = PostgreSQL 18.6 en memoria, rol de ejecucion no propietario, datos ficticios.
 */
let db: PGlite;
const ids: Record<string, string> = {};
const real = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date());
const addDays = (iso: string, d: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0]!;
const g = (permission: string, scope: Grant['scope'] = 'all'): Grant => ({ permission, scope });

const store = () => pgliteStore(db, 'api_runtime');
const portAt = (userId: string, date: string) =>
  store().transaction((tx) => pgGroupAssignments(tx).groupIdsFor(userId, date));

beforeAll(async () => {
  db = await freshDb();
  await createApiRole(db);
  ids.boss = await addUser(db, 'direccion.svc@escuela.test', 'school');
  await bootstrap(db, ids.boss, 'direccion');
  ids.p = await addUser(db, 'prefecta.svc@escuela.test', 'school');
  await grant(db, ids.p, 'prefectura', ids.boss);
  ids.year = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('Ciclo svc', $1, $2) returning id`,
      [addDays(real, -10), addDays(real, 100)],
    )
  ).id;
  ids.g = (
    await one<{ id: string }>(
      `insert into groups (school_year_id, grade, code) values ($1, 1, 'S') returning id`,
      [ids.year],
    )
  ).id;
  // [real+5, real+20] como propietario (equivale a una asignacion creada hoy con fechas futuras)
  ids.a = (
    await one<{ id: string }>(
      `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, ends_on, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ids.p, ids.year, ids.g, addDays(real, 5), addDays(real, 20), ids.boss],
    )
  ).id;
});
afterAll(async () => db.close());

describe('puerto assigned_groups: fechas inclusivas y estado actual', () => {
  it('antes del inicio no hay acceso; el dia de inicio y el ultimo dia (inclusivo) si; el dia siguiente no', async () => {
    expect(await portAt(ids.p!, addDays(real, 4))).toEqual([]);
    expect(await portAt(ids.p!, addDays(real, 5))).toEqual([ids.g]);
    expect(await portAt(ids.p!, addDays(real, 20))).toEqual([ids.g]);
    expect(await portAt(ids.p!, addDays(real, 21))).toEqual([]);
  });

  it('el id de otra persona no devuelve los grupos de esta', async () => {
    expect(await portAt(ids.boss!, addDays(real, 10))).toEqual([]);
    expect(await portAt('00000000-0000-4000-8000-000000000001', addDays(real, 10))).toEqual([]);
  });

  it('cuenta bloqueada o desactivada: sin acceso; al levantar el bloqueo vuelve (es estado, no historia)', async () => {
    const d = addDays(real, 10);
    await db.query(`update users set locked_until = now() + interval '1 hour' where id = $1`, [
      ids.p,
    ]);
    expect(await portAt(ids.p!, d)).toEqual([]);
    await db.query(`update users set locked_until = null where id = $1`, [ids.p]);
    expect(await portAt(ids.p!, d)).toEqual([ids.g]);
    await db.query(`update users set status = 'disabled' where id = $1`, [ids.p]);
    expect(await portAt(ids.p!, d)).toEqual([]);
    await db.query(`update users set status = 'active' where id = $1`, [ids.p]);
    expect(await portAt(ids.p!, d)).toEqual([ids.g]);
  });

  it('grupo inactivo y fin del ciclo: sin acceso (aunque la asignacion no tenga fecha de fin)', async () => {
    const d = addDays(real, 10);
    await db.query(`update groups set is_active = false where id = $1`, [ids.g]);
    expect(await portAt(ids.p!, d)).toEqual([]);
    await db.query(`update groups set is_active = true where id = $1`, [ids.g]);
    // asignacion abierta (sin fin) en otro grupo: el acceso termina con el ciclo
    const g2 = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'T') returning id`,
        [ids.year],
      )
    ).id;
    await db.query(
      `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
      [ids.p, ids.year, g2, addDays(real, 1), ids.boss],
    );
    expect(await portAt(ids.p!, addDays(real, 100))).toEqual([g2]); // ultimo dia del ciclo
    expect(await portAt(ids.p!, addDays(real, 101))).toEqual([]); // ciclo terminado
    const svc = createPrefectAssignmentsService({
      store: store(),
      today: () => addDays(real, 101),
    });
    const ctx: PrefectContext = { actorId: ids.boss!, grants: [g('prefect_assignments:read')] };
    const list = await svc.list(ctx, { page: 1, pageSize: 50 });
    expect(list.ok && list.value.items.map((x) => x.status)).toEqual(
      expect.arrayContaining(['completed', 'closed']),
    );
    expect(list.ok && list.value.items.every((x) => x.grantsAccess === false)).toBe(true);
  });

  it('revocada: sin acceso en cualquier fecha', async () => {
    await db.query(
      `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Prueba de servicio' where id = $1`,
      [ids.a, ids.boss],
    );
    expect(await portAt(ids.p!, addDays(real, 10))).not.toContain(ids.g); // (conserva la otra asignacion, abierta)
  });

  it('una base sin la tabla (antes de 0009) o sin privilegios deniega (vacio) sin romper la transaccion', async () => {
    const old = new PGliteCtor({ extensions: { btree_gist } });
    const dir = join(import.meta.dirname, '..', 'drizzle');
    for (const m of readMigrationFiles({ migrationsFolder: dir }).slice(0, 9))
      for (const stmt of m.sql) await old.exec(stmt);
    await createApiRole(old);
    const s = pgliteStore(old, 'api_runtime');
    const out = await s.transaction(async (tx) => {
      const ids2 = await pgGroupAssignments(tx).groupIdsFor(
        '00000000-0000-4000-8000-000000000001',
        real,
      );
      // la transaccion sigue utilizable despues del error controlado
      const ping = await tx.query<{ n: number }>('select 1 as n');
      return [ids2, ping.rows[0]!.n];
    });
    expect(out).toEqual([[], 1]);
    await old.close();
  });
});

describe('servicio de alumnos con el puerto real', () => {
  it('una prefecta solo ve alumnos de los grupos que el puerto le da y cero si no tiene ninguno', async () => {
    const s = (today: string) =>
      createStudentsService({
        store: store(),
        assignments: pgGroupAssignments,
        today: () => today,
      });
    const year2 = (
      await one<{ id: string }>(
        `insert into school_years (name, starts_on, ends_on) values ('Ciclo alumnos', $1, $2) returning id`,
        [addDays(real, 500), addDays(real, 700)],
      )
    ).id;
    const ga = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 1, 'A') returning id`,
        [year2],
      )
    ).id;
    const gb = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 1, 'B') returning id`,
        [year2],
      )
    ).id;
    const prefecta2 = await addUser(db, 'prefecta.dos.svc@escuela.test', 'school');
    await grant(db, prefecta2, 'prefectura', ids.boss!);
    for (const [grp, name] of [
      [ga, 'Ana'],
      [gb, 'Beto'],
    ] as const) {
      const st = (
        await one<{ id: string }>(
          `insert into students (given_names, family_name) values ($1, 'Ficticio') returning id`,
          [name],
        )
      ).id;
      const e = (
        await one<{ id: string }>(
          `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
          [st, year2, addDays(real, 500)],
        )
      ).id;
      await db.query(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
        [e, year2, grp, addDays(real, 500)],
      );
    }
    await db.query(
      `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
      [prefecta2, year2, ga, addDays(real, 500), ids.boss],
    );
    const ctx = (actor: string): { actorId: string; grants: Grant[] } => ({
      actorId: actor,
      grants: [g('students:read_basic', 'assigned_groups')],
    });
    const day = addDays(real, 510);
    const mine = await s(day).listStudents(ctx(prefecta2), { page: 1, pageSize: 20 });
    expect(mine.ok && mine.value.items.map((x) => x.givenNames)).toEqual(['Ana']);
    expect(mine.ok && mine.value.total).toBe(1);
    // antes de que empiece la asignacion: cero filas, jamas "sin filtro"
    const early = await s(addDays(real, 499)).listStudents(ctx(prefecta2), {
      page: 1,
      pageSize: 20,
    });
    expect(early.ok && early.value).toMatchObject({ items: [], total: 0 });
    // otra persona (sin asignaciones): cero filas
    const none = await s(day).listStudents(ctx(ids.p!), { page: 1, pageSize: 20 });
    expect(none.ok && none.value.total).toBe(0);
    // la lista de grupo ajeno es indistinguible de uno inexistente
    const foreign = await s(day).getGroupRoster(ctx(prefecta2), gb);
    const missing = await s(day).getGroupRoster(
      ctx(prefecta2),
      '00000000-0000-4000-8000-000000000009',
    );
    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const own = await s(day).getGroupRoster(ctx(prefecta2), ga);
    expect(own.ok && own.value.students.map((x) => x.givenNames)).toEqual(['Ana']);
  });
});
