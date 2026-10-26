import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Catalogo escolar. Ver docs/architecture/modelo-catalogo-escolar.md.
 *
 * Convenciones:
 * - Claves UUID v7 (uuidv7() de PostgreSQL 18): ordenables por tiempo y generables tambien en clientes offline.
 * - created_at / updated_at en timestamptz; updated_at lo mantiene un trigger (migracion 0001).
 * - Sin borrado fisico: se desactiva con is_active; las FK son ON DELETE RESTRICT.
 */

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const schoolYears = pgTable(
  'school_years',
  {
    id: id(),
    name: text('name').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    /** true = ciclo vigente. A lo mas uno a la vez (indice parcial unico). */
    isActive: boolean('is_active').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('school_years_name_key').on(t.name),
    check(
      'school_years_name_not_blank',
      sql`btrim(${t.name}) <> '' AND ${t.name} = btrim(${t.name})`,
    ),
    check('school_years_dates_ordered', sql`${t.endsOn} > ${t.startsOn}`),
    uniqueIndex('school_years_single_active_idx')
      .on(t.isActive)
      .where(sql`${t.isActive}`),
    // Ademas (migracion 0001, a mano): EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&)
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: id(),
    schoolYearId: uuid('school_year_id').notNull(),
    /** Grado de secundaria: 1, 2 o 3. */
    grade: smallint('grade').notNull(),
    /** Identificador del grupo (A, B, 1A, TEC-1...): 1 a 10 caracteres, ya normalizado (mayusculas ASCII, sin espacios en los bordes). */
    code: text('code').notNull(),
    /** Turno; NULL cuando la escuela no distingue turnos. */
    shift: text('shift'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'groups_school_year_id_fkey',
      columns: [t.schoolYearId],
      foreignColumns: [schoolYears.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('groups_grade_range', sql`${t.grade} BETWEEN 1 AND 3`),
    // Forma canonica: la BD rechaza lo no normalizado, asi el UNIQUE simple basta contra duplicados
    // por mayusculas/espacios (la API normaliza antes de insertar: normalizeGroupCode).
    check('groups_code_length', sql`char_length(${t.code}) BETWEEN 1 AND 10`),
    check('groups_code_format', sql`${t.code} ~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$'`),
    check('groups_shift_values', sql`${t.shift} IN ('matutino', 'vespertino')`),
    unique('groups_year_grade_code_shift_key')
      .on(t.schoolYearId, t.grade, t.code, t.shift)
      .nullsNotDistinct(),
    // Soporta la futura FK compuesta (id, school_year_id) desde matriculas.
    // La FK school_year_id queda indexada por el prefijo de groups_year_grade_code_shift_key.
    unique('groups_id_school_year_id_key').on(t.id, t.schoolYearId),
  ],
);

export type SchoolYear = typeof schoolYears.$inferSelect;
export type NewSchoolYear = typeof schoolYears.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
