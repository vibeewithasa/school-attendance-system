import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './_columns.js';
import { users } from './auth.js';
import { groups, schoolYears } from './school-catalog.js';
import { enrollments, studentGroupAssignments } from './students.js';

/**
 * Asistencia diaria: UNA lista por grupo y fecha escolar. Ver docs/architecture/diseno-asistencia-diaria.md.
 *
 * Convenciones: UUID v7; sin borrado fisico (FK RESTRICT + triggers que impiden DELETE/TRUNCATE); fechas de calendario en
 * America/Mazatlan; sin sabados ni domingos (CHECK sobre isodow, exacto porque `date` no tiene zona horaria).
 *  - `attendance_days`: la lista (cabecera). `draft` mientras se captura; `finalized` es historia inmutable.
 *  - `attendance_records`: el PADRON CONGELADO de la lista. Nace al abrirla (un renglon por alumno del grupo ese dia, "pendiente" =
 *    `status` NULL) y no admite altas posteriores. Liga la matricula Y la asignacion de grupo historica que lo justifica.
 *  - `attendance_events`: historial solo-agregar de cada cambio (quien, cuando, estado previo y nuevo). Sin nombres de menores.
 * Control optimista: `attendance_days.revision` (+1 por cada guardado con cambios y por la finalizacion).
 */
export const attendanceDays = pgTable(
  'attendance_days',
  {
    id: id(),
    schoolYearId: uuid('school_year_id').notNull(),
    groupId: uuid('group_id').notNull(),
    attendanceDate: date('attendance_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('draft'),
    /** Control de concurrencia optimista: empieza en 1 y solo crece de uno en uno (trigger). */
    revision: integer('revision').notNull().default(1),
    /** Quien abrio la lista. Lo escribe el servidor con la sesion, nunca el cliente. */
    createdBy: uuid('created_by').notNull(),
    finalizedBy: uuid('finalized_by'),
    /** El trigger fija `finalized_at = now()`: el cliente no elige la hora. */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'att_days_school_year_fkey',
      columns: [t.schoolYearId],
      foreignColumns: [schoolYears.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_days_group_year_fkey',
      columns: [t.groupId, t.schoolYearId],
      foreignColumns: [groups.id, groups.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_days_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_days_finalized_by_fkey',
      columns: [t.finalizedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    // UNA lista por grupo y fecha, tambien bajo concurrencia (garantia de la base, no solo de la API).
    unique('att_days_group_date_key').on(t.groupId, t.attendanceDate),
    // Soporta la FK compuesta (attendance_day_id, school_year_id) desde los renglones.
    unique('att_days_id_school_year_id_key').on(t.id, t.schoolYearId),
    check('att_days_weekday', sql`extract(isodow FROM ${t.attendanceDate}) BETWEEN 1 AND 5`),
    check('att_days_status', sql`${t.status} IN ('draft', 'finalized')`),
    check('att_days_revision_positive', sql`${t.revision} >= 1`),
    check(
      'att_days_finalized_consistent',
      sql`(${t.status} = 'draft' AND ${t.finalizedBy} IS NULL AND ${t.finalizedAt} IS NULL) OR (${t.status} = 'finalized' AND ${t.finalizedBy} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL)`,
    ),
    index('att_days_date_idx').on(t.attendanceDate, t.groupId),
    index('att_days_year_idx').on(t.schoolYearId, t.attendanceDate),
    // Ademas (migracion 0010, a mano): triggers de integridad (fecha no futura, grupo activo, ciclo, transiciones y finalizacion).
  ],
);

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: id(),
    attendanceDayId: uuid('attendance_day_id').notNull(),
    /** Se repite a proposito (redundancia CONTROLADA): dos FK compuestas obligan a que lista y matricula sean del MISMO ciclo. */
    schoolYearId: uuid('school_year_id').notNull(),
    enrollmentId: uuid('enrollment_id').notNull(),
    /** La asignacion de grupo historica que justifica que el alumno este en esta lista (grupo y fecha, validado por trigger). */
    groupAssignmentId: uuid('group_assignment_id').notNull(),
    /** NULL = pendiente (aun sin marcar); 'present' / 'absent' son las unicas condiciones de asistencia. */
    status: text('status'),
    markedBy: uuid('marked_by'),
    /** El trigger fija `marked_at = now()` en cada cambio de estado. */
    markedAt: timestamp('marked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'att_records_day_year_fkey',
      columns: [t.attendanceDayId, t.schoolYearId],
      foreignColumns: [attendanceDays.id, attendanceDays.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_records_enrollment_year_fkey',
      columns: [t.enrollmentId, t.schoolYearId],
      foreignColumns: [enrollments.id, enrollments.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_records_group_assignment_fkey',
      columns: [t.groupAssignmentId],
      foreignColumns: [studentGroupAssignments.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_records_marked_by_fkey',
      columns: [t.markedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    // Un alumno (matricula) una sola vez por lista.
    unique('att_records_day_enrollment_key').on(t.attendanceDayId, t.enrollmentId),
    // Soporta la FK compuesta (record_id, attendance_day_id) desde el historial.
    unique('att_records_id_day_key').on(t.id, t.attendanceDayId),
    check('att_records_status', sql`${t.status} IS NULL OR ${t.status} IN ('present', 'absent')`),
    check(
      'att_records_marked_consistent',
      sql`(${t.status} IS NULL AND ${t.markedBy} IS NULL AND ${t.markedAt} IS NULL) OR (${t.status} IS NOT NULL AND ${t.markedBy} IS NOT NULL AND ${t.markedAt} IS NOT NULL)`,
    ),
    index('att_records_enrollment_idx').on(t.enrollmentId, t.attendanceDayId),
    index('att_records_assignment_idx').on(t.groupAssignmentId),
    // Ademas (migracion 0010, a mano): triggers (padron congelado, matricula y grupo vigentes ese dia, transiciones de estado).
  ],
);

export const attendanceEvents = pgTable(
  'attendance_events',
  {
    id: id(),
    attendanceDayId: uuid('attendance_day_id').notNull(),
    /** Solo en `mark_changed`: el renglon cuyo estado cambio (debe ser de esta misma lista). */
    recordId: uuid('record_id'),
    eventType: text('event_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    /** Idempotencia del guardado: el mismo identificador del cliente jamas duplica el historial. */
    requestId: uuid('request_id'),
    /** SHA-256 (hex) del contenido del guardado: un reintento con otro contenido se detecta y se rechaza. */
    payloadHash: text('payload_hash'),
    oldStatus: text('old_status'),
    newStatus: text('new_status'),
    revisionAfter: integer('revision_after').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'att_events_day_fkey',
      columns: [t.attendanceDayId],
      foreignColumns: [attendanceDays.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'att_events_record_day_fkey',
      columns: [t.recordId, t.attendanceDayId],
      foreignColumns: [attendanceRecords.id, attendanceRecords.attendanceDayId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'att_events_actor_fkey', columns: [t.actorId], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'att_events_type',
      sql`${t.eventType} IN ('day_opened', 'mark_changed', 'day_finalized')`,
    ),
    check(
      'att_events_shape',
      sql`(${t.eventType} = 'mark_changed' AND ${t.recordId} IS NOT NULL AND ${t.requestId} IS NOT NULL AND ${t.payloadHash} IS NOT NULL AND ${t.newStatus} IN ('present', 'absent') AND (${t.oldStatus} IS NULL OR ${t.oldStatus} IN ('present', 'absent')))
        OR (${t.eventType} IN ('day_opened', 'day_finalized') AND ${t.recordId} IS NULL AND ${t.requestId} IS NULL AND ${t.payloadHash} IS NULL AND ${t.oldStatus} IS NULL AND ${t.newStatus} IS NULL)`,
    ),
    check(
      'att_events_hash_format',
      sql`${t.payloadHash} IS NULL OR ${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('att_events_revision_positive', sql`${t.revisionAfter} >= 1`),
    // Abrir y finalizar ocurren una sola vez por lista; un renglon cambia una sola vez por solicitud (idempotencia).
    uniqueIndex('att_events_once_idx')
      .on(t.attendanceDayId, t.eventType)
      .where(sql`${t.eventType} IN ('day_opened', 'day_finalized')`),
    uniqueIndex('att_events_request_record_idx')
      .on(t.attendanceDayId, t.requestId, t.recordId)
      .where(sql`${t.eventType} = 'mark_changed'`),
    index('att_events_day_idx').on(t.attendanceDayId, t.occurredAt, t.id),
    index('att_events_record_idx').on(t.recordId, t.occurredAt),
    // Ademas (migracion 0010, a mano): triggers que impiden UPDATE, DELETE y TRUNCATE (solo se agrega).
  ],
);

export type AttendanceDay = typeof attendanceDays.$inferSelect;
export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type AttendanceEvent = typeof attendanceEvents.$inferSelect;
