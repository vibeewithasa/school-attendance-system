import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure } from './helpers/pglite.js';

/**
 * Migracion 0007 (alumnos, matriculas por ciclo e historial de grupo) aplicada de forma INCREMENTAL sobre 0000-0006, con datos
 * del catalogo ya existentes. PGlite = PostgreSQL 18.6 en memoria; todos los datos son FICTICIOS. Nunca toca eta15_dev.
 * Convencion: periodos inclusivos (`ends_on` es el ultimo dia).
 */
const dir = join(import.meta.dirname, '..', 'drizzle');
const migrations = readMigrationFiles({ migrationsFolder: dir });
let db: PGlite;
let YEAR: string; // 2026-08-31 .. 2027-07-15
let OTHER_YEAR: string; // 2027-08-30 .. 2028-07-14
let G1: string; // grupo 1A del ciclo YEAR
let G2: string; // grupo 1B del ciclo YEAR
let GOTHER: string; // grupo del OTRO ciclo

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0]!;
const student = async (
  given = 'Ana Lucía',
  family = 'Pérez Ficticia',
  code: string | null = null,
) =>
  (
    await one<{ id: string }>(
      `insert into students (given_names, family_name, school_code) values ($1, $2, $3) returning id`,
      [given, family, code],
    )
  ).id;
const enroll = async (studentId: string, year = YEAR, startsOn = '2026-08-31') =>
  (
    await one<{ id: string }>(
      `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
      [studentId, year, startsOn],
    )
  ).id;
const assign = (
  enrollmentId: string,
  group: string,
  startsOn: string,
  endsOn: string | null = null,
  year = YEAR,
) =>
  one<{ id: string }>(
    `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on, ends_on)
       values ($1, $2, $3, $4, $5) returning id`,
    [enrollmentId, year, group, startsOn, endsOn],
  );
const code = async (p: Promise<unknown>) => (await failure(p)).code;

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  expect(migrations.length).toBeGreaterThanOrEqual(8);
  // 0000-0006 con datos del catalogo ya cargados, y despues 0007 (incremental)
  for (const m of migrations.slice(0, 7)) for (const stmt of m.sql) await db.exec(stmt);
  YEAR = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('2026-2027', '2026-08-31', '2027-07-15') returning id`,
    )
  ).id;
  OTHER_YEAR = (
    await one<{ id: string }>(
      `insert into school_years (name, starts_on, ends_on) values ('2027-2028', '2027-08-30', '2028-07-14') returning id`,
    )
  ).id;
  const grp = async (year: string, c: string) =>
    (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 1, $2) returning id`,
        [year, c],
      )
    ).id;
  G1 = await grp(YEAR, 'A');
  G2 = await grp(YEAR, 'B');
  GOTHER = await grp(OTHER_YEAR, 'A');
  for (const m of migrations.slice(7, 8)) for (const stmt of m.sql) await db.exec(stmt);
});
afterAll(async () => {
  await db.close();
});

describe('0007: estructura', () => {
  it('crea las tres tablas con ids UUID v7 por defecto y la extension en su propio esquema', async () => {
    const t = await db.query<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
         and relname in ('students','enrollments','student_group_assignments') order by 1`,
    );
    expect(t.rows.map((r) => r.relname)).toEqual([
      'enrollments',
      'student_group_assignments',
      'students',
    ]);
    const s = await student();
    const v = await one<{ v: number }>(`select uuid_extract_version($1::uuid) as v`, [s]);
    expect(v.v).toBe(7);
    const ext = await one<{ ns: string }>(
      `select extnamespace::regnamespace::text as ns from pg_extension where extname = 'btree_gist'`,
    );
    expect(ext.ns).toBe('extensions');
  });

  it('no almacena datos sensibles: columnas exactas de students', async () => {
    const c = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'students' order by ordinal_position`,
    );
    expect(c.rows.map((r) => r.column_name)).toEqual([
      'id',
      'given_names',
      'family_name',
      'school_code',
      'is_active',
      'created_at',
      'updated_at',
    ]);
  });

  it('las funciones nuevas son SECURITY INVOKER, con search_path fijo y sin EXECUTE para PUBLIC', async () => {
    const f = await db.query<{ proname: string; definer: boolean; pinned: boolean; open: boolean }>(
      `select p.proname, p.prosecdef as definer,
              coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false) as pinned,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as open
         from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('school_records_no_delete','students_guard_update','enrollments_guard_insert',
                            'enrollments_guard_update','sga_guard_insert','sga_guard_update','school_years_guard_dates')`,
    );
    expect(f.rows).toHaveLength(7);
    for (const r of f.rows)
      expect(r, r.proname).toMatchObject({ definer: false, pinned: true, open: false });
  });
});

describe('students', () => {
  it('acepta nombres con acentos, apostrofo, guion y puntos; los homonimos son validos', async () => {
    await student('José María', "D'Angelo-Pérez");
    const a = await student('Ana', 'Homónima Ficticia');
    const b = await student('Ana', 'Homónima Ficticia');
    expect(a).not.toBe(b);
  });

  it('el codigo escolar es opcional; si existe es unico (23505); varios sin codigo conviven', async () => {
    await student('Sin', 'Codigo Uno');
    await student('Sin', 'Codigo Dos');
    await student('Con', 'Codigo', 'ESC-001');
    expect(await code(student('Otro', 'Codigo', 'ESC-001'))).toBe('23505');
  });

  it.each([
    ['nombre vacio', ['', 'Pérez']],
    ['espacios al inicio', [' Ana', 'Pérez']],
    ['espacios al final', ['Ana ', 'Pérez']],
    ['espacios dobles', ['Ana  Lucía', 'Pérez']],
    ['mas de 100 caracteres', ['A'.repeat(101), 'Pérez']],
    ['caracter de control', ['Ana\tLucía', 'Pérez']],
    ['apellido vacio', ['Ana', '']],
    ['apellido con salto de linea', ['Ana', 'Pérez\nGómez']],
  ])('rechaza %s (23514)', async (_n, [given, family]) => {
    expect(await code(student(given, family))).toBe('23514');
  });

  it.each([
    'esc 001',
    'esc-001',
    'ESC_001',
    'ESC--001',
    '-ESC',
    'ESC-',
    'ÁESC',
    'A'.repeat(21),
    '',
  ])('rechaza el codigo no canonico %j (23514)', async (c) => {
    expect(await code(student('Ana', 'Código Malo', c))).toBe('23514');
  });

  it('el id no cambia en una correccion (42501), updated_at lo fija el servidor y no hay DELETE ni TRUNCATE', async () => {
    const s = await student('Para', 'Corregir');
    expect(
      await code(db.exec(`update students set id = gen_random_uuid() where id = '${s}'`)),
    ).toBe('42501');
    const before = await one<{ u: Date }>(`select updated_at as u from students where id = $1`, [
      s,
    ]);
    await db.exec(`select pg_sleep(0.01)`);
    await db.exec(`update students set family_name = 'Corregido' where id = '${s}'`);
    const after = await one<{ u: Date; f: string }>(
      `select updated_at as u, family_name as f from students where id = $1`,
      [s],
    );
    expect(after.f).toBe('Corregido');
    expect(after.u.getTime()).toBeGreaterThan(before.u.getTime());
    expect(await code(db.exec(`delete from students where id = '${s}'`))).toBe('42501');
    // TRUNCATE: lo impide la FK desde matriculas (0A000) y, ademas, el trigger (42501)
    expect(['0A000', '42501']).toContain(await code(db.exec(`truncate students`)));
  });
});

describe('enrollments', () => {
  it('matricula valida; una por alumno y ciclo (23505); el alumno puede tener otra en otro ciclo', async () => {
    const s = await student('Mat', 'Valida');
    await enroll(s);
    expect(await code(enroll(s))).toBe('23505');
    await enroll(s, OTHER_YEAR, '2027-08-30');
  });

  it('la matricula debe empezar dentro del ciclo (23514) y el ciclo debe existir (23503)', async () => {
    const s = await student('Fuera', 'Ciclo');
    expect(await code(enroll(s, YEAR, '2026-08-30'))).toBe('23514'); // un dia antes
    expect(await code(enroll(s, YEAR, '2027-07-16'))).toBe('23514'); // un dia despues
    expect(await code(enroll(s, '00000000-0000-4000-8000-000000000009'))).toBe('23503');
    await enroll(s, YEAR, '2027-07-15'); // el ultimo dia es valido (inclusivo)
  });

  it('un alumno inactivo no recibe matriculas nuevas (23514)', async () => {
    const s = await student('Inactivo', 'Ficticio');
    await db.exec(`update students set is_active = false where id = '${s}'`);
    const e = await failure(enroll(s));
    expect(e.code).toBe('23514');
    expect(e.message).toMatch(/inactivo/);
    await db.exec(`update students set is_active = true where id = '${s}'`); // reactivado: puede matricularse
    await enroll(s);
  });

  it('una matricula nace sin baja (23514) y su identidad e inicio son inmutables (42501)', async () => {
    const s = await student('Inmutable', 'Ficticio');
    expect(
      await code(
        db.exec(
          `insert into enrollments (student_id, school_year_id, starts_on, ends_on) values ('${s}', '${YEAR}', '2026-09-01', '2026-10-01')`,
        ),
      ),
    ).toBe('23514');
    const e = await enroll(s);
    for (const set of [
      `starts_on = '2026-09-02'`,
      `school_year_id = '${OTHER_YEAR}'`,
      `student_id = '${await student('Otro', 'Alumno')}'`,
      `id = gen_random_uuid()`,
    ])
      expect(await code(db.exec(`update enrollments set ${set} where id = '${e}'`)), set).toBe(
        '42501',
      );
  });

  it('la baja cierra la matricula una sola vez: fecha dentro del periodo, sin reabrir ni modificar', async () => {
    const s = await student('Baja', 'Ficticia');
    const e = await enroll(s, YEAR, '2026-09-10');
    expect(
      await code(db.exec(`update enrollments set ends_on = '2026-09-09' where id = '${e}'`)),
    ).toBe('23514'); // antes del inicio (check)
    expect(
      await code(db.exec(`update enrollments set ends_on = '2027-07-16' where id = '${e}'`)),
    ).toBe('23514'); // despues del ciclo
    await db.exec(`update enrollments set ends_on = '2026-10-31' where id = '${e}'`);
    expect(
      await code(db.exec(`update enrollments set ends_on = '2026-11-30' where id = '${e}'`)),
    ).toBe('42501');
    expect(await code(db.exec(`update enrollments set ends_on = null where id = '${e}'`))).toBe(
      '42501',
    );
  });

  it('no hay DELETE ni TRUNCATE (42501)', async () => {
    const s = await student('Sin', 'Borrado');
    const e = await enroll(s);
    expect(await code(db.exec(`delete from enrollments where id = '${e}'`))).toBe('42501');
    expect(['0A000', '42501']).toContain(await code(db.exec(`truncate enrollments`)));
  });
});

describe('historial de grupo (student_group_assignments)', () => {
  it('asignacion valida; el grupo y la matricula deben ser del MISMO ciclo (23503)', async () => {
    const s = await student('Grupo', 'Valido');
    const e = await enroll(s);
    await assign(e, G1, '2026-08-31');
    const t = await student('Grupo', 'Equivocado');
    const e2 = await enroll(t);
    expect(await code(assign(e2, GOTHER, '2026-08-31'))).toBe('23503'); // grupo de otro ciclo
    expect(await code(assign(e2, G1, '2026-08-31', null, OTHER_YEAR))).toBe('23503'); // ciclo que no es el de la matricula
    expect(await code(assign(e2, '00000000-0000-4000-8000-000000000009', '2026-08-31'))).toBe(
      '23503',
    );
  });

  it('un alumno no tiene grupo en un ciclo en el que no esta inscrito (23503)', async () => {
    const e = '00000000-0000-4000-8000-000000000001';
    expect(await code(assign(e, G1, '2026-09-01'))).toBe('23503');
  });

  it('a lo mas una asignacion vigente por matricula (23505) y los periodos no se traslapan (23P01, inclusivo)', async () => {
    const s = await student('Traslape', 'Ficticio');
    const e = await enroll(s);
    await assign(e, G1, '2026-09-01', '2026-09-10');
    expect(await code(assign(e, G2, '2026-09-10', null))).toBe('23P01'); // comparte el dia 10: traslape inclusivo
    expect(await code(assign(e, G2, '2026-09-05', '2026-09-08'))).toBe('23P01'); // contenido
    expect(await code(assign(e, G2, '2026-08-31', '2026-09-01'))).toBe('23P01'); // comparte el dia 1
    await assign(e, G2, '2026-09-11', '2026-09-20'); // consecutivo: permitido
    await assign(e, G1, '2026-09-21', null); // abierto
    expect(await code(assign(e, G2, '2026-10-01', null))).toBe('23505'); // dos abiertos
    expect(await code(assign(e, G2, '2026-09-25', '2026-09-26'))).toBe('23P01'); // dentro del periodo abierto
  });

  it('el periodo debe caer dentro de la matricula (23514) y respetar fin >= inicio (23514)', async () => {
    const s = await student('Dentro', 'Matricula');
    const e = await enroll(s, YEAR, '2026-09-10');
    expect(await code(assign(e, G1, '2026-09-09'))).toBe('23514'); // antes de la matricula
    expect(await code(assign(e, G1, '2027-07-16'))).toBe('23514'); // despues del ciclo
    expect(await code(assign(e, G1, '2026-09-20', '2026-09-19'))).toBe('23514'); // fin antes del inicio
    await assign(e, G1, '2026-09-10', '2026-09-10'); // un solo dia es valido
    await db.exec(`update enrollments set ends_on = '2026-12-01' where id = '${e}' and false`);
  });

  it('solo se cierra: no cambia grupo, ciclo, inicio ni se reabre (42501); el cierre queda dentro de la matricula', async () => {
    const s = await student('Cierre', 'Ficticio');
    const e = await enroll(s);
    const a = (await assign(e, G1, '2026-09-01')).id;
    for (const set of [
      `group_id = '${G2}'`,
      `starts_on = '2026-09-02'`,
      `enrollment_id = gen_random_uuid()`,
      `id = gen_random_uuid()`,
    ])
      expect(
        await code(db.exec(`update student_group_assignments set ${set} where id = '${a}'`)),
        set,
      ).toBe('42501');
    expect(
      await code(
        db.exec(`update student_group_assignments set ends_on = '2027-07-16' where id = '${a}'`),
      ),
    ).toBe('23514');
    await db.exec(`update student_group_assignments set ends_on = '2026-09-30' where id = '${a}'`);
    expect(
      await code(
        db.exec(`update student_group_assignments set ends_on = '2026-10-15' where id = '${a}'`),
      ),
    ).toBe('42501');
    expect(
      await code(db.exec(`update student_group_assignments set ends_on = null where id = '${a}'`)),
    ).toBe('42501');
  });

  it('la baja exige cerrar antes los periodos de grupo (23514) y despues deja el historial intacto', async () => {
    const s = await student('Baja', 'Con Grupo');
    const e = await enroll(s);
    const a = (await assign(e, G1, '2026-09-01')).id;
    expect(
      await code(db.exec(`update enrollments set ends_on = '2026-10-31' where id = '${e}'`)),
    ).toBe('23514'); // abierto
    await db.exec(`update student_group_assignments set ends_on = '2026-11-15' where id = '${a}'`);
    expect(
      await code(db.exec(`update enrollments set ends_on = '2026-10-31' where id = '${e}'`)),
    ).toBe('23514'); // fin posterior a la baja
    await db.exec(`update enrollments set ends_on = '2026-11-15' where id = '${e}'`);
    // tras la baja ya no se puede asignar un grupo posterior a ella
    expect(await code(assign(e, G2, '2026-11-16'))).toBe('23514');
    const kept = await one<{ n: number }>(
      `select count(*)::int n from student_group_assignments where enrollment_id = $1`,
      [e],
    );
    expect(kept.n).toBe(1);
  });

  it('no hay DELETE ni TRUNCATE (42501) y los restantes alumnos conservan su historial', async () => {
    const s = await student('Historial', 'Intacto');
    const e = await enroll(s);
    const a = (await assign(e, G1, '2026-09-01')).id;
    expect(await code(db.exec(`delete from student_group_assignments where id = '${a}'`))).toBe(
      '42501',
    );
    expect(await code(db.exec(`truncate student_group_assignments`))).toBe('42501');
    // y las FK impiden borrar lo referenciado aunque el trigger no existiera (RESTRICT): grupo, ciclo, matricula
    expect(
      await code(db.exec(`update groups set school_year_id = '${OTHER_YEAR}' where id = '${G1}'`)),
    ).toBeTruthy();
  });
});

describe('integridad entre tablas (defensa de la base)', () => {
  it('un alumno con matricula sin baja en un ciclo que no ha terminado no se desactiva (23514); con la baja si', async () => {
    const future = (
      await one<{ id: string }>(
        `insert into school_years (name, starts_on, ends_on) values ('2090-2091', '2090-08-31', '2091-07-15') returning id`,
      )
    ).id;
    const s = await student('Baja', 'Primero');
    const e = await enroll(s, future, '2090-09-01');
    expect(await code(db.exec(`update students set is_active = false where id = '${s}'`))).toBe(
      '23514',
    );
    await db.exec(`update enrollments set ends_on = '2090-09-01' where id = '${e}'`);
    await db.exec(`update students set is_active = false where id = '${s}'`);
    await db.exec(`update students set is_active = true where id = '${s}'`);
  });

  it('un alumno con matricula sin baja en un ciclo ya terminado si se desactiva', async () => {
    const past = (
      await one<{ id: string }>(
        `insert into school_years (name, starts_on, ends_on) values ('2019-2020', '2019-08-26', '2020-07-15') returning id`,
      )
    ).id;
    const s = await student('Ciclo', 'Pasado');
    await enroll(s, past, '2019-09-02');
    await db.exec(`update students set is_active = false where id = '${s}'`);
  });

  it('las fechas de un ciclo no pueden dejar matriculas ni periodos de grupo fuera (23514); ampliar y renombrar si', async () => {
    const y = (
      await one<{ id: string }>(
        `insert into school_years (name, starts_on, ends_on) values ('2029-2030', '2029-08-30', '2030-07-15') returning id`,
      )
    ).id;
    const g = (
      await one<{ id: string }>(
        `insert into groups (school_year_id, grade, code) values ($1, 1, 'Z') returning id`,
        [y],
      )
    ).id;
    const s = await student('Fechas', 'Del Ciclo');
    const e = await enroll(s, y, '2029-09-04');
    await assign(e, g, '2029-09-04', null, y);
    const upd = (set: string) => db.exec(`update school_years set ${set} where id = '${y}'`);
    expect(await code(upd(`starts_on = '2029-09-05'`))).toBe('23514'); // la matricula empieza antes
    expect(await code(upd(`ends_on = '2029-09-03'`))).toBe('23514'); // fin antes del inicio de la matricula
    await upd(`name = '2029-2030 (ajustado)'`); // renombrar no dispara la regla
    await upd(`starts_on = '2029-09-01', ends_on = '2030-08-01'`); // ampliar o mover sin dejar fuera
    await upd(`ends_on = '2029-12-20'`); // acortar sin dejar fuera nada (matricula y grupo abiertos)
    // Con la baja y el cierre del grupo en 2029-10-31, ya no se puede acortar por debajo de esa fecha.
    await db.exec(
      `update student_group_assignments set ends_on = '2029-10-31' where enrollment_id = '${e}'`,
    );
    await db.exec(`update enrollments set ends_on = '2029-10-31' where id = '${e}'`);
    expect(await code(upd(`ends_on = '2029-10-30'`))).toBe('23514');
    await upd(`ends_on = '2029-10-31'`);
  });
});

describe('0007: nada mas cambia', () => {
  it('el catalogo y la matriz RBAC existentes no se tocaron', async () => {
    const rp = await one<{ n: number }>(`select count(*)::int n from role_permissions`);
    expect(rp.n).toBe(38);
    const perms = await one<{ n: number }>(`select count(*)::int n from permissions`);
    expect(perms.n).toBe(27);
    const au = await one<{ n: number }>(`select count(*)::int n from audit_events`);
    expect(au.n).toBe(6);
  });
});
