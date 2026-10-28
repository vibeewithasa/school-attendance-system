import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destructiveStatements } from '../scripts/drizzle-guard.js';

/**
 * Aplica las migraciones de apps/api/drizzle sobre PostgreSQL EN MEMORIA (PGlite 0.5, que empaqueta
 * PostgreSQL 18.6 compilado a WASM de 32 bits). NO usa eta15_dev ni ningun servidor.
 * Valida la logica de constraints y triggers del SQL con el motor 18, incluido uuidv7() nativo.
 * Limitaciones: no es el servicio real de Windows (collation/locale del servidor, permisos de roles,
 * extensiones instaladas, concurrencia real entre sesiones y rendimiento no se prueban aqui) y
 * NO sustituye aplicar la migracion en eta15_dev (pendiente, requiere autorizacion).
 */
const dir = join(import.meta.dirname, '..', 'drizzle');

let db: PGlite;

async function addYear(name: string, s: string, e: string, active = false) {
  const r = await db.query<{ id: string }>(
    `insert into school_years (name, starts_on, ends_on, is_active) values ($1,$2,$3,$4) returning id`,
    [name, s, e, active],
  );
  return r.rows[0]!.id;
}
async function addGroup(yearId: string, grade: number, code: string, shift: string | null) {
  await db.query(`insert into groups (school_year_id, grade, code, shift) values ($1,$2,$3,$4)`, [
    yearId,
    grade,
    code,
    shift,
  ]);
}
async function updatedAt(table: string, id: string) {
  const r = await db.query<{ u: string }>(
    `select updated_at::text as u from ${table} where id=$1`,
    [id],
  );
  return r.rows[0]!.u;
}

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  const version = (
    await db.query<{ v: string }>(`select current_setting('server_version_num') as v`)
  ).rows[0]!.v;
  expect(Number(version)).toBeGreaterThanOrEqual(180000);
  const native = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_proc where proname = 'uuidv7'`,
  );
  expect(native.rows[0]!.n).toBeGreaterThan(0); // uuidv7() debe ser nativo, sin simulacion
  // Mismo lector que usa el migrador de Drizzle: respeta el journal y su orden.
  for (const migration of readMigrationFiles({ migrationsFolder: dir })) {
    for (const stmt of migration.sql) await db.exec(stmt);
  }
});
afterAll(async () => {
  await db.close();
});

describe('historial de migraciones de Drizzle', () => {
  const tags = [
    '0000_school_catalog',
    '0001_school_catalog_integrity',
    '0002_group_expected_entry_time',
    '0003_auth_schema',
    '0004_auth_seed_roles_permissions',
    '0005_auth_integrity',
    '0006_catalog_rbac_school_management',
    '0007_students_enrollments',
    '0008_students_rbac_policy',
    '0009_prefect_group_assignments',
    '0010_daily_attendance',
    '0011_mobile_device_auth',
  ];

  it('el journal registra todas las migraciones en orden, con marcas de tiempo crecientes', () => {
    const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual(tags.map((tag, i) => [i, tag]));
    // El migrador omite una migracion cuya marca no supere la ultima aplicada.
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
  });

  it('readMigrationFiles (el lector del migrador) encuentra todas con hash distinto', () => {
    const migrations = readMigrationFiles({ migrationsFolder: dir });
    expect(migrations).toHaveLength(tags.length);
    expect(new Set(migrations.map((m) => m.hash)).size).toBe(tags.length);
    expect(migrations[1]!.sql.join('\n')).toContain('school_years_no_overlap');
    expect(migrations[2]!.sql.join('\n')).toContain('expected_entry_time');
  });

  it('cada migracion del journal tiene su snapshot', () => {
    for (const tag of tags) {
      const n = tag.slice(0, 4);
      expect(() => readFileSync(join(dir, 'meta', `${n}_snapshot.json`))).not.toThrow();
    }
  });

  it('no contiene operaciones destructivas', () => {
    const sql = tags.map((tag) => readFileSync(join(dir, `${tag}.sql`), 'utf8')).join('\n');
    expect(destructiveStatements(sql)).toEqual([]);
  });
});
describe('school_years', () => {
  it('acepta un ciclo valido con id UUID', async () => {
    expect(await addYear('2025-2026', '2025-08-25', '2026-07-15')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('el id por defecto es UUID version 7', async () => {
    const r = await db.query<{ v: number }>(
      `select (get_byte(uuid_send(id), 6) >> 4) as v from school_years limit 1`,
    );
    expect(r.rows[0]!.v).toBe(7);
  });
  it('rechaza fin igual o anterior al inicio', async () => {
    await expect(addYear('X1', '2030-01-01', '2030-01-01')).rejects.toThrow(/dates_ordered/);
    await expect(addYear('X2', '2030-02-01', '2030-01-01')).rejects.toThrow(/dates_ordered/);
  });
  it('rechaza nombre vacio o con espacios en los bordes', async () => {
    await expect(addYear('', '2031-01-01', '2031-06-01')).rejects.toThrow(/name_not_blank/);
    await expect(addYear(' 2031 ', '2031-01-01', '2031-06-01')).rejects.toThrow(/name_not_blank/);
  });
  it('rechaza nombre duplicado', async () => {
    await expect(addYear('2025-2026', '2040-01-01', '2040-06-01')).rejects.toThrow(
      /school_years_name_key/,
    );
  });

  describe('traslape con fechas inclusivas', () => {
    it('rechaza empezar el mismo dia en que otro termina', async () => {
      await expect(addYear('T1', '2026-07-15', '2026-12-01')).rejects.toThrow(/no_overlap/);
    });
    it('rechaza terminar el mismo dia en que otro empieza', async () => {
      await expect(addYear('T2', '2025-06-01', '2025-08-25')).rejects.toThrow(/no_overlap/);
    });
    it('rechaza un ciclo contenido dentro de otro', async () => {
      await expect(addYear('T3', '2025-10-01', '2025-11-01')).rejects.toThrow(/no_overlap/);
    });
    it('rechaza un ciclo que envuelve a otro', async () => {
      await expect(addYear('T4', '2025-01-01', '2026-12-31')).rejects.toThrow(/no_overlap/);
    });
    it('acepta ciclos consecutivos (el dia siguiente al fin)', async () => {
      await expect(addYear('2026-2027', '2026-07-16', '2027-07-15')).resolves.toBeTypeOf('string');
    });
    it('acepta un ciclo anterior que termina el dia previo al inicio', async () => {
      await expect(addYear('2024-2025', '2024-08-26', '2025-08-24')).resolves.toBeTypeOf('string');
    });
  });

  describe('ciclo vigente', () => {
    it('permite varios ciclos futuros inactivos', async () => {
      await addYear('2030-2031', '2030-08-25', '2031-07-15');
      await addYear('2031-2032', '2031-08-25', '2032-07-15');
    });
    it('rechaza dos ciclos vigentes, tambien al insertar', async () => {
      await db.query(`update school_years set is_active = true where name = '2025-2026'`);
      await expect(
        db.query(`update school_years set is_active = true where name = '2026-2027'`),
      ).rejects.toThrow(/single_active/);
      await expect(addYear('2032-2033', '2032-08-25', '2033-07-15', true)).rejects.toThrow(
        /single_active/,
      );
    });
    it('permite relevar el ciclo vigente desactivando primero el anterior', async () => {
      await db.query(`update school_years set is_active = false where name = '2025-2026'`);
      await db.query(`update school_years set is_active = true where name = '2026-2027'`);
    });
  });
});

describe('groups', () => {
  let year: string;
  beforeAll(async () => {
    year = await addYear('2027-2028', '2027-08-25', '2028-07-15');
  });

  it('acepta grupos con y sin turno (turno NULL)', async () => {
    await addGroup(year, 1, 'A', null);
    await addGroup(year, 1, 'B', 'matutino');
  });
  it('acepta identificadores de varios caracteres, con digitos, espacio o guion, hasta 10', async () => {
    for (const code of ['1A', 'TEC-1', 'TEC 2', 'ABCDEFGHIJ']) await addGroup(year, 2, code, null);
  });
  it('rechaza grado fuera de 1 a 3', async () => {
    await expect(addGroup(year, 0, 'C', null)).rejects.toThrow(/grade_range/);
    await expect(addGroup(year, 4, 'C', null)).rejects.toThrow(/grade_range/);
  });
  it('rechaza identificadores no normalizados o invalidos', async () => {
    for (const bad of ['a', 'b ', ' B', 'A  B', 'A--B', '-A', 'A_B', 'ÁB', '']) {
      await expect(addGroup(year, 3, bad, null), `codigo ${JSON.stringify(bad)}`).rejects.toThrow(
        /groups_code_(format|length)/,
      );
    }
    await expect(addGroup(year, 3, 'ABCDEFGHIJK', null)).rejects.toThrow(
      /groups_code_(format|length)/,
    );
  });
  it('rechaza turnos desconocidos', async () => {
    await expect(addGroup(year, 1, 'C', 'nocturno')).rejects.toThrow(/shift_values/);
  });
  it('rechaza duplicados por ciclo, grado, identificador y turno (incluido turno NULL)', async () => {
    await expect(addGroup(year, 1, 'A', null)).rejects.toThrow(/year_grade_code_shift_key/);
    await expect(addGroup(year, 1, 'B', 'matutino')).rejects.toThrow(/year_grade_code_shift_key/);
  });
  it('permite el mismo identificador en otro turno, grado o ciclo', async () => {
    await addGroup(year, 1, 'B', 'vespertino');
    await addGroup(year, 2, 'A', null);
    const other = await addYear('2028-2029', '2028-08-25', '2029-07-15');
    await addGroup(other, 1, 'A', null);
  });
  it('rechaza un ciclo inexistente', async () => {
    await expect(addGroup('00000000-0000-7000-8000-000000000000', 1, 'Z', null)).rejects.toThrow(
      /groups_school_year_id_fkey/,
    );
  });
  it('impide borrar o cambiar el id de un ciclo con grupos (RESTRICT)', async () => {
    await expect(db.query(`delete from school_years where id = $1`, [year])).rejects.toThrow(
      /groups_school_year_id_fkey/,
    );
    await expect(
      db.query(`update school_years set id = gen_random_uuid() where id = $1`, [year]),
    ).rejects.toThrow(/groups_school_year_id_fkey/);
  });
  it('desactivar un ciclo y sus grupos conserva las filas y las referencias', async () => {
    await db.query(`update groups set is_active = false where school_year_id = $1`, [year]);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from groups where school_year_id=$1`,
      [year],
    );
    expect(r.rows[0]!.n).toBeGreaterThan(0);
  });
  it('agregar grupos o ciclos nuevos no altera los existentes', async () => {
    const before = await db.query(
      `select id, updated_at::text u from groups where school_year_id=$1 order by id`,
      [year],
    );
    await addYear('2040-2041', '2040-08-25', '2041-07-15');
    const after = await db.query(
      `select id, updated_at::text u from groups where school_year_id=$1 order by id`,
      [year],
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe('updated_at', () => {
  it('cambia en un UPDATE real y no en uno sin cambios (school_years)', async () => {
    const id = await addYear('2050-2051', '2050-08-25', '2051-07-15');
    const before = await updatedAt('school_years', id);
    await new Promise((r) => setTimeout(r, 20));
    await db.query(`update school_years set name = name where id = $1`, [id]);
    expect(await updatedAt('school_years', id)).toBe(before);
    await db.query(`update school_years set name = '2050-2051 rev' where id = $1`, [id]);
    expect(await updatedAt('school_years', id)).not.toBe(before);
  });
  it('cambia en un UPDATE real de groups', async () => {
    const id = await addYear('2060-2061', '2060-08-25', '2061-07-15');
    await addGroup(id, 1, 'A', null);
    const g = (
      await db.query<{ id: string }>(`select id from groups where school_year_id=$1`, [id])
    ).rows[0]!.id;
    const before = await updatedAt('groups', g);
    await new Promise((r) => setTimeout(r, 20));
    await db.query(`update groups set is_active = false where id = $1`, [g]);
    expect(await updatedAt('groups', g)).not.toBe(before);
  });
  it('la funcion del trigger fija su search_path', async () => {
    const r = await db.query<{ cfg: string[] | null; secdef: boolean }>(
      `select proconfig as cfg, prosecdef as secdef from pg_proc where proname = 'set_updated_at'`,
    );
    expect(r.rows[0]!.cfg).toEqual(['search_path=pg_catalog, pg_temp']);
    expect(r.rows[0]!.secdef).toBe(false);
  });
});
