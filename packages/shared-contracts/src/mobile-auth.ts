import { z } from 'zod';

/**
 * Contratos de la autenticacion MOVIL aislada (prototipo de sandbox; ADR 0005, propuesta NO aceptada).
 *
 * Reglas de diseno:
 *  - El dispositivo solo envia su clave PUBLICA (JWK EC P-256 sin componente privado). Nunca una clave privada, contrasena ni
 *    identificador de persona: la persona titular la fija el servidor con su sesion web al reclamar la solicitud.
 *  - Ningun contrato admite `userId`, `role` ni `scope`: la identidad sale del dispositivo registrado y de la base.
 *  - Los tokens de acceso y renovacion son opacos, de un solo propietario (el dispositivo) y siempre van con una prueba DPoP.
 */

export const MOBILE_DEVICE_LABEL_MAX = 60;
export const MOBILE_PAIRING_CODE_PATTERN = /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/;
export const MOBILE_FINGERPRINT_PATTERN = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

const b64url43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** JWK EC P-256 PUBLICO: exactamente kty, crv, x e y (cualquier otro campo, como `d`, se rechaza). */
export const ecPublicJwkSchema = z
  .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: b64url43, y: b64url43 })
  .strict();
export type EcPublicJwkDto = z.infer<typeof ecPublicJwkSchema>;

const deviceLabel = z
  .string()
  .trim()
  .min(1)
  .max(MOBILE_DEVICE_LABEL_MAX)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Sin caracteres de control');

/** POST /mobile/enroll/requests (anonimo): el dispositivo pide ser vinculado con su clave publica. */
export const mobileEnrollRequestBody = z
  .object({ publicKey: ecPublicJwkSchema, label: deviceLabel, platform: z.literal('android') })
  .strict();
export type MobileEnrollRequestBody = z.infer<typeof mobileEnrollRequestBody>;

export interface MobileEnrollRequestCreated {
  requestId: string;
  /** Codigo que SOLO se muestra en la pantalla del dispositivo (formato XXXX-XXXX). */
  pairingCode: string;
  /** Huella corta de la clave publica (XXXX-XXXX-XXXX) para comparar con la que ve quien aprueba. */
  fingerprint: string;
  expiresAt: string;
}

export const MOBILE_REQUEST_STATUSES = [
  'pending',
  'claimed',
  'approved',
  'activated',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type MobileRequestStatus = (typeof MOBILE_REQUEST_STATUSES)[number];

/** GET /mobile/enroll/requests/:id (con prueba DPoP de la clave de la solicitud). */
export interface MobileEnrollStatusResponse {
  requestId: string;
  status: MobileRequestStatus;
  expiresAt: string;
  fingerprint: string;
  /** Nombre de la persona que reclamo la solicitud (solo la ve quien posee la clave) para detectar un reclamo ajeno. */
  claimedBy: { displayName: string } | null;
}

/** POST /mobile/enroll/requests/:id/activate (con prueba DPoP + nonce). */
export interface MobileActivationResponse {
  deviceId: string;
}

/** POST /mobile/auth/challenge */
export const mobileChallengeBody = z.object({ keyThumbprint: b64url43 }).strict();
export type MobileChallengeBody = z.infer<typeof mobileChallengeBody>;
export interface MobileChallengeResponse {
  nonce: string;
  expiresAt: string;
}

/** POST /mobile/auth/refresh */
export const mobileRefreshBody = z.object({ refreshToken: b64url43 }).strict();
export type MobileRefreshBody = z.infer<typeof mobileRefreshBody>;

/** Respuesta de /mobile/auth/token y /mobile/auth/refresh (RFC 9449: token_type DPoP). */
export interface MobileTokenResponse {
  tokenType: 'DPoP';
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  /** Fin de la renovacion por inactividad. */
  idleExpiresAt: string;
  /** Fin absoluto de la sesion movil: despues hay que obtener otra. */
  sessionExpiresAt: string;
  deviceId: string;
}

/** GET /mobile/me */
export interface MobileMeResponse {
  deviceId: string;
  roles: string[];
  permissions: Array<{ permission: string; scope: 'all' | 'assigned_groups' | 'own' }>;
  session: { accessExpiresAt: string; idleExpiresAt: string; sessionExpiresAt: string };
}

// ------------------------------------------------------------------------------------------------ canal web (cookie + CSRF)

/** POST /mobile-devices/claims (persona titular con sesion web): liga la solicitud del dispositivo a SU cuenta. */
export const claimMobileDeviceBody = z
  .object({
    requestId: z.uuid(),
    code: z.string().trim().toUpperCase().regex(MOBILE_PAIRING_CODE_PATTERN),
  })
  .strict();
export type ClaimMobileDeviceBody = z.infer<typeof claimMobileDeviceBody>;

/** POST /mobile-devices/requests/:id/approve (autoridad): confirma la huella que vio en la pantalla del dispositivo. */
export const approveMobileDeviceBody = z
  .object({ fingerprint: z.string().trim().toUpperCase().regex(MOBILE_FINGERPRINT_PATTERN) })
  .strict();
export type ApproveMobileDeviceBody = z.infer<typeof approveMobileDeviceBody>;

export const MOBILE_REVOKE_REASONS = ['titular', 'authority', 'lost'] as const;
export const revokeMobileDeviceBody = z.object({ reason: z.enum(MOBILE_REVOKE_REASONS) }).strict();
export type RevokeMobileDeviceBody = z.infer<typeof revokeMobileDeviceBody>;

export interface MobileRequestDto {
  id: string;
  status: MobileRequestStatus;
  label: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  /** Persona titular que reclamo la solicitud (visible para la autoridad y para la propia persona). */
  titular: { id: string; displayName: string } | null;
}

export interface MobileDeviceDto {
  id: string;
  label: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  titular: { id: string; displayName: string };
}

export interface MobileDevicesListResponse {
  requests: MobileRequestDto[];
  devices: MobileDeviceDto[];
}
