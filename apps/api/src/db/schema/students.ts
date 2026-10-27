import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './_columns.js';
import { groups, schoolYears } from './school-catalog.js';

/**
 * Alumnos, matriculas por ciclo e historial de grupo. Ver docs/architecture/modelo-alumnos-matriculas.md.
 *
 * Convenciones: UUID v7; sin borrado fisico (FK RESTRICT + triggers que impiden DELETE); fechas de calendario con periodos
 * INCLUSIVOS (`ends_on` es el ultimo dia). Datos minimos de menores: solo nombre, apellidos y codigo escolar opcional.
 */

const NAME_RULE = (col: string) =>
  `${col} = btrim(${col}) AND ${col} !~ '\\s{2,}' AND ${col} !~ '[[:cntrl:]]' AND char_length(${col}) BETWEEN 1 AND 100`;

/** Identidad permanente del alumno, independiente de sus inscripciones. NO es una cuenta de acceso. */
export const students = pgTable(
  'students',
  {
    id: id(),
    givenNames: text('given_names').notNull(),
    familyName: text('family_name').notNull(),
    /** Identificador administrativo opcional (no es secreto ni credencial): mayusculas ASCII, digitos y guiones. */
    schoolCode: text('school_code'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check('students_given_names_clean', sql.raw(NAME_RULE('"students"."given_names"'))),
    check('students_family_name_clean', sql.raw(NAME_RULE('"students"."family_name"'))),
    check(
      'students_school_code_format',
      sql`${t.schoolCode} ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' AND char_length(${t.schoolCode}) BETWEEN 1 AND 20`,
    ),
    // NULLs distintos: varios alumnos pueden no tener codigo; si lo tienen, es unico.
    unique('students_school_code_key').on(t.schoolCode),
    // Dos alumnos pueden llamarse igual: el nombre NUNCA es clave. Este indice solo ordena los listados.
    index('students_name_idx').on(t.familyName, t.givenNames, t.id),
  ],
);

/** Inscripcion de un alumno en un ciclo. A lo mas una por alumno y ciclo; el grupo vive aparte (historial). */
export const enrollments = pgTable(
  'enrollments',
  {
    id: id(),
    studentId: uuid('student_id').notNull(),
    schoolYearId: uuid('school_year_id').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Ultimo dia inscrito (inclusivo). NULL = sin baja: dura hasta el fin del ciclo. Solo pasa de NULL a una fecha (baja). */
    endsOn: date('ends_on', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'enrollments_student_id_fkey',
      columns: [t.studentId],
      foreignColumns: [students.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'enrollments_school_year_id_fkey',
      columns: [t.schoolYearId],
      foreignColumns: [schoolYears.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('enrollments_dates_ordered', sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`),
    // Una inscripcion por alumno y ciclo (tambien indexa la busqueda por alumno).
    unique('enrollments_student_year_key').on(t.studentId, t.schoolYearId),
    // Soporta la FK compuesta (enrollment_id, school_year_id) desde el historial de grupos.
    unique('enrollments_id_school_year_id_key').on(t.id, t.schoolYearId),
    index('enrollments_school_year_idx').on(t.schoolYearId),
  ],
);

/**
 * Historial de grupo de una matricula. `school_year_id` se repite a proposito (redundancia CONTROLADA): permite dos FK
 * compuestas que obligan a que la matricula Y el grupo pertenezcan al MISMO ciclo, sin triggers.
 */
export const studentGroupAssignments = pgTable(
  'student_group_assignments',
  {
    id: id(),
    enrollmentId: uuid('enrollment_id').notNull(),
    schoolYearId: uuid('school_year_id').notNull(),
    groupId: uuid('group_id').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Ultimo dia en el grupo (inclusivo). NULL = vigente. Solo pasa de NULL a una fecha (cierre por traslado o baja). */
    endsOn: date('ends_on', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'sga_enrollment_year_fkey',
      columns: [t.enrollmentId, t.schoolYearId],
      foreignColumns: [enrollments.id, enrollments.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'sga_group_year_fkey',
      columns: [t.groupId, t.schoolYearId],
      foreignColumns: [groups.id, groups.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('sga_dates_ordered', sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`),
    // A lo mas UNA asignacion vigente (sin fin) por matricula.
    uniqueIndex('sga_single_open_idx')
      .on(t.enrollmentId)
      .where(sql`${t.endsOn} IS NULL`),
    index('sga_group_idx').on(t.groupId, t.startsOn),
    index('sga_enrollment_idx').on(t.enrollmentId, t.startsOn),
    // Ademas (migracion 0007, a mano): EXCLUDE USING gist (enrollment_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
  ],
);

export type Student = typeof students.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type StudentGroupAssignment = typeof studentGroupAssignments.$inferSelect;
