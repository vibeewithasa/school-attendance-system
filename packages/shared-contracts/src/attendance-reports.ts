import { z } from 'zod';
import type { AttendanceDayStatus } from './attendance.js';
import type { GroupRefDto } from './students.js';

/**
 * Reportes basicos de asistencia (solo lectura, MVP administrativo). Se calculan SOLO con las marcas canonicas de
 * `attendance_records` y la cabecera `attendance_days`; el historial de auditoria nunca cuenta como marca.
 *
 * Semantica (ver docs/architecture/reportes-asistencia.md):
 *  - "Sin lista" (no existe la lista del grupo ese dia) NO es una ausencia: no se sabe si hubo clase ni si se tomo asistencia.
 *  - "Sin marca" (renglon pendiente de una lista en borrador) NO es una ausencia; solo `absent` cuenta como ausente.
 *  - "No estaba en el padron" (el alumno no esta en el padron congelado de una lista que existe) y "sin grupo" (no pertenecia al
 *    grupo ese dia) NO son ausencias.
 *  - Solo se consideran dias de lunes a viernes. No se conocen dias festivos ni suspensiones: un dia habil sin lista queda "sin
 *    lista", nunca se infiere una ausencia ni se calcula un porcentaje oficial.
 *  - Los justificantes NO existen todavia (decision D-10 pendiente): ningun total se ajusta por ellos.
 * Fechas: dias de calendario de la escuela (America/Mazatlan), periodos inclusivos, validados contra el ciclo escolar.
 */
const isoDate = z.iso.date();

/** Tope del rango de un reporte (dias naturales, inclusivo): un semestre aproximado. Acota el tamano de la respuesta. */
export const ATTENDANCE_REPORT_MAX_RANGE_DAYS = 190;

/** Dias naturales entre dos fechas de calendario ISO (inclusivo). Independiente de la zona horaria del servidor. */
export function inclusiveDaySpan(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

const rangeShape = { from: isoDate, to: isoDate };
type Range = { from: string; to: string };
const orderedRange = (q: Range) => q.from <= q.to;
const boundedRange = (q: Range) =>
  inclusiveDaySpan(q.from, q.to) <= ATTENDANCE_REPORT_MAX_RANGE_DAYS;
const orderedMessage = {
  message: 'El inicio del rango no puede ser posterior al fin',
  path: ['from'],
};
const boundedMessage = {
  message: `El rango no puede exceder ${ATTENDANCE_REPORT_MAX_RANGE_DAYS} días`,
  path: ['to'],
};

export const attendanceGroupReportQuery = z
  .object({
    groupId: z.uuid(),
    /** Opcional: contrasta el ciclo del grupo; si no coincide, el grupo "no existe" para esta consulta (404). */
    schoolYearId: z.uuid().optional(),
    ...rangeShape,
  })
  .strict()
  .refine(orderedRange, orderedMessage)
  .refine(boundedRange, boundedMessage);
export type AttendanceGroupReportQuery = z.infer<typeof attendanceGroupReportQuery>;

export const attendanceStudentReportQuery = z
  .object({ schoolYearId: z.uuid(), ...rangeShape })
  .strict()
  .refine(orderedRange, orderedMessage)
  .refine(boundedRange, boundedMessage);
export type AttendanceStudentReportQuery = z.infer<typeof attendanceStudentReportQuery>;

export const attendanceReportEmptyQuery = z.object({}).strict();

export interface ReportSchoolYearDto {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

export interface ReportGroupDto extends GroupRefDto {
  isActive: boolean;
}

/** GET /school/attendance/reports/options: ciclos y grupos que la persona puede consultar (el alcance se aplica en la consulta). */
export interface AttendanceReportOptions {
  schoolToday: string;
  schoolYears: Array<ReportSchoolYearDto & { groups: ReportGroupDto[] }>;
}

export interface ReportStudentOptionDto {
  studentId: string;
  givenNames: string;
  familyName: string;
}

/** GET /school/attendance/reports/group/:groupId/students: alumnos que alguna vez estuvieron asignados al grupo en su ciclo. */
export interface AttendanceReportStudentOptions {
  group: ReportGroupDto;
  students: ReportStudentOptionDto[];
}

export interface GroupReportListDto {
  dayId: string;
  status: AttendanceDayStatus;
  /** Alumnos del padron congelado de esa lista. */
  rosterSize: number;
  present: number;
  absent: number;
  /** Renglones pendientes (sin marca). Siempre 0 en una lista finalizada. */
  noMark: number;
}

export interface GroupReportDayDto {
  date: string;
  /** null = no existe lista ese dia (NO es una ausencia). */
  list: GroupReportListDto | null;
}

export interface GroupReportStudentDto {
  studentId: string;
  givenNames: string;
  familyName: string;
  /** Listas del periodo cuyo padron congelado incluye al alumno. */
  listsApplicable: number;
  present: number;
  absent: number;
  noMark: number;
}

export interface GroupReportTotalsDto {
  /** Dias habiles (lunes a viernes) del periodo. */
  weekdays: number;
  withList: number;
  draft: number;
  finalized: number;
  /** Dias habiles sin lista: "no determinado", nunca ausencia. */
  withoutList: number;
  /** Renglones alumno-dia de las listas del periodo (= present + absent + noMark). */
  studentDays: number;
  present: number;
  absent: number;
  noMark: number;
}

/** GET /school/attendance/reports/group */
export interface AttendanceGroupReport {
  generatedAt: string;
  schoolToday: string;
  group: ReportGroupDto;
  schoolYear: ReportSchoolYearDto;
  period: { from: string; to: string };
  days: GroupReportDayDto[];
  students: GroupReportStudentDto[];
  totals: GroupReportTotalsDto;
}

/**
 * Situacion de un alumno en un dia habil:
 *  - present / absent: marca registrada en la lista.
 *  - no_mark: la lista existe (borrador) y el alumno esta en su padron, pero sin marcar.
 *  - no_list: el alumno pertenecia al grupo ese dia pero no existe la lista (no determinado).
 *  - not_in_roster: la lista existe pero el alumno no esta en su padron congelado (se incorporo despues de abrirla).
 *  - not_in_group: sin inscripcion o sin grupo (de su alcance) ese dia.
 */
export type StudentReportState =
  'present' | 'absent' | 'no_mark' | 'no_list' | 'not_in_roster' | 'not_in_group';

export interface StudentReportDayDto {
  date: string;
  state: StudentReportState;
  /** Grupo de la lista o de la pertenencia ese dia; null en `not_in_group`. */
  group: ReportGroupDto | null;
  listStatus: AttendanceDayStatus | null;
  dayId: string | null;
}

export interface StudentReportGroupDto {
  group: ReportGroupDto;
  startsOn: string;
  endsOn: string | null;
}

export interface StudentReportTotalsDto {
  weekdays: number;
  present: number;
  absent: number;
  noMark: number;
  noList: number;
  notInRoster: number;
  notInGroup: number;
  /** Dias en que una lista aplica al alumno (= present + absent + noMark). */
  listsApplicable: number;
}

/** GET /school/attendance/reports/student/:studentId */
export interface AttendanceStudentReport {
  generatedAt: string;
  schoolToday: string;
  student: { id: string; givenNames: string; familyName: string; schoolCode: string | null };
  schoolYear: ReportSchoolYearDto;
  enrollment: { startsOn: string; endsOn: string | null };
  /** Pertenencias a grupos del ciclo dentro del alcance de quien consulta (la prefectura solo ve las de sus grupos). */
  groups: StudentReportGroupDto[];
  period: { from: string; to: string };
  days: StudentReportDayDto[];
  totals: StudentReportTotalsDto;
}
