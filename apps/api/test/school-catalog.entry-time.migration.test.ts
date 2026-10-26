import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migracion incremental 0002 (groups.expected_entry_time) sobre PGlite (PostgreSQL 18.6 en memoria).
 * Reproduce el caso real: 0000 y 0001 ya aplicadas con grupos existentes y DESPUES se aplica 0002.
 * No usa eta15_dev. Ver limites en school-catalog.migration.test.ts.
 */
const dir = join(import.meta.dirname, '..', 'drizzle');
const migrations = readMigrationFiles({ migrationsFolder: dir });

let db: PGlite;
let year: string;

async function apply(index: number) {
  for (const stmt of migrations[index]!.sql) await db.exec(stmt);
}
async function addGroup(code: string, entry: string | null, shift: string | null = null) {
  await db.query(
    `insert into groups (school_year_id, grade, code, shift, expected_entry_time) values ($1,1,$2,$3,$4)`,
    [year, code, shift, entry],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await apply(0);
  await apply(1);
  const y = await db.query<{ id: string }>(
    `insert into school_years (name, starts_on, ends_on) values ('2025-2026','2025-08-25','2026-07-15') returning id`,
  );
  year = y.rows[0]!.id;
  // Grupos que ya existian antes de 0002
  await db.exec(
    `insert into groups (school_year_id, grade, code, shift) values ('${year}',1,'PRE1',null),('${year}',2,'PRE2','matutino')`,
  );
  await apply(2);
});
afterAll(async () => {
  await db.close();
});

describe('0002: groups.expected_entry_time', () => {
  it('conserva los grupos existentes y los deja con hora NULL (sin configurar)', async () => {
    const r = await db.query<{ code: string; t: string | null }>(
      `select code, expected_entry_time::text as t from groups order by code`,
    );
    expect(r.rows).toEqual([
      { code: 'PRE1', t: null },
      { code: 'PRE2', t: null },
    ]);
  });

  it('la columna es time(0) sin zona horaria y admite NULL', async () => {
    const r = await db.query<{ data_type: string; is_nullable: string; p: number }>(
      `select data_type, is_nullable, datetime_precision as p from information_schema.columns
       where table_name='groups' and column_name='expected_entry_time'`,
    );
    expect(r.rows[0]).toEqual({ data_type: 'time without time zone', is_nullable: 'YES', p: 0 });
  });

  it('acepta 07:00, 07:50 y cualquier otra hora configurable', async () => {
    await addGroup('H0700', '07:00');
    await addGroup('H0750', '07:50');
    await addGroup('H1305', '13:05');
    await addGroup('H0000', '00:00');
    await addGroup('H2359', '23:59');
    const r = await db.query<{ code: string; t: string }>(
      `select code, expected_entry_time::text as t from groups where code like 'H%' order by code`,
    );
    expect(r.rows.map((x) => x.t)).toEqual([
      '00:00:00',
      '07:00:00',
      '07:50:00',
      '13:05:00',
      '23:59:00',
    ]);
  });

  it('rechaza segundos distintos de cero (solo precision de minuto)', async () => {
    await expect(addGroup('XS30', '07:00:30')).rejects.toThrow(/expected_entry_time_minute/);
    await expect(addGroup('XS01', '07:50:01')).rejects.toThrow(/expected_entry_time_minute/);
    await expect(addGroup('XSMS', '07:00:00.5')).rejects.toThrow(
      /expected_entry_time_minute|expected_entry_time/,
    );
  });

  it('rechaza 24:00:00 y valores que no son hora', async () => {
    await expect(addGroup('X24', '24:00:00')).rejects.toThrow(/expected_entry_time_range/);
    await expect(addGroup('XBAD', '25:00')).rejects.toThrow();
    await expect(addGroup('XTXT', 'siete')).rejects.toThrow();
  });

  it('el turno y la hora de entrada son independientes', async () => {
    await addGroup('IND1', '07:00', 'matutino');
    await addGroup('IND2', '07:50', 'matutino');
    await addGroup('IND3', '07:00', null);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from groups where code in ('IND1','IND2','IND3')`,
    );
    expect(r.rows[0]!.n).toBe(3);
  });

  it('la unicidad del grupo NO depende de la hora de entrada', async () => {
    await addGroup('UNQ', '07:00');
    await expect(addGroup('UNQ', '07:50')).rejects.toThrow(/year_grade_code_shift_key/);
  });

  it('configurar la hora de un grupo existente es un UPDATE normal y actualiza updated_at', async () => {
    const before = (
      await db.query<{ u: string }>(`select updated_at::text u from groups where code='PRE1'`)
    ).rows[0]!.u;
    await new Promise((r) => setTimeout(r, 20));
    await db.query(`update groups set expected_entry_time = '07:50' where code='PRE1'`);
    const r = await db.query<{ t: string; u: string }>(
      `select expected_entry_time::text t, updated_at::text u from groups where code='PRE1'`,
    );
    expect(r.rows[0]!.t).toBe('07:50:00');
    expect(r.rows[0]!.u).not.toBe(before);
  });

  it('no se agregaron tablas nuevas (sigue habiendo solo school_years y groups)', async () => {
    const r = await db.query<{ t: string }>(
      `select tablename t from pg_tables where schemaname='public' order by 1`,
    );
    expect(r.rows.map((x) => x.t)).toEqual(['groups', 'school_years']);
  });
});
