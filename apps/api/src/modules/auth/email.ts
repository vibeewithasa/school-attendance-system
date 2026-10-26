/**
 * Normalizacion del correo, unica para login y altas: se define en shared-contracts para que API y clientes coincidan
 * (NFKC, sin espacios en los bordes y en minusculas; la base exige `email = lower(btrim(email))`).
 */
export { normalizeEmail } from '@eta15/shared-contracts';
