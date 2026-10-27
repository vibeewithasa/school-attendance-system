import { z } from 'zod';
import type { GroupRefDto } from './students.js';

/**
 * Contratos de asignaciones de grupos a prefectura (migracion 0009) y consultas minimas para Android. Fechas: dias de calendario
 * de la escuela (America/Mazatlan), periodos INCLUSIVOS (`endsOn` es el ultimo dia con acceso). El actor sale siempre de la sesion:
 * ningun contrato admite un `actorId` ni un `userId` para decidir "mis grupos".
 */
const isoDate = z.iso.date();

export const REVOCATION_REASON_MIN = 3;
export const REVOCATION_REASON_MAX = 200;

/** Motivo de revocacion: texto corto sin saltos ni caracteres de control; se guarda tal cual (sin datos de menores). */
export const revocationReason = z
  .string()
  .trim()
  .min(REVOCATION_REASON_MIN, 'Escribe el motivo (mínimo 3 caracteres)')
  .max(REVOCATION_REASON_MAX, `Máximo ${REVOCATION_REASON_MAX} caracteres`)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Sin saltos de línea ni caracteres de control');

/** El ciclo se deduce del grupo en el servidor (FK compuesta): el cliente no lo elige. Sin `startsOn`: desde hoy. */
export const createPrefectAssignmentBody = z
  .object({
    userId: z.uuid(),
    groupId: z.uuid(),
    startsOn: isoDate.optional(),
    /** Ultimo dia con acceso (cobertura temporal); omitido = hasta el fin del ciclo o hasta cerrarla. */
    endsOn: isoDate.nullable().optional(),
  })
  .strict();
export type CreatePrefectAssignmentBody = z.infer<typeof createPrefectAssignmentBody>;

/** Cierre programado: el acceso termina al acabar `endsOn` (por defecto hoy). No se extiende ni se reabre. */
export const closePrefectAssignmentBody = z.object({ endsOn: isoDate.optional() }).strict();
export type ClosePrefectAssignmentBody = z.infer<typeof closePrefectAssignmentBody>;

/** Revocacion inmediata: quita el acceso en este instante y conserva el historial. */
export const revokePrefectAssignmentBody = z.object({ reason: revocationReason }).strict();
export type RevokePrefectAssignmentBody = z.infer<typeof revokePrefectAssignmentBody>;

const paging = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
export const PREFECT_ASSIGNMENT_STATUSES = [
  'active',
  'upcoming',
  'closed',
  'revoked',
  'completed',
] as const;
export type PrefectAssignmentStatus = (typeof PREFECT_ASSIGNMENT_STATUSES)[number];

export const listPrefectAssignmentsQuery = z
  .object({
    ...paging,
    userId: z.uuid().optional(),
    schoolYearId: z.uuid().optional(),
    groupId: z.uuid().optional(),
    /** Omitido = todas (historial completo). */
    status: z.enum(PREFECT_ASSIGNMENT_STATUSES).optional(),
  })
  .strict();
export type ListPrefectAssignmentsQuery = z.infer<typeof listPrefectAssignmentsQuery>;

export const listPrefectCandidatesQuery = z
  .object({ q: z.string().trim().min(2).max(60).optional() })
  .strict();
export type ListPrefectCandidatesQuery = z.infer<typeof listPrefectCandidatesQuery>;

/** Prefecta elegible: cuenta escolar activa con el rol `prefectura` vigente. */
export interface PrefectCandidateDto {
  id: string;
  displayName: string;
  email: string;
}

export interface PrefectAssignmentDto {
  id: string;
  user: { id: string; displayName: string };
  group: GroupRefDto;
  startsOn: string;
  endsOn: string | null;
  /**
   * active: da acceso hoy; upcoming: aun no empieza; closed: cierre programado ya cumplido; completed: el ciclo termino;
   * revoked: acceso retirado de inmediato (historia, no se reabre).
   */
  status: PrefectAssignmentStatus;
  /**
   * true si HOY da acceso de verdad: ademas del periodo exige cuenta activa, rol de prefectura vigente (concedido antes de la
   * asignacion), grupo activo y ciclo en curso. Direccion lo usa para ver asignaciones "sin efecto".
   */
  grantsAccess: boolean;
  createdAt: string;
  /** Solo para quien administra (la prefecta, con alcance propio, no ve quien asigno ni el motivo de una revocacion). */
  createdBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
}

export interface PrefectAssignmentList {
  items: PrefectAssignmentDto[];
  page: number;
  pageSize: number;
  total: number;
}

/** GET /school/me/groups: SOLO los grupos que dan acceso hoy a quien consulta. */
export interface MyGroupDto {
  assignmentId: string;
  group: GroupRefDto;
  startsOn: string;
  endsOn: string | null;
}
export interface MyGroupsResponse {
  /** Dia (hora de la escuela) al que se refiere la respuesta. */
  asOf: string;
  generatedAt: string;
  groups: MyGroupDto[];
}

/** Alumno en la lista de un grupo: SOLO lo necesario para pasar lista. Sin codigo, expediente ni historial. */
export interface RosterStudentDto {
  id: string;
  givenNames: string;
  familyName: string;
}
/** GET /school/groups/:id/roster: alumnos con asignacion vigente HOY en el grupo (filtrados en el servidor). */
export interface GroupRosterResponse {
  asOf: string;
  generatedAt: string;
  group: GroupRefDto;
  students: RosterStudentDto[];
}
