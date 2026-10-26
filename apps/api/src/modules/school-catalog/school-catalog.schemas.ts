import { z } from 'zod';

/** Reglas de entrada del catalogo. Espejan las constraints de la BD; la BD sigue siendo la ultima defensa. */
const isoDate = z.iso.date();

export const SHIFTS = ['matutino', 'vespertino'] as const;

export const schoolYearInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(50)
      .refine((v) => v === v.trim(), 'sin espacios al inicio o al final'),
    startsOn: isoDate,
    endsOn: isoDate,
  })
  .refine((v) => v.endsOn > v.startsOn, {
    path: ['endsOn'],
    message: 'La fecha de fin debe ser posterior a la de inicio',
  });

/**
 * Forma canonica del identificador de grupo: sin espacios en los bordes, espacios internos
 * colapsados y mayusculas. Debe coincidir con las constraints groups_code_* de la BD.
 */
export function normalizeGroupCode(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

export const GROUP_CODE_PATTERN = /^[A-Z0-9]+([ -][A-Z0-9]+)*$/;

export const groupInput = z.object({
  schoolYearId: z.uuid(),
  grade: z.number().int().min(1).max(3),
  code: z
    .string()
    .transform(normalizeGroupCode)
    .pipe(
      z
        .string()
        .min(1)
        .max(10)
        .regex(GROUP_CODE_PATTERN, 'Letras A-Z y digitos; separadores: un espacio o guion'),
    ),
  shift: z.enum(SHIFTS).nullable().default(null),
});

export type SchoolYearInput = z.infer<typeof schoolYearInput>;
export type GroupInput = z.infer<typeof groupInput>;
