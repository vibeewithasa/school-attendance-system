/**
 * Politica inicial de contrasenas para cuentas del personal (la misma en servidor y cliente: el SERVIDOR es la autoridad; el
 * cliente solo la usa para orientar). Codigo puro, sin dependencias, sin registrar nunca la contrasena.
 *
 * Criterios (OWASP ASVS 5.0 V6.2 y NIST SP 800-63B, sin reglas de composicion arbitrarias):
 *  - Longitud minima 12 (sin MFA se prefiere mas que el minimo de 8) y maxima 128 caracteres Unicode (se permite una frase).
 *  - Normalizacion NFKC antes de medir y de comparar (igual que el hash Argon2id, que normaliza igual).
 *  - Sin reglas de mayusculas/numeros/simbolos obligatorios.
 *  - Rechaza: contrasenas comunes (lista local), contrasenas derivadas de una palabra comun con digitos o simbolos de relleno,
 *    el propio correo o nombre, un solo caracter repetido y secuencias triviales.
 *  - Contrasenas comprometidas: NO se consulta ningun servicio externo (no hay justificacion todavia). La lista local es una
 *    barrera minima, no sustituye una lista de filtraciones; ver docs/architecture/auth-rbac.md.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordPolicyReason =
  'too_short' | 'too_long' | 'common' | 'contains_identity' | 'repetitive' | 'sequence';

export const PASSWORD_POLICY_MESSAGES: Record<PasswordPolicyReason, string> = {
  too_short: `Usa al menos ${PASSWORD_MIN_LENGTH} caracteres (una frase larga funciona bien).`,
  too_long: `Usa como máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
  common: 'Es una contraseña demasiado común o fácil de adivinar. Elige otra.',
  contains_identity: 'No uses tu correo ni tu nombre en la contraseña.',
  repetitive: 'No uses un solo carácter repetido.',
  sequence: 'No uses secuencias como 123456789012 o abcdefghijkl.',
};

export interface PasswordContext {
  email?: string;
  displayName?: string;
}

/**
 * Contrasenas comunes de 12 o mas caracteres (las mas cortas ya las rechaza la longitud minima) y de uso tipico en
 * escuelas de habla hispana. Se comparan en minusculas, sin acentos y sin separadores.
 */
const COMMON_FULL = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789123',
  '111111111111',
  '000000000000',
  '123123123123',
  'qwertyuiopas',
  'qwertyuiop12',
  'qwertyuiop123',
  'asdfghjklqwe',
  'zxcvbnmasdfg',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'qazwsxedcrfv',
  'q1w2e3r4t5y6',
  'passwordpassword',
  'password1234',
  'password12345',
  'password123456',
  'letmein12345',
  'iloveyou1234',
  'administrador',
  'administrator',
  'contrasena123',
  'contrasena1234',
  'contrasena12345',
  'micontrasena',
  'micontrasena1',
  'micontrasena123',
  'micontrasena1234',
  'tucontrasena',
  'passwordseguro',
  'contrasenasegura',
  'secundariatecnica',
  'escuelasecundaria',
  'escuelatecnica',
  'secundaria1234',
  'secundaria2024',
  'secundaria2025',
  'secundaria2026',
  'escuela123456',
  'maestro123456',
  'profesor123456',
  'director12345',
  'direccion1234',
  'prefectura123',
  'prefectura1234',
  'costaricasinaloa',
  'sinaloamexico',
  'vivamexico1234',
  'eta15eta15eta15',
  'eta151234567',
  'eta15password',
  'eta15contrasena',
  'bienvenido123',
  'bienvenido1234',
  'bienvenida123',
  'bienvenido2026',
  'abc123abc123',
  'abcdefghijkl',
  'abcdefghijklm',
  'aaaaaaaaaaaa',
  'cambiame12345',
  'cambiala12345',
  'cambiame1234',
  'temporal12345',
  'temporal123456',
  'cambiar12345',
  'claveclave1234',
  'clave1234567',
  'clave12345678',
  'mexicomexico',
  'futbolfutbol1',
]);

/** Palabras muy comunes (o del contexto escolar): una contrasena que sea solo una de ellas mas relleno se rechaza. */
const COMMON_BASES = new Set([
  'password',
  'contrasena',
  'contrasenia',
  'clave',
  'qwerty',
  'qwertyuiop',
  'admin',
  'administrador',
  'administrator',
  'bienvenido',
  'bienvenida',
  'welcome',
  'letmein',
  'iloveyou',
  'secreto',
  'mexico',
  'sinaloa',
  'costarica',
  'escuela',
  'secundaria',
  'tecnica',
  'maestro',
  'maestra',
  'profesor',
  'profesora',
  'director',
  'directora',
  'direccion',
  'prefectura',
  'prefecto',
  'prefecta',
  'trabajosocial',
  'controlacceso',
  'eta15',
  'eta',
  'estudiante',
  'alumno',
  'alumna',
  'futbol',
  'america',
  'chivas',
  'barcelona',
  'realmadrid',
  'dragon',
  'monkey',
  'football',
  'baseball',
  'master',
  'login',
  'abc',
  'temporal',
  'cambiame',
  'cambiar',
  'usuario',
  'user',
  'test',
  'prueba',
  'demo',
  'cuenta',
  'sistema',
  'sistemas',
]);

/** Minusculas, NFKC, sin acentos. */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Letras y numeros unicamente (quita espacios y simbolos). */
const alnum = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '');

/** Quita digitos y simbolos de relleno al inicio y al final: "Password123!" -> "password". */
const stripPadding = (text: string) => text.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');

function isSequence(text: string): boolean {
  const chars = [...text];
  if (chars.length < 8) return false;
  let up = 0;
  let down = 0;
  for (let i = 1; i < chars.length; i++) {
    const d = chars[i]!.codePointAt(0)! - chars[i - 1]!.codePointAt(0)!;
    if (d === 1) up++;
    if (d === -1) down++;
  }
  return up >= chars.length - 2 || down >= chars.length - 2;
}

/** Longitud en caracteres Unicode (puntos de codigo) tras NFKC. */
export function passwordLength(password: string): number {
  return [...password.normalize('NFKC')].length;
}

export type PasswordPolicyResult = { ok: true } | { ok: false; reasons: PasswordPolicyReason[] };

export function validateNewPassword(
  password: string,
  context: PasswordContext = {},
): PasswordPolicyResult {
  const reasons: PasswordPolicyReason[] = [];
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) reasons.push('too_short');
  if (length > PASSWORD_MAX_LENGTH) reasons.push('too_long');
  if (length === 0 || length > PASSWORD_MAX_LENGTH * 4) return { ok: false, reasons };

  const folded = fold(password);
  const core = alnum(folded);
  const bare = stripPadding(core);
  /** Sin espacios pero conservando simbolos y emojis: la repeticion se mide sobre lo que la persona escribio realmente. */
  const compact = folded.replace(/\s/gu, '');

  if (length >= PASSWORD_MIN_LENGTH) {
    if (
      COMMON_FULL.has(core) ||
      COMMON_FULL.has(bare) ||
      COMMON_BASES.has(bare) ||
      COMMON_BASES.has(core)
    )
      reasons.push('common');
    else if (/^(.{1,3})\1+$/u.test(compact) && compact.length >= 8) reasons.push('repetitive'); // "abcabcabcabc"
    if (new Set([...compact]).size <= 1) reasons.push('repetitive');
    if (isSequence(core)) reasons.push('sequence');

    const local = fold(context.email ?? '').split('@')[0] ?? '';
    const name = alnum(fold(context.displayName ?? ''));
    const identities = [alnum(local), name].filter((s) => s.length >= 4);
    if (identities.some((id) => core.includes(id))) reasons.push('contains_identity');
  }
  const unique = [...new Set(reasons)];
  return unique.length === 0 ? { ok: true } : { ok: false, reasons: unique };
}
