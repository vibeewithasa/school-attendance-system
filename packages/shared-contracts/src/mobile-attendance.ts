import type {
  AttendanceCountsDto,
  AttendanceDayStatus,
  AttendanceRecordStatus,
} from './attendance.js';

/**
 * Contratos de LECTURA de la asistencia por el canal MOVIL (prototipo de sandbox; ADR 0005 y ADR 0006, ambos PROPUESTOS).
 *
 * Son una PROYECCION MINIMA de los contratos de /school/attendance (ver attendance.ts): los mismos datos y las mismas reglas del
 * servicio, sin nombres de alumnos, sin quien abrio o finalizo la lista, sin datos del grupo que Android ya descargo y sin ningun
 * indicador de "editable" (el canal movil no escribe asistencia). Ningun campo lo decide el cliente.
 *
 * Fechas: `schoolToday` y `attendanceDate` son dias de calendario de la escuela (America/Mazatlan) decididos por el SERVIDOR;
 * `serverTime` es el instante de la respuesta segun el reloj del servidor de aplicaciones (informativo, no autoridad escolar).
 * La fecha de un borrador de Android nunca es la fecha efectiva: solo el servidor dice cual es "hoy".
 */

/** Resumen de una lista (cabecera). `revision` es la que se enviaria como `expectedRevision` en una futura escritura. */
export interface MobileAttendanceDayDto {
  id: string;
  groupId: string;
  schoolYearId: string;
  attendanceDate: string;
  status: AttendanceDayStatus;
  revision: number;
  counts: AttendanceCountsDto;
  finalizedAt: string | null;
}

/** GET /mobile/school/attendance/today */
export interface MobileAttendanceTodayResponse {
  schoolToday: string;
  /** false en sabado y domingo: no se abren listas. */
  isSchoolDay: boolean;
  serverTime: string;
  /** Solo los grupos asignados HOY a quien consulta. `day` es null si la lista de hoy aun no se abre. */
  groups: Array<{ groupId: string; schoolYearId: string; day: MobileAttendanceDayDto | null }>;
}

/** Un renglon del padron CONGELADO de la lista: solo el identificador del alumno (el mismo de /mobile/school/groups/:id/roster). */
export interface MobileAttendanceRecordDto {
  studentId: string;
  status: AttendanceRecordStatus;
  markedAt: string | null;
}

/** GET /mobile/school/attendance/days/:id */
export interface MobileAttendanceDayDetail {
  schoolToday: string;
  serverTime: string;
  day: MobileAttendanceDayDto;
  /**
   * Huella del PADRON CONGELADO de la lista: `v1:` + SHA-256 (hex minuscula) de los identificadores de alumno en minuscula,
   * ordenados de forma ascendente por su cadena y unidos con un salto de linea (sin salto final). Representa SOLO el conjunto de
   * alumnos de la lista: no cambia al marcar y no incluye nombres ni estados.
   */
  rosterDigest: string;
  records: MobileAttendanceRecordDto[];
  /** Comparacion informativa del padron congelado con el padron actual del grupo en esa fecha (una lista nunca se modifica en silencio). */
  discrepancies: { addedToRoster: number; removedFromRoster: number };
}

/** GET /mobile/school/attendance/days (misma paginacion y filtros que el portal; sin nombres). */
export interface MobileAttendanceDayList {
  items: MobileAttendanceDayDto[];
  page: number;
  pageSize: number;
  total: number;
}
