import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from './_columns.js';
import { users } from './auth.js';
import { enrollments } from './students.js';

/**
 * Registro de RECEPCION de justificantes (Trabajo Social, MVP). Ver docs/architecture/justificantes-recepcion.md.
 *
 * Un renglon es un HECHO ADMINISTRATIVO: "el 28 de octubre, Trabajo Social recibio un justificante del alumno X para el dia D".
 * NO es una aprobacion, no justifica ninguna falta, no modifica `attendance_records` y no se enlaza a ellos: la decision
 * institucional D-10 (como afectan los justificantes a faltas, reportes y alertas) sigue PENDIENTE.
 *
 * Convenciones: UUID v7; sin borrado fisico ni modificacion (triggers de la migracion 0013, tambien para el propietario); fechas de
 * calendario en America/Mazatlan; solo lunes a viernes. Datos minimos: NO hay motivo, diagnostico, descripcion, adjunto, contacto
 * ni texto libre.
 *  - `folio_number` (identidad) y `folio` ('JR-000001'): numero administrativo unico que fija la base; el cliente no lo elige.
 *  - (student_id, school_year_id) -> matricula del alumno en el ciclo (FK compuesta); un trigger exige que `school_date` caiga en
 *    el periodo de esa matricula. No se copia el grupo: el grupo historico se deduce de las asignaciones por fecha.
 *  - `received_at` y `received_by`: quien y cuando lo recibio (la hora la pone el servidor/base, nunca el cliente).
 *  - (received_by, request_id) UNIQUE + `payload_hash`: idempotencia (reintentos y doble clic no duplican; la misma clave con otro
 *    contenido se rechaza). SIN UNIQUE alumno + fecha: pueden recibirse varios documentos del mismo dia.
 *  - `status`: unico valor tecnico 'received'. No existen 'approved' ni 'rejected' (no hay decision institucional).
 */
export const justificationReceipts = pgTable(
  'justification_receipts',
  {
    id: id(),
    /** Consecutivo global fijado por la base (columna de identidad); alimenta el folio. */
    folioNumber: bigint('folio_number', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    /** 'JR-' + consecutivo con ceros a la izquierda (>= 6 digitos). Lo fija un trigger; no lo envia el cliente. */
    folio: text('folio').notNull(),
    studentId: uuid('student_id').notNull(),
    schoolYearId: uuid('school_year_id').notNull(),
    /** Dia escolar al que se refiere el justificante (lunes a viernes, no futuro, dentro de la matricula del alumno). */
    schoolDate: date('school_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('received'),
    receivedBy: uuid('received_by').notNull(),
    /** La pone la base (DEFAULT now()); la API no tiene privilegio para escribir esta columna. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Clave de idempotencia que genera el cliente por cada envio (UUID). */
    requestId: uuid('request_id').notNull(),
    /** SHA-256 (hex) de student_id + school_date: detecta la misma clave reutilizada con otro contenido. */
    payloadHash: text('payload_hash').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'jr_student_enrollment_fkey',
      columns: [t.studentId, t.schoolYearId],
      foreignColumns: [enrollments.studentId, enrollments.schoolYearId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'jr_received_by_fkey',
      columns: [t.receivedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('jr_folio_key').on(t.folio),
    unique('jr_folio_number_key').on(t.folioNumber),
    // Idempotencia por PERSONA: la clave de otra cuenta no se reconoce (no se filtra que existe).
    unique('jr_request_key').on(t.receivedBy, t.requestId),
    check('jr_weekday', sql`extract(isodow FROM ${t.schoolDate}) BETWEEN 1 AND 5`),
    check('jr_status', sql`${t.status} = 'received'`),
    check('jr_hash_format', sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check('jr_folio_format', sql`${t.folio} ~ '^JR-[0-9]{6,}$'`),
    index('jr_student_date_idx').on(t.studentId, t.schoolDate, t.id),
    index('jr_date_idx').on(t.schoolDate, t.id),
    index('jr_received_idx').on(t.receivedAt, t.id),
    // Ademas (migracion 0013, a mano): folio, matricula vigente en la fecha, fecha no futura, sin UPDATE/DELETE/TRUNCATE y RBAC.
  ],
);

export type JustificationReceipt = typeof justificationReceipts.$inferSelect;
