/**
 * Normalizacion del correo, unica para login y futuras altas: NFKC, sin espacios en los bordes y en minusculas
 * (la base exige `email = lower(btrim(email))`). No valida pertenencia a un dominio.
 */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}
