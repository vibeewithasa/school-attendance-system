import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { applyMigrations, startTempPostgres, type TempPostgres } from '../helpers/pg-temp.js';

/**
 * La migracion 0010 aplicada de forma INCREMENTAL sobre un PostgreSQL 18 DESECHABLE que ya esta en el estado de eta15_dev (0000-0009)
 * y con datos ficticios previos (ciclo, grupo, alumnos, matriculas, cuentas y una asignacion de prefectura). Comprueba que no altera
 * nada existente y que el modulo funciona sobre esos datos. No toca eta15_dev.
 */
let pgt: TempPostgres;
let owner: pg.Client;
const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const count = async (table: string) =>
  Number((await q(`select count(*)::int n from ${table}`))[0]!.n);

const addDays = (iso: string, d: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const TABLES = [
  'users',
  'user_roles',
  'roles',
  'permissions',
  'school_years',
  'groups',
  'students',
  'enrollments',
  'student_group_assignments',
  'prefect_group_assignments',
  'audit_events',
];
const before: Record<string, number> = {};
let today = '';
let boss = '';
let year = '';
let group = '';
const pupils: Array<{ enrollment: string; assignment: string }> = [];

beforeAll(async () => {
  pgt = await startTempPostgres();
  const superuser = await pgt.connect();
  await superuser.query('create role eta15_app login');
  await superuser.query('create database eta15_dev owner eta15_app');
  owner = await pgt.connect('eta15_app', 'eta15_dev');
  await applyMigrations(owner, { until: 10 }); // 0000-0009: el estado actual de eta15_dev
  today = (
    await q(`select to_char((now() at time zone 'America/Mazatlan')::date, 'YYYY-MM-DD') d`)
  )[0]!.d as string;
  boss = (
    await q(
      `insert into users (email, display_name, account_domain, status, password_hash)
       values ('direccion.migracion@escuela.test', 'Direccion ficticia', 'school', 'active', 'hash-ficticio') returning id`,
    )
  )[0]!.id as string;
  await q(
    `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
     select $1, id, domain, null, 'bootstrap', 'ACTA-PRUEBA' from roles where key = 'direccion'`,
    [boss],
  );
  year = (
    await q(
      `insert into school_years (name, starts_on, ends_on) values ('Ciclo previo', $1, $2) returning id`,
      [addDays(today, -400), addDays(today, 300)],
    )
  )[0]!.id as string;
  group = (
    await q(`insert into groups (school_year_id, grade, code) values ($1, 1, 'A') returning id`, [
      year,
    ])
  )[0]!.id as string;
  for (const name of ['Unoa', 'Dosa', 'Tresa']) {
    const st = (
      await q(
        `insert into students (given_names, family_name) values ($1, 'Previa') returning id`,
        [name],
      )
    )[0]!.id as string;
    const en = (
      await q(
        `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
        [st, year, addDays(today, -300)],
      )
    )[0]!.id as string;
    const asg = (
      await q(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
        [en, year, group, addDays(today, -300)],
      )
    )[0]!.id as string;
    pupils.push({ enrollment: en, assignment: asg });
  }
  for (const t of TABLES) before[t] = await count(t);
  before.role_permissions = await count('role_permissions');
}, 240_000);
afterAll(async () => {
  await pgt?.stop();
}, 60_000);

describe('0010 sobre un clúster en el estado de eta15_dev (0000-0009)', () => {
  it('antes de aplicarla no existen las tablas de asistencia y trabajo social conserva la lectura global (la brecha)', async () => {
    expect(
      (
        await q(
          `select count(*)::int n from pg_class where relname like 'attendance\\_%' and relnamespace = 'public'::regnamespace`,
        )
      )[0]!.n,
    ).toBe(0);
    expect(before.role_permissions).toBe(37);
    expect(
      (
        await q(
          `select count(*)::int n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
            where r.key = 'trabajo_social' and p.key = 'attendance:read' and rp.scope = 'all'`,
        )
      )[0]!.n,
    ).toBe(1);
  });

  it('se aplica sin errores; no cambia datos existentes; solo agrega 3 tablas, sus triggers y retira UNA asignacion de permiso (1 evento de auditoria)', async () => {
    await applyMigrations(owner, { from: 10, until: 11 }); // solo la 0010 (la 0011 tiene su propia prueba)
    for (const t of TABLES.filter((x) => x !== 'audit_events'))
      expect(await count(t), t).toBe(before[t]);
    expect(await count('audit_events')).toBe(before.audit_events! + 1);
    expect(await count('role_permissions')).toBe(36);
    expect(await count('permissions')).toBe(29);
    for (const t of ['attendance_days', 'attendance_records', 'attendance_events'])
      expect(await count(t), t).toBe(0);
    const trg = await q(
      `select tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text like 'attendance\\_%' or tgname = 'school_years_guard_attendance_dates' order by 1`,
    );
    expect(trg.map((r) => r.tgname)).toEqual(
      expect.arrayContaining([
        'att_days_guard_insert',
        'att_days_guard_update',
        'att_days_no_delete',
        'att_events_no_update',
        'att_records_guard_insert',
        'att_records_guard_update',
        'school_years_guard_attendance_dates',
      ]),
    );
    // el propietario de todo lo nuevo es eta15_app y las funciones no son ejecutables por PUBLIC
    const owners = await q(
      `select distinct pg_get_userbyid(relowner) o from pg_class where relname in ('attendance_days','attendance_records','attendance_events')`,
    );
    expect(owners.map((r) => r.o)).toEqual(['eta15_app']);
    const open = await q(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'att%' and has_function_privilege('public', oid, 'EXECUTE')`,
    );
    expect(open).toEqual([]);
  });

  it('la matriz de asistencia queda como la politica aprobada (sin lectura global de trabajo social)', async () => {
    const m = await q(
      `select r.key || '|' || p.key || '|' || rp.scope k from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key like 'attendance:%' order by 1`,
    );
    expect(m.map((x) => x.k)).toEqual([
      'direccion|attendance:correct|all',
      'direccion|attendance:read|all',
      'prefectura|attendance:capture|assigned_groups',
      'prefectura|attendance:read|assigned_groups',
    ]);
  });

  it('el modulo funciona sobre los datos previos: abre una lista con el padron existente y la finaliza', async () => {
    let date = addDays(today, -10);
    while (![1, 2, 3, 4, 5].includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
      date = addDays(date, -1);
    await owner.query('begin');
    const day = (
      await q(
        `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4) returning id`,
        [year, group, date, boss],
      )
    )[0]!.id as string;
    for (const p of pupils)
      await q(
        `insert into attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id) values ($1, $2, $3, $4)`,
        [day, year, p.enrollment, p.assignment],
      );
    await owner.query('commit');
    await q(
      `update attendance_records set status = 'present', marked_by = $2 where attendance_day_id = $1`,
      [day, boss],
    );
    await q(
      `update attendance_days set status = 'finalized', finalized_by = $2, revision = revision + 1 where id = $1`,
      [day, boss],
    );
    expect((await q(`select status from attendance_days where id = $1`, [day]))[0]!.status).toBe(
      'finalized',
    );
    // y el historial escolar previo sigue siendo inmutable e independiente
    await expect(owner.query('delete from attendance_records')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('volver a ejecutar el SQL de la migracion falla (el DDL no es repetible): solo el migrador con su registro la aplica una vez', async () => {
    await expect(applyMigrations(owner, { from: 10 })).rejects.toMatchObject({ code: '42P07' });
  });
});
