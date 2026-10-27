import { z } from 'zod';
import type { Shift } from './school-catalog.js';

/**
 * Contratos de alumnos, matriculas por ciclo e historial de grupo. Espejan las constraints de la base (migracion 0007); la base
 * sigue siendo la ultima defensa. Convencion de fechas: TODAS las fechas son dias de calendario de la escuela (America/Mazatlan)
 * y los periodos son INCLUSIVOS en ambos extremos (`ends_on` es el ultimo dia), igual que los ciclos escolares.
 * Datos minimos de menores: solo nombre, apellidos y un codigo escolar opcional; ver docs/architecture/modelo-alumnos-matriculas.md.
 */
const isoDate = z.iso.date();

/** Nombre canonico: NFC, sin espacios en los bordes y con los espacios internos colapsados. */
export function normalizePersonName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Letras (con marcas combinantes), espacios, apostrofo, guion y punto; empieza con una letra; sin digitos ni control. */
export const PERSON_NAME_PATTERN = /^[\p{L}][\p{L}\p{M}'’. -]*$/u;
export const PERSON_NAME_MAX = 100;

const personName = z
  .string()
  .transform(normalizePersonName)
  .pipe(
    z
      .string()
      .min(1, 'Escribe el nombre')
      .max(PERSON_NAME_MAX, `Máximo ${PERSON_NAME_MAX} caracteres`)
      .regex(PERSON_NAME_PATTERN, 'Solo letras, espacios, apóstrofo, guion y punto'),
  );

/** Codigo escolar: identificador administrativo (no es secreto ni credencial). Mayusculas ASCII y digitos, guion como separador. */
export function normalizeSchoolCode(raw: string): string {
  return raw.trim().toUpperCase();
}
export const SCHOOL_CODE_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
export const SCHOOL_CODE_MAX = 20;

const schoolCode = z
  .string()
  .transform(normalizeSchoolCode)
  .pipe(
    z
      .string()
      .min(1, 'Escribe el código o déjalo vacío')
      .max(SCHOOL_CODE_MAX, `Máximo ${SCHOOL_CODE_MAX} caracteres`)
      .regex(SCHOOL_CODE_PATTERN, 'Letras A-Z sin acentos, números y guiones entre bloques'),
  );

export const createStudentBody = z
  .object({
    givenNames: personName,
    familyName: personName,
    schoolCode: schoolCode.nullable().default(null),
  })
  .strict();
export type CreateStudentBody = z.infer<typeof createStudentBody>;

export const updateStudentBody = z
  .object({
    givenNames: personName.optional(),
    familyName: personName.optional(),
    schoolCode: schoolCode.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Indique al menos un campo a modificar' });
export type UpdateStudentBody = z.infer<typeof updateStudentBody>;

const paging = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const boolText = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listStudentsQuery = z
  .object({
    ...paging,
    /** Busqueda por nombre, apellidos o codigo (contiene, sin distinguir mayusculas). */
    q: z.string().trim().min(2).max(60).optional(),
    isActive: boolText.optional(),
    /** Solo alumnos con matricula vigente en ese ciclo (en la fecha `asOf`). */
    schoolYearId: z.uuid().optional(),
    /** Solo alumnos con asignacion vigente en ese grupo (en la fecha `asOf`). */
    groupId: z.uuid().optional(),
    /** Fecha de referencia de "vigente"; por defecto hoy (hora de la escuela). */
    asOf: isoDate.optional(),
  })
  .strict();
export type ListStudentsQuery = z.infer<typeof listStudentsQuery>;

export const enrollBody = z
  .object({ schoolYearId: z.uuid(), startsOn: isoDate.optional() })
  .strict();
export type EnrollBody = z.infer<typeof enrollBody>;

/** Baja de matricula: `endsOn` = ultimo dia inscrito (inclusivo). Por defecto hoy. */
export const withdrawBody = z.object({ endsOn: isoDate.optional() }).strict();
export type WithdrawBody = z.infer<typeof withdrawBody>;

/** Primera asignacion de grupo de una matricula. `startsOn` por defecto: el inicio de la matricula. */
export const assignGroupBody = z
  .object({ groupId: z.uuid(), startsOn: isoDate.optional() })
  .strict();
export type AssignGroupBody = z.infer<typeof assignGroupBody>;

/**
 * Traslado de grupo. `effectiveOn` es el PRIMER dia en el grupo nuevo; la asignacion anterior termina el dia anterior.
 * Como el modelo trabaja con dias y no con horas, dos grupos no pueden coincidir el mismo dia: un traslado debe ser
 * posterior al inicio de la asignacion vigente (el mismo dia se rechaza: SAME_DAY).
 */
export const transferBody = z
  .object({ groupId: z.uuid(), effectiveOn: isoDate.optional() })
  .strict();
export type TransferBody = z.infer<typeof transferBody>;

export type EnrollmentStatus = 'upcoming' | 'active' | 'withdrawn' | 'completed';

export interface GroupRefDto {
  id: string;
  schoolYearId: string;
  schoolYearName: string;
  grade: number;
  code: string;
  shift: Shift | null;
}

/** Campos de `students:read_basic`; los marcados opcionales requieren `students:read` (expediente). */
export interface StudentDto {
  id: string;
  givenNames: string;
  familyName: string;
  /** Solo con `students:read` (la prefectura, con `students:read_basic`, no lo recibe ni puede buscar por el). */
  schoolCode?: string | null;
  isActive: boolean;
  /** Grupo vigente HOY (hora de la escuela) segun la asignacion vigente; null si no tiene. */
  currentGroup: GroupRefDto | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface StudentList {
  items: StudentDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface GroupAssignmentDto {
  id: string;
  enrollmentId: string;
  group: GroupRefDto;
  startsOn: string;
  endsOn: string | null;
  /** true si el periodo incluye hoy. */
  current: boolean;
  createdAt: string;
}

export interface EnrollmentDto {
  id: string;
  studentId: string;
  schoolYearId: string;
  schoolYearName: string;
  startsOn: string;
  /** Ultimo dia inscrito; null mientras no haya baja (la matricula dura hasta el fin del ciclo). */
  endsOn: string | null;
  status: EnrollmentStatus;
  createdAt: string;
  /** Historial completo de grupos, del mas antiguo al mas reciente. */
  assignments: GroupAssignmentDto[];
}
