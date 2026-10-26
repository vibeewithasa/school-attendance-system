import { z } from 'zod';
import { normalizeEmail } from './admin-users.js';

/**
 * Activacion de cuentas por RECLAMO EN DOS PARTES (ver docs/architecture/auth-rbac.md §6). Nadie, ni la administracion, conoce
 * o elige la contrasena de otra persona, y la administracion nunca recibe el secreto de activacion:
 *
 *  1. TITULAR (navegador propio): genera un secreto de 256 bits (`crypto.getRandomValues`), calcula `secretHash` = SHA-256 del
 *     secreto en base64url y solo envia el hash junto con su correo. El secreto vive unicamente en la memoria de esa pagina.
 *  2. AUTORIDAD del mismo dominio: verifica la identidad EN PERSONA y teclea el `code` que el titular lee en SU pantalla
 *     (derivado del hash); el servidor comprueba que corresponde a esa solicitud.
 *  3. TITULAR: envia el secreto original y su nueva contrasena; el consumo es atomico y de un solo uso.
 */
export const ACTIVATION_TTL_MINUTES = 30;
export const VERIFICATION_METHODS = ['in_person_id', 'in_person_known'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

const base64url43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const emailInput = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
  );

/** Paso 1 (publico, con limite de intentos): siempre se responde igual exista o no la cuenta. */
export const activationRequestBodySchema = z
  .object({ email: emailInput, secretHash: base64url43 })
  .strict();
export type ActivationRequestBody = z.infer<typeof activationRequestBodySchema>;

/** Consulta del titular: por el HASH (que ya conoce el servidor), asi el secreto no viaja hasta completar. */
export const activationStatusBodySchema = z.object({ secretHash: base64url43 }).strict();
export type ActivationState = 'waiting' | 'authorized' | 'expired' | 'unknown';
export interface ActivationStatusResponse {
  state: ActivationState;
}

/** Paso 3 (publico): el titular entrega el secreto y elige SU contrasena. */
export const activationCompleteBodySchema = z
  .object({ secret: base64url43, newPassword: z.string().min(1).max(1024) })
  .strict();
export type ActivationCompleteBody = z.infer<typeof activationCompleteBodySchema>;

/** Paso 2 (autoridad): el codigo se lee de la pantalla del titular; no se muestra en el listado de la autoridad. */
export const approveActivationBodySchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(8)
      .max(16)
      .regex(/^[0-9A-Za-z -]+$/),
    verificationMethod: z.enum(VERIFICATION_METHODS),
  })
  .strict();
export type ApproveActivationBody = z.infer<typeof approveActivationBodySchema>;

export type ActivationRequestState = 'requested' | 'authorized' | 'expired';
export interface ActivationRequest {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  accountDomain: 'school' | 'technical';
  /** La cuenta la creo quien consulta: no puede aprobar su activacion (control dual). */
  createdByActor: boolean;
  state: ActivationRequestState;
  requestedAt: string;
  expiresAt: string;
}
export interface ActivationRequestList {
  items: ActivationRequest[];
}

export interface ActivationFailureBody {
  error: {
    code: 'ACTIVATION_INVALID' | 'PASSWORD_POLICY' | 'VALIDATION_ERROR' | 'RATE_LIMITED';
    message: string;
    requestId?: string;
    /** Solo con PASSWORD_POLICY: motivos (nunca la contrasena). */
    reasons?: string[];
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Codigo corto de verificacion: 50 bits (10 caracteres Crockford base32, `XXXXX-XXXXX`) del SHA-256 del secreto. Lo calculan
 * identicamente el navegador del titular (para mostrarlo) y el servidor (para comprobarlo).
 */
export function activationCodeFromHash(hash: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of hash.subarray(0, 7)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}`;
}

/** Normaliza lo que escribe la persona (minusculas, guiones, I/L/O confundibles segun Crockford). */
export function normalizeActivationCode(input: string): string {
  const folded = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return folded.length === 10 ? `${folded.slice(0, 5)}-${folded.slice(5)}` : folded;
}
