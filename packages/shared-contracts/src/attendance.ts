import { z } from 'zod';
import type { GroupRefDto } from './students.js';

/**
 * Contratos de la asistencia diaria (migracion 0010): UNA lista por grupo y fecha escolar. Fechas: dias de calendario de la escuela
 * (America/Mazatlan), solo lunes a viernes. La fecha de la captura ordinaria la decide SIEMPRE el servidor ("hoy"): el cliente puede
 * enviar `attendanceDate` unicamente para que el servidor la CONTRASTE con su propio "hoy" (si difiere, se rechaza). El actor sale de
 * la sesion: ningun contrato admite un `actorId`, un `userId` ni una hora de captura.
 *
 * Estados de captura: `present` y `absent`. `pending` solo existe en un borrador (falta marcar al alumno) y no es un estado
 * definitivo: una lista con pendientes no se puede finalizar.
 */
const isoDate = z.iso.date();

export const ATTENDANCE_MARKS = ['present', 'absent'] as const;
export type AttendanceMark = (typeof ATTENDANCE_MARKS)[number];
export type AttendanceRecordStatus = AttendanceMark | 'pending';

export const ATTENDANCE_DAY_STATUSES = ['draft', 'finalized'] as const;
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number];

/** Maximo de alumnos por solicitud de guardado (un grupo escolar no llega a esa cifra). */
export const ATTENDANCE_MAX_MARKS_PER_REQUEST = 200;

/** Abrir (o recuperar) la lista del grupo para el dia de hoy. Idempotente: nunca crea una segunda lista. */
export const openAttendanceDayBody = z
  .object({
    groupId: z.uuid(),
    /** Opcional y SOLO de contraste: debe ser el "hoy" del servidor; si no, 400 DATE_NOT_TODAY. */
    attendanceDate: isoDate.optional(),
  })
  .strict();
export type OpenAttendanceDayBody = z.infer<typeof openAttendanceDayBody>;

/**
 * Guardar cambios del borrador. `expectedRevision` es la revision que el cliente vio (control optimista); `requestId` es un UUID
 * generado por el cliente por cada guardado: repetirlo es seguro (no duplica historial) y reusarlo con otro contenido se rechaza.
 */
export const saveAttendanceMarksBody = z
  .object({
    expectedRevision: z.number().int().min(1).max(1_000_000),
    requestId: z.uuid(),
    marks: z
      // El identificador se normaliza a minusculas: la identidad logica de la operacion (y su huella) no depende de la grafia.
      .array(
        z
          .object({
            studentId: z.uuid().transform((id) => id.toLowerCase()),
            status: z.enum(ATTENDANCE_MARKS),
          })
          .strict(),
      )
      .min(1)
      .max(ATTENDANCE_MAX_MARKS_PER_REQUEST),
  })
  .strict()
  .refine((b) => new Set(b.marks.map((m) => m.studentId)).size === b.marks.length, {
    message: 'Un alumno aparece más de una vez',
    path: ['marks'],
  });
export type SaveAttendanceMarksBody = z.infer<typeof saveAttendanceMarksBody>;

/** Finalizar: `expectedRevision` garantiza que quien finaliza vio TODO lo capturado (si otra persona guardo despues, 409). */
export const finalizeAttendanceDayBody = z
  .object({ expectedRevision: z.number().int().min(1).max(1_000_000) })
  .strict();
export type FinalizeAttendanceDayBody = z.infer<typeof finalizeAttendanceDayBody>;

const paging = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const listAttendanceDaysQuery = z
  .object({
    ...paging,
    groupId: z.uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: z.enum(ATTENDANCE_DAY_STATUSES).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'El inicio del rango no puede ser posterior al fin',
    path: ['from'],
  });
export type ListAttendanceDaysQuery = z.infer<typeof listAttendanceDaysQuery>;

export const listAttendanceEventsQuery = z.object({ ...paging }).strict();
export type ListAttendanceEventsQuery = z.infer<typeof listAttendanceEventsQuery>;

export interface AttendanceCountsDto {
  total: number;
  present: number;
  absent: number;
  pending: number;
}

export interface AttendanceDayDto {
  id: string;
  group: GroupRefDto;
  attendanceDate: string;
  status: AttendanceDayStatus;
  /** Control de concurrencia optimista: se envia como `expectedRevision` al guardar o finalizar. */
  revision: number;
  counts: AttendanceCountsDto;
  createdAt: string;
  finalizedAt: string | null;
  /** Solo para quien supervisa (`attendance:read` con alcance `all`); la prefectura no ve quien abrio o finalizo. */
  createdBy: string | null;
  finalizedBy: string | null;
}

export interface AttendanceRecordDto {
  studentId: string;
  givenNames: string;
  familyName: string;
  status: AttendanceRecordStatus;
  markedAt: string | null;
}

export interface AttendanceDayDetail extends AttendanceDayDto {
  /** Hoy en America/Mazatlan segun el servidor (la referencia de "dia vigente"). */
  schoolToday: string;
  /**
   * true si ESTA persona puede capturar ahora: permiso de captura sobre el grupo, lista en borrador, de hoy y grupo activo.
   * La interfaz no ofrece controles de edicion si es false; el servidor lo vuelve a comprobar en cada operacion.
   */
  editable: boolean;
  records: AttendanceRecordDto[];
  /**
   * Comparacion informativa entre el padron CONGELADO de la lista y el padron actual del grupo en esa fecha. No cambia ningun
   * renglon (una lista nunca se modifica en silencio): sirve para avisar a Direccion de altas o bajas posteriores a la apertura.
   */
  discrepancies: { addedToRoster: number; removedFromRoster: number };
}

export interface OpenAttendanceDayResponse {
  day: AttendanceDayDetail;
  /** true si esta peticion creo la lista; false si ya existia (la misma lista para todas las personas con acceso). */
  created: boolean;
}

export interface SaveAttendanceMarksResponse {
  day: AttendanceDayDetail;
  /** Renglones que realmente cambiaron (los demas ya tenian ese valor). */
  changed: number;
  /** true si `requestId` ya estaba aplicado: se devuelve el estado vigente sin repetir nada. */
  replayed: boolean;
}

export interface FinalizeAttendanceDayResponse {
  day: AttendanceDayDetail;
  /** true si la lista ya estaba finalizada (reintento o finalizacion simultanea): nada nuevo se escribio. */
  alreadyFinalized: boolean;
}

export interface AttendanceTodayGroupDto {
  group: GroupRefDto;
  /** true si esta persona puede abrir/capturar la lista de este grupo (Direccion solo supervisa: false). */
  canCapture: boolean;
  /** La lista de hoy, si ya se abrio. */
  day: AttendanceDayDto | null;
}

/** GET /school/attendance/today: los grupos del dia de quien consulta, con el estado de su lista. */
export interface AttendanceTodayResponse {
  schoolToday: string;
  /** false en sabado y domingo: no se abren listas. */
  isSchoolDay: boolean;
  generatedAt: string;
  groups: AttendanceTodayGroupDto[];
}

export interface AttendanceDayList {
  items: AttendanceDayDto[];
  page: number;
  pageSize: number;
  total: number;
}

export type AttendanceEventType = 'day_opened' | 'mark_changed' | 'day_finalized';

/** Historial de una lista: solo IDs y estados, nunca nombres. `actorId` solo para quien supervisa. */
export interface AttendanceEventDto {
  id: string;
  eventType: AttendanceEventType;
  studentId: string | null;
  oldStatus: AttendanceRecordStatus | null;
  newStatus: AttendanceMark | null;
  revisionAfter: number;
  occurredAt: string;
  actorId: string | null;
}

export interface AttendanceEventList {
  items: AttendanceEventDto[];
  page: number;
  pageSize: number;
  total: number;
}
