import { z } from 'zod';

/**
 * Contratos del catalogo escolar (ciclos y grupos). Espejan las constraints de la base (migraciones 0000-0002); la base sigue
 * siendo la ultima defensa. Sin borrado: se desactiva (`isActive`). Ver docs/architecture/modelo-catalogo-escolar.md.
 */
const isoDate = z.iso.date();

export const SHIFTS = ['matutino', 'vespertino'] as const;
export type Shift = (typeof SHIFTS)[number];
/** Zona horaria de la escuela: define "hoy" para activar ciclos y proteger el historial. */
export const SCHOOL_TIME_ZONE = 'America/Mazatlan';
/** Duracion razonable de un ciclo escolar (dias, ambos extremos incluidos). */
export const SCHOOL_YEAR_MIN_DAYS = 60;
export const SCHOOL_YEAR_MAX_DAYS = 400;

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
/** Dias del ciclo contando ambos extremos. */
export const schoolYearLengthDays = (startsOn: string, endsOn: string) =>
  dayNumber(endsOn) - dayNumber(startsOn) + 1;

const yearName = z
  .string()
  .min(1)
  .max(50)
  .refine((v) => v === v.trim(), 'sin espacios al inicio o al final');

const datesRule = (v: { startsOn: string; endsOn: string }) => v.endsOn > v.startsOn;
const lengthRule = (v: { startsOn: string; endsOn: string }) => {
  const days = schoolYearLengthDays(v.startsOn, v.endsOn);
  return days >= SCHOOL_YEAR_MIN_DAYS && days <= SCHOOL_YEAR_MAX_DAYS;
};

/** Base del ciclo (el contrato historico `schoolYearInput`, sin limite de duracion). */
export const schoolYearInput = z
  .object({ name: yearName, startsOn: isoDate, endsOn: isoDate })
  .refine(datesRule, {
    path: ['endsOn'],
    message: 'La fecha de fin debe ser posterior a la de inicio',
  });

export type SchoolYearInput = z.infer<typeof schoolYearInput>;

/** Alta por la API: ademas exige una duracion razonable. */
export const createSchoolYearBody = z
  .object({ name: yearName, startsOn: isoDate, endsOn: isoDate })
  .strict()
  .refine(datesRule, {
    path: ['endsOn'],
    message: 'La fecha de fin debe ser posterior a la de inicio',
  })
  .refine(lengthRule, {
    path: ['endsOn'],
    message: `El ciclo debe durar entre ${SCHOOL_YEAR_MIN_DAYS} y ${SCHOOL_YEAR_MAX_DAYS} dias`,
  });
export type CreateSchoolYearBody = z.infer<typeof createSchoolYearBody>;

/** Cambios parciales: al menos un campo. La coherencia entre fechas se valida con los valores resultantes. */
export const updateSchoolYearBody = z
  .object({ name: yearName.optional(), startsOn: isoDate.optional(), endsOn: isoDate.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Indique al menos un campo a modificar' });
export type UpdateSchoolYearBody = z.infer<typeof updateSchoolYearBody>;

/**
 * Forma canonica del identificador de grupo: sin espacios en los bordes, espacios internos
 * colapsados y mayusculas. Debe coincidir con las constraints groups_code_* de la BD.
 */
export function normalizeGroupCode(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

export const GROUP_CODE_PATTERN = /^[A-Z0-9]+([ -][A-Z0-9]+)*$/;

/**
 * Hora de entrada local de la escuela ("HH:MM" o "HH:MM:00"), sin zona horaria. Se normaliza a "HH:MM:00",
 * el formato en que la devuelve PostgreSQL (time(0)). Cualquier hora 00:00-23:59 es valida; los horarios
 * no se limitan a 07:00 y 07:50. Los segundos distintos de 00 se rechazan.
 */
export const entryTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/, 'Hora local HH:MM (00:00 a 23:59)')
  .transform((v) => (v.length === 5 ? `${v}:00` : v));

const groupCode = z
  .string()
  .transform(normalizeGroupCode)
  .pipe(
    z
      .string()
      .min(1)
      .max(10)
      .regex(GROUP_CODE_PATTERN, 'Letras A-Z y digitos; separadores: un espacio o guion'),
  );

export const groupInput = z.object({
  schoolYearId: z.uuid(),
  grade: z.number().int().min(1).max(3),
  code: groupCode,
  shift: z.enum(SHIFTS).nullable().default(null),
  /** NULL = aun no configurada. Independiente del turno. */
  expectedEntryTime: entryTime.nullable().default(null),
});
export type GroupInput = z.infer<typeof groupInput>;
export const createGroupBody = groupInput.strict();
export type CreateGroupBody = z.infer<typeof createGroupBody>;

/** Campos editables de un grupo. El ciclo y el grado NO cambian (son historicos); ni la API ni los privilegios lo permiten. */
export const updateGroupBody = z
  .object({
    code: groupCode.optional(),
    shift: z.enum(SHIFTS).nullable().optional(),
    expectedEntryTime: entryTime.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Indique al menos un campo a modificar' });
export type UpdateGroupBody = z.infer<typeof updateGroupBody>;

const paging = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const boolText = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listSchoolYearsQuery = z.object({ ...paging, isActive: boolText.optional() }).strict();
export type ListSchoolYearsQuery = z.infer<typeof listSchoolYearsQuery>;

export const listGroupsQuery = z
  .object({
    ...paging,
    schoolYearId: z.uuid().optional(),
    grade: z.coerce.number().int().min(1).max(3).optional(),
    /** `none` = grupos sin turno. */
    shift: z.enum([...SHIFTS, 'none']).optional(),
    isActive: boolText.optional(),
    /** Busqueda por codigo (contiene), ya normalizada. */
    q: z
      .string()
      .trim()
      .min(1)
      .max(10)
      .transform((v) => normalizeGroupCode(v))
      .optional(),
  })
  .strict();
export type ListGroupsQuery = z.infer<typeof listGroupsQuery>;

export interface SchoolYearDto {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  isActive: boolean;
  /** Posicion respecto de hoy (hora de la escuela): `past`, `current` (incluye hoy) o `future`. */
  period: 'past' | 'current' | 'future';
  groupCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface SchoolYearList {
  items: SchoolYearDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface GroupDto {
  id: string;
  schoolYearId: string;
  schoolYearName: string;
  grade: number;
  code: string;
  shift: Shift | null;
  /** "HH:MM" (hora local de la escuela) o null si aun no se configura. */
  expectedEntryTime: string | null;
  isActive: boolean;
  /** `true` si el ciclo ya termino: el grupo es historial y no se modifica. */
  historical: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface GroupList {
  items: GroupDto[];
  page: number;
  pageSize: number;
  total: number;
}
