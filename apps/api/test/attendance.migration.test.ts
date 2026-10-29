import { join } from 'node:path';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGlite as PGliteCtor } from '@electric-sql/pglite';
import type { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, bootstrap, grant } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';

/**
 * Migracion 0010 (asistencia diaria) en PGlite = PostgreSQL 18.6 en memoria, con todas las migraciones. Las reglas son de la BASE
 * (propietario); la API como rol no propietario, los privilegios por columna y la concurrencia real se prueban en el clúster
 * desechable (test/pgtemp/attendance.pg.test.ts). Datos FICTICIOS. Convencion: America/Mazatlan; solo lunes a viernes.
 */
let db: PGlite;
let today: string;
const addDays = (iso: string, d: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const isodow = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** Ultimo dia con ese dia de la semana (1 = lunes ... 7 = domingo) que sea al menos `minAgo` dias anterior a hoy. */
const lastDow = (dow: number, minAgo = 10) => {
  let d = addDays(today, -minAgo);
  while (isodow(d) !== dow) d = addDays(d, -1);
  return d;
};

const ids: Record<string, string> = {};
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0]!;
const num = async (sql: string, p: unknown[] = []) => Number((await one<{ n: number }>(sql, p)).n);

/** Error (SQLSTATE y CONSTRAINT) de una operacion que debe fallar. */
async function err(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
  throw new Error('Se esperaba un error y la operacion tuvo exito');
}

let seq = 0;
const alpha = (k: number) =>
  [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');

interface Pupil {
  student: string;
  enrollment: string;
  assignment: string;
}
/** Alumno ficticio con matricula en `year` desde `from` y, si se pide, asignacion de grupo (cerrada en `to`). */
async function pupil(opts: {
  year: string;
  group: string;
  from: string;
  groupTo?: string | null;
  enrollmentTo?: string | null;
}): Promise<Pupil> {
  seq += 1;
  const student = (
    await one<{ id: string }>(
      `insert into students (given_names, family_name) values ($1, 'Ficticia') returning id`,
      [`Alumno${alpha(seq)}`],
    )
  ).id;
  const enrollment = (
    await one<{ id: string }>(
      `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
      [student, opts.year, opts.from],
    )
  ).id;
  const assignment = (
    await one<{ id: string }>(
      `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
      [enrollment, opts.year, opts.group, opts.from],
    )
  ).id;
  if (opts.groupTo !== undefined && opts.groupTo !== null)
    await db.query(`update student_group_assignments set ends_on = $2 where id = $1`, [
      assignment,
      opts.groupTo,
    ]);
  if (opts.enrollmentTo)
    await db.query(`update enrollments set ends_on = $2 where id = $1`, [
      enrollment,
      opts.enrollmentTo,
    ]);
  return { student, enrollment, assignment };
}

/** Abre una lista como lo hace el servicio: lista y padron en UNA transaccion. Devuelve el id de la lista. */
async function openDay(
  group: string,
  date: string,
  pupils: Pupil[],
  year = ids.year!,
): Promise<string> {
  return db.transaction(async (tx) => {
    const day = (
      await tx.query<{ id: string }>(
        `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4) returning id`,
        [year, group, date, ids.p1],
      )
    ).rows[0]!.id;
    for (const p of pupils)
      await tx.query(
        `insert into attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id) values ($1, $2, $3, $4)`,
        [day, year, p.enrollment, p.assignment],
      );
    return day;
  });
}
const records = async (day: string) =>
  (
    await db.query<{ id: string; enrollment_id: string }>(
      `select id, enrollment_id from attendance_records where attendance_day_id = $1 order by id`,
      [day],
    )
  ).rows;

beforeAll(async () => {
  db = await freshDb();
  today = (
    await one<{ d: string }>(
      `select to_char((now() at time zone 'America/Mazatlan')::date, 'YYYY-MM-DD') d`,
    )
  ).d;
  ids.boss = await addUser(db, 'direccion.ficticia@escuela.test', 'school');
  await bootstrap(db, ids.boss, 'direccion');
  ids.p1 = await addUser(db, 'prefecta.uno@escuela.test', 'school');
  await grant(db, ids.p1, 'prefectura', ids.boss);
  ids.year = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('Ciclo asistencia', $1, $2) returning id`,
      [addDays(today, -400), addDays(today, 300)],
    )
  ).id;
  ids.oldYear = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('Ciclo anterior', $1, $2) returning id`,
      [addDays(today, -900), addDays(today, -401)],
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
  await grp('gOff', ids.year, 'OFF', false);
  await grp('gOld', ids.oldYear, 'A');
}, 60_000);
afterAll(async () => db.close());

describe('0010: estructura', () => {
  it('crea las tres tablas con UUID v7 y las restricciones esperadas', async () => {
    const d = lastDow(1);
    const p = await pupil({ year: ids.year!, group: ids.gA!, from: addDays(today, -300) });
    const day = await openDay(ids.gA!, d, [p]);
    const v = await one<{ v: string }>(
      `select substr(id::text, 15, 1) v from attendance_days where id = $1`,
      [day],
    );
    expect(v.v).toBe('7');
    const names = async (table: string) =>
      (
        await db.query<{ conname: string }>(
          `select conname from pg_constraint where conrelid = $1::regclass order by 1`,
          [table],
        )
      ).rows.map((r) => r.conname);
    expect(await names('attendance_days')).toEqual(
      expect.arrayContaining([
        'att_days_created_by_fkey',
        'att_days_finalized_by_fkey',
        'att_days_finalized_consistent',
        'att_days_group_date_key',
        'att_days_group_year_fkey',
        'att_days_id_school_year_id_key',
        'att_days_revision_positive',
        'att_days_school_year_fkey',
        'att_days_status',
        'att_days_weekday',
      ]),
    );
    expect(await names('attendance_records')).toEqual(
      expect.arrayContaining([
        'att_records_day_enrollment_key',
        'att_records_day_year_fkey',
        'att_records_enrollment_year_fkey',
        'att_records_group_assignment_fkey',
        'att_records_id_day_key',
        'att_records_marked_by_fkey',
        'att_records_marked_consistent',
        'att_records_status',
      ]),
    );
    expect(await names('attendance_events')).toEqual(
      expect.arrayContaining([
        'att_events_actor_fkey',
        'att_events_day_fkey',
        'att_events_hash_format',
        'att_events_record_day_fkey',
        'att_events_revision_positive',
        'att_events_shape',
        'att_events_type',
      ]),
    );
    // todo FK es RESTRICT: sin cascadas sobre el historial escolar
    const cascades = await num(
      `select count(*)::int n from pg_constraint where contype = 'f' and conname like 'att\\_%' and (confdeltype <> 'r' or confupdtype <> 'r')`,
    );
    expect(cascades).toBe(0);
  });

  it('la lista nace en borrador con revision 1 y el renglon nace pendiente', async () => {
    const d = lastDow(2);
    const p = await pupil({ year: ids.year!, group: ids.gB!, from: addDays(today, -300) });
    const day = await openDay(ids.gB!, d, [p]);
    expect(
      await one(
        `select status, revision, finalized_by, finalized_at from attendance_days where id = $1`,
        [day],
      ),
    ).toEqual({ status: 'draft', revision: 1, finalized_by: null, finalized_at: null });
    expect(
      await one(
        `select status, marked_by, marked_at from attendance_records where attendance_day_id = $1`,
        [day],
      ),
    ).toEqual({ status: null, marked_by: null, marked_at: null });
  });
});

describe('0010: fechas escolares (America/Mazatlan, solo lunes a viernes)', () => {
  it('lunes a viernes se aceptan (cualquier hora: la base no usa horarios)', async () => {
    for (const dow of [1, 2, 3, 4, 5]) {
      const d = lastDow(dow, 20);
      const g = (
        await one<{ id: string }>(
          `insert into groups (school_year_id, grade, code) values ($1, 2, $2) returning id`,
          [ids.year, `W${dow}`],
        )
      ).id;
      const p = await pupil({ year: ids.year!, group: g, from: addDays(today, -300) });
      const day = await openDay(g, d, [p]);
      expect(day).toBeTruthy();
    }
  });

  it('sabado y domingo se rechazan con la restriccion att_days_weekday, aunque el cliente los envie', async () => {
    for (const dow of [6, 7]) {
      const d = lastDow(dow, 20);
      const e = await err(
        db.query(
          `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)`,
          [ids.year, ids.gC, d, ids.p1],
        ),
      );
      expect([e.code, e.constraint], `dow ${dow}`).toEqual(['23514', 'att_days_weekday']);
    }
  });

  it('fecha futura, fuera del ciclo o de un ciclo ajeno al grupo: rechazadas', async () => {
    let future = addDays(today, 1);
    while (isodow(future) > 5) future = addDays(future, 1);
    const ins = (date: string, year = ids.year!, group = ids.gC!) =>
      db.query(
        `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)`,
        [year, group, date, ids.p1],
      );
    expect(await err(ins(future))).toMatchObject({
      code: '23514',
      constraint: 'att_days_not_future',
    });
    let before = addDays(today, -410);
    while (isodow(before) > 5) before = addDays(before, -1);
    expect(await err(ins(before))).toMatchObject({
      code: '23514',
      constraint: 'att_days_within_year',
    });
    // el grupo es de otro ciclo: la FK compuesta (group_id, school_year_id) lo impide
    let inOld = addDays(today, -450);
    while (isodow(inOld) > 5) inOld = addDays(inOld, -1);
    expect(await err(ins(inOld, ids.oldYear!, ids.gC!))).toMatchObject({
      code: '23503',
      constraint: 'att_days_group_year_fkey',
    });
  });

  it('un grupo inactivo no abre listas; una lista no nace finalizada ni con otra revision', async () => {
    const d = lastDow(3, 30);
    const base = (status: string, revision: number, group = ids.gC!) =>
      db.query(
        `insert into attendance_days (school_year_id, group_id, attendance_date, created_by, status, revision, finalized_by, finalized_at)
         values ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
        [
          ids.year,
          group,
          d,
          ids.p1,
          status,
          revision,
          status === 'finalized' ? ids.p1 : null,
          status === 'finalized' ? new Date() : null,
        ],
      );
    expect(await err(base('draft', 1, ids.gOff!))).toMatchObject({
      code: '23514',
      constraint: 'att_days_group_active',
    });
    expect(await err(base('finalized', 1))).toMatchObject({ constraint: 'att_days_born_draft' });
    expect(await err(base('draft', 5))).toMatchObject({ constraint: 'att_days_born_draft' });
  });

  it('el ciclo no puede acortarse dejando listas fuera; ampliarlo o renombrarlo si', async () => {
    // ciclo propio, lejano en el pasado, para no traslaparse con los demas
    const d = addDays(lastDow(4, 2000), 0);
    const dayYear = (
      await one<{ id: string }>(
        `insert into school_years (name, starts_on, ends_on) values ('Ciclo corto', $1, $2) returning id`,
        [addDays(d, -30), addDays(d, 5)],
      )
    ).id;
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 3, 'S') returning id`,
        [dayYear],
      )
    ).id;
    const p = await pupil({ year: dayYear, group: g, from: addDays(d, -20) });
    await openDay(g, d, [p], dayYear);
    const patch = (sql: string, params: unknown[]) => db.query(sql, params);
    expect(
      await err(
        patch(`update school_years set starts_on = $2 where id = $1`, [dayYear, addDays(d, 1)]),
      ),
    ).toMatchObject({ code: '23514', constraint: 'school_years_attendance_within' });
    expect(
      await err(
        patch(`update school_years set ends_on = $2 where id = $1`, [dayYear, addDays(d, -1)]),
      ),
    ).toMatchObject({ code: '23514', constraint: 'school_years_attendance_within' });
    await patch(`update school_years set ends_on = $2, name = 'Ciclo corto 2' where id = $1`, [
      dayYear,
      addDays(d, 9),
    ]);
  });
});

describe('0010: una lista por grupo y fecha', () => {
  it('UNIQUE (group_id, attendance_date) en la base; ON CONFLICT DO NOTHING no crea otra', async () => {
    const d = lastDow(1, 60);
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 3, 'U') returning id`,
        [ids.year],
      )
    ).id;
    const p = await pupil({ year: ids.year!, group: g, from: addDays(today, -300) });
    await openDay(g, d, [p]);
    const e = await err(openDay(g, d, [p]));
    expect([e.code, e.constraint]).toEqual(['23505', 'att_days_group_date_key']);
    const r = await db.query(
      `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)
       on conflict on constraint att_days_group_date_key do nothing returning id`,
      [ids.year, g, d, ids.p1],
    );
    expect(r.rows).toHaveLength(0);
    expect(await num(`select count(*)::int n from attendance_days where group_id = $1`, [g])).toBe(
      1,
    );
  });

  it('un grupo distinto o una fecha distinta SI pueden tener su propia lista', async () => {
    const g2 = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 3, 'V') returning id`,
        [ids.year],
      )
    ).id;
    const p = await pupil({ year: ids.year!, group: g2, from: addDays(today, -300) });
    await openDay(g2, lastDow(1, 70), [p]);
    await openDay(g2, lastDow(2, 70), [p]);
  });
});

describe('0010: padron del dia (matricula y grupo vigentes en la fecha de la lista)', () => {
  const D = () => lastDow(3, 15); // un miercoles reciente

  it('un alumno de otro grupo, ajeno o con la asignacion de otro dia no entra a la lista', async () => {
    const d = D();
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'P1') returning id`,
        [ids.year],
      )
    ).id;
    const other = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'P2') returning id`,
        [ids.year],
      )
    ).id;
    const mine = await pupil({ year: ids.year!, group: g, from: addDays(today, -300) });
    const stranger = await pupil({ year: ids.year!, group: other, from: addDays(today, -300) });
    // asignacion de OTRO grupo para la matricula ajena
    const e1 = await err(openDay(g, d, [mine, stranger]));
    expect([e1.code, e1.constraint]).toEqual(['23514', 'att_records_in_group']);
    // la asignacion es del alumno propio pero la matricula es de otro: no coinciden
    const e2 = await err(openDay(g, d, [{ ...mine, assignment: stranger.assignment }]));
    expect([e2.code, e2.constraint]).toEqual(['23514', 'att_records_in_group']);
    expect(await num(`select count(*)::int n from attendance_days where group_id = $1`, [g])).toBe(
      0,
    ); // la transaccion revirtio
  });

  it('ingreso posterior, traslado, baja (fin inclusivo) y alumno inactivo', async () => {
    const d = D();
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'P3') returning id`,
        [ids.year],
      )
    ).id;
    const dest = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'P4') returning id`,
        [ids.year],
      )
    ).id;
    const base = addDays(today, -300);
    const stays = await pupil({ year: ids.year!, group: g, from: base });
    const joinsLater = await pupil({ year: ids.year!, group: g, from: addDays(d, 1) });
    const leftBefore = await pupil({
      year: ids.year!,
      group: g,
      from: base,
      groupTo: addDays(d, -1),
      enrollmentTo: addDays(d, -1),
    });
    const leavesToday = await pupil({
      year: ids.year!,
      group: g,
      from: base,
      groupTo: d,
      enrollmentTo: d,
    });
    // traslado: estuvo en `g` hasta d-1 y desde d esta en `dest`
    const moved = await pupil({ year: ids.year!, group: g, from: base, groupTo: addDays(d, -1) });
    const movedNew = (
      await one<{ id: string }>(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
        [moved.enrollment, ids.year, dest, d],
      )
    ).id;
    const inactive = await pupil({
      year: ids.year!,
      group: g,
      from: base,
      groupTo: addDays(today, -1),
      enrollmentTo: addDays(today, -1),
    });
    await db.query(`update students set is_active = false where id = $1`, [inactive.student]);

    const rej = async (p: Pupil, group = g) => (await err(openDay(group, d, [p]))).constraint;
    expect(await rej(joinsLater)).toBe('att_records_enrollment_current'); // entra al ciclo despues
    expect(await rej(leftBefore)).toBe('att_records_enrollment_current'); // baja el dia anterior
    expect(await rej(moved)).toBe('att_records_in_group'); // su asignacion a `g` termino el dia anterior
    expect(await rej(inactive)).toBe('att_records_enrollment_current'); // alumno inactivo
    // Si pasan: permanece, y el ultimo dia (fin inclusivo) de la baja
    const day = await openDay(g, d, [stays, leavesToday]);
    expect((await records(day)).length).toBe(2);
    // el trasladado pertenece al destino ese mismo dia, y aun a `g` en un dia anterior
    const dayDest = await openDay(dest, d, [{ ...moved, assignment: movedNew }]);
    expect((await records(dayDest)).length).toBe(1);
    const before = lastDow(1, 40);
    const dayBefore = await openDay(g, before, [moved]);
    expect((await records(dayBefore)).length).toBe(1);
  });

  it('dos ciclos: la matricula debe ser del ciclo de la lista (FK compuesta); un alumno con dos matriculas usa cada una en su ciclo', async () => {
    const seqStudent = (
      await one<{ id: string }>(
        `insert into students (given_names, family_name) values ('Dosciclos', 'Ficticia') returning id`,
      )
    ).id;
    const enrOld = (
      await one<{ id: string }>(
        `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
        [seqStudent, ids.oldYear, addDays(today, -880)],
      )
    ).id;
    const asgOld = (
      await one<{ id: string }>(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
        [enrOld, ids.oldYear, ids.gOld, addDays(today, -880)],
      )
    ).id;
    await db.query(`update student_group_assignments set ends_on = $2 where id = $1`, [
      asgOld,
      addDays(today, -405),
    ]);
    await db.query(`update enrollments set ends_on = $2 where id = $1`, [
      enrOld,
      addDays(today, -405),
    ]);
    const enrNew = (
      await one<{ id: string }>(
        `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
        [seqStudent, ids.year, addDays(today, -390)],
      )
    ).id;
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 3, 'Y2') returning id`,
        [ids.year],
      )
    ).id;
    const asgNew = (
      await one<{ id: string }>(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
        [enrNew, ids.year, g, addDays(today, -390)],
      )
    ).id;
    const d = lastDow(3, 25);
    // la matricula del ciclo anterior en una lista del ciclo actual: el trigger la rechaza (no esta vigente ese dia) ...
    const wrong = await err(
      openDay(g, d, [{ student: seqStudent, enrollment: enrOld, assignment: asgOld }]),
    );
    expect([wrong.code, wrong.constraint]).toEqual(['23514', 'att_records_enrollment_current']);
    // ... y, aunque el trigger se desactivara (solo el propietario puede), la FK compuesta tambien lo impide
    await db.exec(`alter table attendance_records disable trigger att_records_guard_insert`);
    try {
      const viaFk = await err(
        openDay(g, d, [{ student: seqStudent, enrollment: enrOld, assignment: asgOld }]),
      );
      expect([viaFk.code, viaFk.constraint]).toEqual(['23503', 'att_records_enrollment_year_fkey']);
    } finally {
      await db.exec(`alter table attendance_records enable trigger att_records_guard_insert`);
    }
    const ok = await openDay(g, d, [
      { student: seqStudent, enrollment: enrNew, assignment: asgNew },
    ]);
    expect((await records(ok))[0]!.enrollment_id).toBe(enrNew);
  });

  it('padron CONGELADO: despues de abrir la lista no se agregan alumnos, ni siquiera elegibles', async () => {
    const d = lastDow(4, 15);
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'P5') returning id`,
        [ids.year],
      )
    ).id;
    const a = await pupil({ year: ids.year!, group: g, from: addDays(today, -300) });
    const late = await pupil({ year: ids.year!, group: g, from: addDays(today, -300) });
    const day = await openDay(g, d, [a]);
    const e = await err(
      db.query(
        `insert into attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id) values ($1, $2, $3, $4)`,
        [day, ids.year, late.enrollment, late.assignment],
      ),
    );
    expect([e.code, e.constraint]).toEqual(['23514', 'att_records_roster_frozen']);
    // un cambio posterior del padron (traslado del alumno) NO altera los renglones capturados
    await db.query(`update student_group_assignments set ends_on = $2 where id = $1`, [
      a.assignment,
      addDays(today, -1),
    ]);
    expect(
      await num(`select count(*)::int n from attendance_records where attendance_day_id = $1`, [
        day,
      ]),
    ).toBe(1);
  });

  it('un alumno una sola vez por lista; un renglon no nace marcado', async () => {
    const d = lastDow(5, 15);
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 2, 'P6') returning id`,
        [ids.year],
      )
    ).id;
    const a = await pupil({ year: ids.year!, group: g, from: addDays(today, -300) });
    const dup = await err(openDay(g, d, [a, a]));
    expect([dup.code, dup.constraint]).toEqual(['23505', 'att_records_day_enrollment_key']);
    const marked = await err(
      db.transaction(async (tx) => {
        const day = (
          await tx.query<{ id: string }>(
            `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4) returning id`,
            [ids.year, g, d, ids.p1],
          )
        ).rows[0]!.id;
        await tx.query(
          `insert into attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id, status, marked_by, marked_at)
           values ($1, $2, $3, $4, 'present', $5, now())`,
          [day, ids.year, a.enrollment, a.assignment, ids.p1],
        );
      }),
    );
    expect(marked).toMatchObject({ code: '23514', constraint: 'att_records_born_pending' });
  });
});

describe('0010: estados, finalizacion e historial', () => {
  let g = '';
  let d = '';
  let day = '';
  let recs: Array<{ id: string; enrollment_id: string }> = [];
  beforeAll(async () => {
    g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 3, 'F1') returning id`,
        [ids.year],
      )
    ).id;
    d = lastDow(2, 15);
    const ps = [
      await pupil({ year: ids.year!, group: g, from: addDays(today, -300) }),
      await pupil({ year: ids.year!, group: g, from: addDays(today, -300) }),
    ];
    day = await openDay(g, d, ps);
    recs = await records(day);
  });
  const mark = (id: string, status: string | null, by: string | null = ids.p1!) =>
    db.query(`update attendance_records set status = $2, marked_by = $3 where id = $1`, [
      id,
      status,
      by,
    ]);
  const bump = (id: string) =>
    db.query(`update attendance_days set revision = revision + 1 where id = $1`, [id]);

  it('solo present o absent; el trigger fija marked_at; pendiente -> marcado -> otro valor, nunca de vuelta a pendiente', async () => {
    expect(await err(mark(recs[0]!.id, 'late'))).toMatchObject({
      code: '23514',
      constraint: 'att_records_status',
    });
    await mark(recs[0]!.id, 'present');
    const first = await one<{ marked_at: Date; marked_by: string }>(
      `select marked_at, marked_by from attendance_records where id = $1`,
      [recs[0]!.id],
    );
    expect(first.marked_by).toBe(ids.p1);
    expect(first.marked_at).toBeInstanceOf(Date);
    await mark(recs[0]!.id, 'absent');
    expect(await err(mark(recs[0]!.id, null, null))).toMatchObject({
      code: '23514',
      constraint: 'att_records_no_unmark',
    });
    // marcar sin registrar quien: rechazado
    expect(await err(mark(recs[1]!.id, 'present', null))).toMatchObject({ code: '23514' });
    // el cliente no elige la hora: marked_at no se modifica por si solo y el trigger lo sobreescribe al cambiar el estado
    expect(
      await err(
        db.query(
          `update attendance_records set marked_at = now() - interval '5 days' where id = $1`,
          [recs[0]!.id],
        ),
      ),
    ).toMatchObject({ code: '42501' });
    await db.query(
      `update attendance_records set status = 'present', marked_by = $2, marked_at = now() - interval '5 days' where id = $1`,
      [recs[0]!.id, ids.p1],
    );
    const forged = await one<{ ago: number }>(
      `select extract(epoch from (now() - marked_at))::int ago from attendance_records where id = $1`,
      [recs[0]!.id],
    );
    expect(forged.ago).toBeLessThan(60);
  });

  it('la identidad del renglon y de la lista es inmutable', async () => {
    const others: Record<string, string> = {
      attendance_day_id: (
        await one<{ v: string }>(`select id::text v from attendance_days where id <> $1 limit 1`, [
          day,
        ])
      ).v,
      enrollment_id: (
        await one<{ v: string }>(`select id::text v from enrollments where id <> $1 limit 1`, [
          recs[0]!.enrollment_id,
        ])
      ).v,
      group_assignment_id: (
        await one<{ v: string }>(
          `select id::text v from student_group_assignments
            where id <> (select group_assignment_id from attendance_records where id = $1) limit 1`,
          [recs[0]!.id],
        )
      ).v,
    };
    for (const [col, value] of Object.entries(others)) {
      const e = await err(
        db.query(`update attendance_records set ${col} = $2 where id = $1`, [recs[0]!.id, value]),
      );
      expect(e.code, col).toBe('42501');
    }
    for (const sql of [
      `update attendance_days set attendance_date = attendance_date - 1 where id = $1`,
      `update attendance_days set group_id = (select id from groups where id <> attendance_days.group_id limit 1) where id = $1`,
      `update attendance_days set created_by = (select id from users where id <> created_by limit 1) where id = $1`,
    ])
      expect((await err(db.query(sql, [day]))).code, sql).toBe('42501');
  });

  it('la revision avanza de uno en uno; no se finaliza con pendientes ni sin renglones', async () => {
    expect(
      await err(
        db.query(`update attendance_days set revision = revision + 2 where id = $1`, [day]),
      ),
    ).toMatchObject({
      constraint: 'att_days_revision_step',
    });
    expect(
      await err(db.query(`update attendance_days set revision = revision where id = $1`, [day])),
    ).toMatchObject({
      constraint: 'att_days_revision_step',
    });
    await bump(day);
    expect(await num(`select revision n from attendance_days where id = $1`, [day])).toBe(2);
    const fin = (id: string) =>
      db.query(
        `update attendance_days set status = 'finalized', finalized_by = $2, revision = revision + 1 where id = $1`,
        [id, ids.p1],
      );
    // un renglon sigue pendiente (recs[1])
    expect(await err(fin(day))).toMatchObject({ code: '23514', constraint: 'att_days_no_pending' });
    // una lista sin renglones tampoco se finaliza
    const emptyDay = (
      await one<{ id: string }>(
        `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4) returning id`,
        [ids.year, g, lastDow(1, 90), ids.p1],
      )
    ).id;
    expect(await err(fin(emptyDay))).toMatchObject({
      code: '23514',
      constraint: 'att_days_not_empty',
    });
    // sin quien finalizo: la restriccion de consistencia
    await mark(recs[1]!.id, 'present');
    expect(
      await err(
        db.query(
          `update attendance_days set status = 'finalized', revision = revision + 1 where id = $1`,
          [day],
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'att_days_finalized_consistent' });
    expect(
      await err(db.query(`update attendance_days set status = 'cerrada' where id = $1`, [day])),
    ).toBeTruthy();
  });

  it('finalizar fija finalized_at con la hora del servidor; despues nada se modifica y no hay vuelta atras', async () => {
    await db.query(
      `update attendance_days set status = 'finalized', finalized_by = $2, finalized_at = now() - interval '9 days', revision = revision + 1 where id = $1`,
      [day, ids.p1],
    );
    const row = await one<{ ago: number; status: string; revision: number }>(
      `select extract(epoch from (now() - finalized_at))::int ago, status, revision from attendance_days where id = $1`,
      [day],
    );
    expect(row.ago).toBeLessThan(60);
    expect([row.status, row.revision]).toEqual(['finalized', 3]); // 1 (apertura) + 1 (guardado) + 1 (finalizacion)
    for (const sql of [
      `update attendance_days set status = 'draft', finalized_by = null, finalized_at = null where id = $1`,
      `update attendance_days set revision = revision + 1 where id = $1`,
      `update attendance_days set finalized_by = (select id from users where id <> finalized_by limit 1) where id = $1`,
    ])
      expect((await err(db.query(sql, [day]))).code, sql).toBe('42501');
    expect((await err(mark(recs[0]!.id, 'absent'))).code).toBe('42501');
    expect((await err(mark(recs[1]!.id, 'present'))).code).toBe('42501'); // aun con el mismo valor: la lista es historia
    expect(
      await num(
        `select count(*)::int n from attendance_records where attendance_day_id = $1 and status is null`,
        [day],
      ),
    ).toBe(0);
  });

  it('historial: forma estricta, idempotencia por solicitud y renglon de la misma lista; solo se agrega', async () => {
    const hash = 'a'.repeat(64);
    const ev = (type: string, extra: Record<string, unknown> = {}) =>
      db.query(
        `insert into attendance_events (attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          extra.day ?? day,
          extra.record ?? null,
          type,
          ids.p1,
          extra.request ?? null,
          extra.hash ?? null,
          extra.old ?? null,
          extra.new ?? null,
          extra.rev ?? 2,
        ],
      );
    const rid = '00000000-0000-4000-8000-0000000000a1';
    await ev('day_opened', { rev: 1 });
    expect(await err(ev('day_opened', { rev: 1 }))).toMatchObject({
      code: '23505',
      constraint: 'att_events_once_idx',
    });
    expect(await err(ev('mark_changed'))).toMatchObject({
      code: '23514',
      constraint: 'att_events_shape',
    }); // sin renglon ni solicitud
    expect(
      await err(ev('mark_changed', { record: recs[0]!.id, request: rid, hash, new: 'late' })),
    ).toMatchObject({ constraint: 'att_events_shape' });
    expect(
      await err(
        ev('mark_changed', { record: recs[0]!.id, request: rid, hash: 'xyz', new: 'present' }),
      ),
    ).toMatchObject({ constraint: 'att_events_hash_format' });
    expect(await err(ev('day_finalized', { new: 'present', rev: 4 }))).toMatchObject({
      constraint: 'att_events_shape',
    });
    await ev('mark_changed', {
      record: recs[0]!.id,
      request: rid,
      hash,
      new: 'present',
      old: null,
    });
    expect(
      await err(
        ev('mark_changed', {
          record: recs[0]!.id,
          request: rid,
          hash,
          new: 'absent',
          old: 'present',
          rev: 3,
        }),
      ),
    ).toMatchObject({
      code: '23505',
      constraint: 'att_events_request_record_idx',
    });
    // el renglon de OTRA lista no cuelga de esta
    const otherDay = (
      await one<{ id: string }>(`select id from attendance_days where id <> $1 limit 1`, [day])
    ).id;
    expect(
      await err(
        ev('mark_changed', {
          day: otherDay,
          record: recs[0]!.id,
          request: '00000000-0000-4000-8000-0000000000a2',
          hash,
          new: 'present',
        }),
      ),
    ).toMatchObject({ code: '23503', constraint: 'att_events_record_day_fkey' });
    await ev('day_finalized', { rev: 4 });
    // solo se agrega
    expect((await err(db.query(`update attendance_events set new_status = 'absent'`))).code).toBe(
      '42501',
    );
    expect(
      (await err(db.query(`update attendance_events set revision_after = revision_after`))).code,
    ).toBe('42501');
  });

  it('sin borrado fisico ni TRUNCATE en ninguna tabla, tampoco para el propietario; el historial de cada tabla se conserva', async () => {
    for (const t of ['attendance_days', 'attendance_records', 'attendance_events']) {
      expect((await err(db.query(`delete from ${t}`))).code, `delete ${t}`).toBe('42501');
      expect((await err(db.query(`truncate ${t} cascade`))).code, `truncate ${t}`).toBe('42501');
    }
    // las FK son RESTRICT: ni siquiera borrar un grupo con listas es posible
    expect((await err(db.query(`delete from groups where id = $1`, [g]))).code).toBeTruthy();
    expect(await num(`select count(*)::int n from attendance_days`)).toBeGreaterThan(5);
  });
});

describe('0010: RBAC incremental (de 0009 a 0010)', () => {
  const dir = join(import.meta.dirname, '..', 'drizzle');
  const migrations = readMigrationFiles({ migrationsFolder: dir });
  async function dbUntil(count: number): Promise<PGlite> {
    const d = new PGliteCtor({ extensions: { btree_gist } });
    for (const m of migrations.slice(0, count)) for (const stmt of m.sql) await d.exec(stmt);
    return d;
  }
  const matrix = async (d: PGlite) =>
    (
      await d.query<{ role: string; permission: string; scope: string }>(
        `select r.key as role, p.key as permission, rp.scope from role_permissions rp
           join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
          where p.key like 'attendance:%' or p.key like 'justifications:%' order by 1, 2`,
      )
    ).rows.map((x) => `${x.role}|${x.permission}|${x.scope}`);
  const count = async (d: PGlite, table: string) =>
    Number((await d.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0]!.n);

  it('lleva la marca destructiva limitada a su unico DELETE y no toca nada mas del RBAC', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(11); // 0010 y las posteriores
    const raw = migrations[10]!.sql.join('\n');
    expect(raw.split('\n')[0]).toBe('-- eta15:allow-destructive');
    const sql = raw
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE TABLE\b|\bALTER TABLE\b.*\bDROP\b/i);
    expect(sql).not.toMatch(/INSERT INTO "(permissions|role_permissions|roles)"/);
  });

  it('antes de aplicarla trabajo social conserva la lectura GLOBAL de asistencia (la brecha); despues solo queda lo aprobado', async () => {
    const d = await dbUntil(10);
    const before = await matrix(d);
    expect(before).toContain('trabajo_social|attendance:read|all');
    const rpBefore = await count(d, 'role_permissions');
    const permsBefore = await count(d, 'permissions');
    const a0 = await count(d, 'audit_events');
    expect([rpBefore, permsBefore]).toEqual([37, 29]);
    for (const stmt of migrations[10]!.sql) await d.exec(stmt);
    const after = await matrix(d);
    expect(before.filter((x) => !after.includes(x))).toEqual([
      'trabajo_social|attendance:read|all',
    ]);
    expect(after.filter((x) => !before.includes(x))).toEqual([]);
    expect(after).toEqual([
      'direccion|attendance:correct|all',
      'direccion|attendance:read|all',
      'direccion|justifications:read|all',
      'prefectura|attendance:capture|assigned_groups',
      'prefectura|attendance:read|assigned_groups',
      'prefectura|justifications:read|assigned_groups',
      'trabajo_social|justifications:manage|all',
      'trabajo_social|justifications:read|all',
    ]);
    expect(await count(d, 'role_permissions')).toBe(36);
    expect(await count(d, 'permissions')).toBe(29); // el permiso sigue definido
    expect(await count(d, 'audit_events')).toBe(a0 + 1); // la baja queda auditada
    const last = await d.query<{ event_type: string; actor_user_id: string | null }>(
      `select event_type, actor_user_id from audit_events order by occurred_at desc, id desc limit 1`,
    );
    expect(last.rows[0]).toEqual({ event_type: 'role.permissions_changed', actor_user_id: null });
    // Idempotente: repetir la parte RBAC no cambia ni la matriz ni la auditoria.
    const stmts = migrations[10]!.sql;
    const from = stmts.findIndex((x) => x.includes('DELETE FROM "role_permissions"'));
    for (const stmt of stmts.slice(from)) await d.exec(stmt);
    expect(await matrix(d)).toEqual(after);
    expect(await count(d, 'audit_events')).toBe(a0 + 1);
    await d.close();
  });

  it('un tercero no puede reconceder asistencia global a trabajo social desde la API (role_permissions solo se escribe por migracion)', async () => {
    // la semilla del codigo es la fuente: trabajo_social no tiene attendance:* en el catalogo
    const { ROLES } = await import('../src/modules/access-control/catalog.js');
    const ts = ROLES.find((r) => r.key === 'trabajo_social')!;
    expect(ts.grants.filter((x) => x.permission.startsWith('attendance:'))).toEqual([]);
    expect(ts.grants.map((x) => x.permission).sort()).toEqual([
      'justifications:manage',
      'justifications:read',
    ]);
  });
});
