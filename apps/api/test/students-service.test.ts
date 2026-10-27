import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Grant, GroupAssignments } from '../src/modules/access-control/authorize.js';
import {
  createStudentsService,
  type StudentsContext,
} from '../src/modules/students/students.service.js';
import { createApiRole, addUser } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * Autorizacion por recurso, alcance y proyeccion por campos del servicio de alumnos con permisos SINTETICOS (la API real solo
 * trae los permisos de los roles sembrados). Datos ficticios, PGlite, rol de ejecucion no propietario.
 */
let db: PGlite;
const ids: Record<string, string> = {};
let ACTOR = '';
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date());
const addDays = (iso: string, d: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

const g = (permission: string, scope: Grant['scope'] = 'all'): Grant => ({ permission, scope });
const ctx = (...grants: Grant[]): StudentsContext => ({ actorId: ACTOR, grants });
const portFor = (groupIds: string[]): GroupAssignments => ({ groupIdsFor: async () => groupIds });
const svc = (assignments?: GroupAssignments) =>
  createStudentsService({
    store: pgliteStore(db, 'api_runtime'),
    assignments: () => assignments ?? portFor([]),
  });
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0]!;

beforeAll(async () => {
  db = await freshDb();
  await createApiRole(db);
  ACTOR = await addUser(db, 'actor.ficticio@escuela.test', 'school', 'active');
  const t = today();
  const year = await one<{ id: string }>(
    `insert into school_years (name, starts_on, ends_on) values ('Ciclo svc', $1, $2) returning id`,
    [addDays(t, -50), addDays(t, 100)],
  );
  ids.year = year.id;
  for (const code of ['A', 'B']) {
    ids[code] = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 1, $2) returning id`,
        [ids.year, code],
      )
    ).id;
  }
  const mk = async (key: string, given: string, family: string, group: string | null) => {
    ids[key] = (
      await one<{ id: string }>(
        `insert into students (given_names, family_name) values ($1, $2) returning id`,
        [given, family],
      )
    ).id;
    const e = await one<{ id: string }>(
      `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
      [ids[key], ids.year, addDays(t, -40)],
    );
    ids[`e${key}`] = e.id;
    if (group)
      await db.query(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
        [e.id, ids.year, ids[group], addDays(t, -40)],
      );
  };
  await mk('s1', 'Primera', 'Alumna Grupo A', 'A');
  await mk('s2', 'Segundo', 'Alumno Grupo B', 'B');
  await mk('s3', 'Tercera', 'Alumna Sin Grupo', null);
});
afterAll(async () => {
  await db.close();
});

describe('denegar por defecto', () => {
  it('sin permisos: todo FORBIDDEN (nunca datos), tambien con permisos de otro modulo', async () => {
    const c = ctx(g('catalog:read'), g('users:read'));
    for (const r of [
      await svc().listStudents(c, { page: 1, pageSize: 20 }),
      await svc().getStudent(c, ids.s1!),
      await svc().listEnrollments(c, ids.s1!),
      await svc().getEnrollment(c, ids.es1!),
      await svc().createStudent(c, { givenNames: 'X', familyName: 'Y', schoolCode: null }),
      await svc().enroll(c, ids.s1!, { schoolYearId: ids.year! }),
      await svc().transfer(c, ids.es1!, { groupId: ids.B! }),
    ]) {
      expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
  });

  it('permisos de ESCRITURA con alcance distinto de `all` no escriben', async () => {
    const c = ctx(
      g('students:manage', 'assigned_groups'),
      g('enrollments:manage', 'own'),
      g('students:read_basic'),
    );
    expect(
      await svc().createStudent(c, { givenNames: 'X', familyName: 'Y', schoolCode: null }),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(await svc().enroll(c, ids.s1!, { schoolYearId: ids.year! })).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await svc().withdraw(c, ids.es3!, {})).toMatchObject({ code: 'FORBIDDEN' });
    expect(await svc().assignGroup(c, ids.es3!, { groupId: ids.A! })).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await svc().deactivateStudent(c, ids.s3!)).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('el permiso de lectura basica NO da escritura ni expediente', async () => {
    const c = ctx(g('students:read_basic'));
    const list = await svc().listStudents(c, { page: 1, pageSize: 50 });
    expect(list.ok && list.value.total).toBe(3);
    expect(await svc().listEnrollments(c, ids.s1!)).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await svc().createStudent(c, { givenNames: 'X', familyName: 'Y', schoolCode: null }),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('proyeccion por campos', () => {
  it('students:read_basic devuelve nombre, estado y grupo vigente; sin codigo escolar ni sellos de tiempo', async () => {
    const r = await svc().getStudent(ctx(g('students:read_basic')), ids.s1!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual([
      'currentGroup',
      'familyName',
      'givenNames',
      'id',
      'isActive',
    ]);
    expect(r.value.currentGroup).toMatchObject({ id: ids.A, code: 'A' });
  });

  it('con students:read (alcance all) se agregan los sellos de tiempo y el historial de matriculas', async () => {
    const c = ctx(g('students:read_basic'), g('students:read'));
    const r = await svc().getStudent(c, ids.s1!);
    expect(r.ok && Object.keys(r.value).sort()).toEqual([
      'createdAt',
      'currentGroup',
      'familyName',
      'givenNames',
      'id',
      'isActive',
      'schoolCode',
      'updatedAt',
    ]);
    const e = await svc().listEnrollments(c, ids.s1!);
    expect(e.ok && e.value[0]!.assignments).toHaveLength(1);
  });

  it('students:read sin students:read_basic no abre nada (el basico es la puerta)', async () => {
    const c = ctx(g('students:read'));
    expect(await svc().getStudent(c, ids.s1!)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await svc().listEnrollments(c, ids.s1!)).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('alcance por grupos asignados (assigned_groups)', () => {
  const scoped = (...groups: string[]) =>
    [
      ctx(g('students:read_basic', 'assigned_groups'), g('students:read', 'assigned_groups')),
      svc(portFor(groups)),
    ] as const;

  it('solo ve a los alumnos de sus grupos: listados, contadores, busquedas y filtros', async () => {
    const [c, s] = scoped(ids.A!);
    const list = await s.listStudents(c, { page: 1, pageSize: 50 });
    expect(list.ok && list.value.items.map((x) => x.id)).toEqual([ids.s1]);
    expect(list.ok && list.value.total).toBe(1); // el contador no revela alumnos de otros grupos
    const search = await s.listStudents(c, { page: 1, pageSize: 50, q: 'Alumno Grupo B' });
    expect(search.ok && search.value.total).toBe(0);
    const byGroup = await s.listStudents(c, { page: 1, pageSize: 50, groupId: ids.B! });
    expect(byGroup.ok && byGroup.value.total).toBe(0);
    const paged = await s.listStudents(c, { page: 2, pageSize: 1 });
    expect(paged.ok && paged.value.items).toEqual([]);
    expect(paged.ok && paged.value.total).toBe(1);
  });

  it('un alumno fuera del alcance es INDISTINGUIBLE de uno inexistente (misma respuesta) en detalle, historial y matricula', async () => {
    const [c, s] = scoped(ids.A!);
    const missing = '00000000-0000-4000-8000-0000000000aa';
    const strip = (r: unknown) => JSON.stringify(r);
    expect(strip(await s.getStudent(c, ids.s2!))).toBe(strip(await s.getStudent(c, missing)));
    expect(strip(await s.listEnrollments(c, ids.s2!))).toBe(
      strip(await s.listEnrollments(c, missing)),
    );
    expect(strip(await s.getEnrollment(c, ids.es2!))).toBe(
      strip(await s.getEnrollment(c, missing)),
    );
    expect(await s.getStudent(c, ids.s2!)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await s.getStudent(c, ids.s3!)).toMatchObject({ ok: false, code: 'NOT_FOUND' }); // sin grupo: solo ve quien tiene alcance all
    expect(await s.getStudent(c, ids.s1!)).toMatchObject({ ok: true });
  });

  it('sin asignaciones (conjunto vacio) o con una asignacion a un grupo ajeno: CERO filas, nunca "sin filtro"', async () => {
    for (const [c, s] of [scoped(), scoped('00000000-0000-4000-8000-0000000000bb')]) {
      const list = await s.listStudents(c, { page: 1, pageSize: 50 });
      expect(list.ok && list.value).toMatchObject({ items: [], total: 0 });
      expect(await s.getStudent(c, ids.s1!)).toMatchObject({ code: 'NOT_FOUND' });
    }
    // el puerto real de produccion aun no tiene asignaciones: prefectura no ve nada
    const real = svc();
    const list = await real.listStudents(ctx(g('students:read_basic', 'assigned_groups')), {
      page: 1,
      pageSize: 50,
    });
    expect(list.ok && list.value.total).toBe(0);
  });

  it('el alcance usa el grupo VIGENTE hoy: un alumno trasladado deja de ser visible para el grupo anterior', async () => {
    const e = await one<{ id: string }>(
      `insert into enrollments (student_id, school_year_id, starts_on)
       select s.id, $1, $2 from students s where s.family_name = 'Alumna Sin Grupo' returning id`,
      [ids.year, addDays(today(), -10)],
    ).catch(() => null);
    expect(e).toBeNull(); // ya tiene matricula en el ciclo (unica por alumno y ciclo)
    const c = ctx(g('students:read_basic', 'assigned_groups'));
    const before = await svc(portFor([ids.B!])).getStudent(c, ids.s2!);
    expect(before.ok).toBe(true);
    const moved = await svc(portFor([])).transfer(ctx(g('enrollments:manage')), ids.es2!, {
      groupId: ids.A!,
      effectiveOn: today(),
    });
    expect(moved.ok).toBe(true);
    expect(await svc(portFor([ids.B!])).getStudent(c, ids.s2!)).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await svc(portFor([ids.A!])).getStudent(c, ids.s2!)).toMatchObject({ ok: true });
  });

  it('con alcance basico por grupos y expediente solo `own`/ajeno: el expediente (matriculas) no se abre', async () => {
    const c = ctx(g('students:read_basic', 'assigned_groups'), g('students:read', 'own'));
    const s = svc(portFor([ids.A!]));
    expect(await s.getStudent(c, ids.s1!)).toMatchObject({ ok: true });
    expect(await s.listEnrollments(c, ids.s1!)).toMatchObject({ code: 'NOT_FOUND' });
    const d = await s.getStudent(c, ids.s1!);
    expect(d.ok && 'createdAt' in d.value).toBe(false);
  });

  it('el alcance `own` no aplica a alumnos: ninguna fila', async () => {
    const list = await svc().listStudents(ctx(g('students:read_basic', 'own')), {
      page: 1,
      pageSize: 50,
    });
    expect(list.ok && list.value.total).toBe(0);
  });
});

describe('modulo no habilitado en la base', () => {
  it('sin las tablas de la migracion 0007 responde UNAVAILABLE de forma controlada', async () => {
    const old = new PGlite({ extensions: { btree_gist } });
    const dir = join(import.meta.dirname, '..', 'drizzle');
    for (const m of readMigrationFiles({ migrationsFolder: dir }).slice(0, 7))
      for (const stmt of m.sql) await old.exec(stmt);
    await createApiRole(old);
    const s = createStudentsService({
      store: pgliteStore(old, 'api_runtime'),
      assignments: () => portFor([]),
    });
    const c = ctx(g('students:read_basic'), g('students:manage'), g('enrollments:manage'));
    expect(await s.listStudents(c, { page: 1, pageSize: 20 })).toMatchObject({
      ok: false,
      code: 'UNAVAILABLE',
      reason: 'STUDENTS_UNAVAILABLE',
    });
    expect(
      await s.createStudent(c, { givenNames: 'X', familyName: 'Y', schoolCode: null }),
    ).toMatchObject({ code: 'UNAVAILABLE' });
    await old.close();
  });
});
