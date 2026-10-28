/**
 * Nucleo criptografico del canal movil (sin HTTP ni base de datos): pruebas DPoP (RFC 9449) con ES256 y huellas JWK (RFC 7638).
 * Solo se usan primitivas estandar de `node:crypto`; no hay formato propio. La proteccion contra repeticion (`jti`) y los nonces
 * NO viven aqui: son estado compartido en PostgreSQL (mobile-auth.service.ts: `admitProof` e `issueNonce`); este modulo es puro.
 *
 *  - Una prueba DPoP es un JWT (`typ: dpop+jwt`) firmado con la clave privada del dispositivo (Android Keystore) que lleva la clave
 *    publica en la cabecera (`jwk`) y, en el cuerpo, `jti` (unico), `htm` (metodo), `htu` (URL sin consulta), `iat` y, segun el
 *    caso, `ath` (SHA-256 del token de acceso) y `nonce` (emitido por el servidor).
 *  - Solo se acepta ES256 sobre P-256, con una clave publica SIN componente privado y sin campos extra.
 *  - Una prueba firmada con una clave NO prueba identidad por si sola: el servidor compara la huella con la del dispositivo
 *    registrado y aprobado (ver mobile-auth.service.ts).
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

export interface EcPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const PROOF_MAX_LENGTH = 2048;

/** `true` solo para un JWK EC P-256 PUBLICO con exactamente kty, crv, x e y (rechaza `d`, `kid`, `use`, etc.). */
export function isEcPublicJwk(value: unknown): value is EcPublicJwk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  if (keys.length !== 4 || keys.join(',') !== 'crv,kty,x,y') return false;
  if (v.kty !== 'EC' || v.crv !== 'P-256') return false;
  if (typeof v.x !== 'string' || typeof v.y !== 'string') return false;
  if (!B64URL_43.test(v.x) || !B64URL_43.test(v.y)) return false;
  // El punto debe estar realmente en la curva (createPublicKey lo valida).
  try {
    createPublicKey({ key: v as unknown as JsonWebKey, format: 'jwk' });
  } catch {
    return false;
  }
  return true;
}

/** Huella RFC 7638 del JWK: SHA-256 del JSON canonico `{"crv","kty","x","y"}` en base64url (43 caracteres). */
export function jwkThumbprint(jwk: EcPublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

/**
 * Huella corta para COMPARAR A SIMPLE VISTA entre la pantalla del dispositivo y la persona que aprueba:
 * los primeros 12 caracteres hexadecimales del SHA-256 de la huella, en tres grupos (`3F9A-12BC-77D0`). 48 bits: suficiente para
 * detectar una sustitucion de solicitud realizada por un tercero (no es la prueba criptografica, que sigue siendo la firma).
 */
export function shortFingerprint(thumbprint: string): string {
  const hex = createHash('sha256').update(thumbprint).digest('hex').slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

export function normalizeFingerprint(text: string): string {
  return text.trim().toUpperCase();
}

/** SHA-256 del token de acceso en base64url: el valor de `ath` de la prueba. */
export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest('base64url');
}

export type DpopFailure =
  | 'malformed'
  | 'bad_typ'
  | 'bad_alg'
  | 'bad_jwk'
  | 'bad_signature'
  | 'bad_claims'
  | 'stale'
  | 'bad_htm'
  | 'bad_htu'
  | 'bad_ath'
  | 'bad_nonce';

export interface ProofExpectations {
  method: string;
  /** URL canonica esperada (esquema + host + ruta, sin consulta ni fragmento). */
  url: string;
  nowMs: number;
  /** Tolerancia de reloj de `iat` en milisegundos (hacia atras y hacia adelante). */
  skewMs: number;
  /** Si se indica, la prueba debe llevar `ath` igual al hash de este token de acceso. */
  accessToken?: string;
  /** `true`: la prueba debe llevar un `nonce` (lo consume quien llama); `false`/omitido: no se exige. */
  requireNonce?: boolean;
}

export type ProofResult =
  | {
      ok: true;
      jwk: EcPublicJwk;
      thumbprint: string;
      jti: string;
      iat: number;
      nonce: string | null;
    }
  | { ok: false; reason: DpopFailure };

const fail = (reason: DpopFailure): ProofResult => ({ ok: false, reason });

function decodeJson(part: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const text = Buffer.from(part, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verifica forma, firma y reclamos de una prueba DPoP. NO comprueba repeticion (`jti`) ni consume el nonce: eso exige estado
 * compartido y atomico, y lo hace `MobileAuthService.admitProof` DESPUES de saber que la clave es conocida.
 */
export function verifyDpopProof(proof: unknown, expect: ProofExpectations): ProofResult {
  if (typeof proof !== 'string' || proof.length === 0 || proof.length > PROOF_MAX_LENGTH)
    return fail('malformed');
  const parts = proof.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return fail('malformed');
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return fail('malformed');
  if (header.typ !== 'dpop+jwt') return fail('bad_typ');
  if (header.alg !== 'ES256') return fail('bad_alg');
  if (!isEcPublicJwk(header.jwk)) return fail('bad_jwk');
  const jwk = header.jwk;
  if (!/^[A-Za-z0-9_-]{86}$/.test(s)) return fail('bad_signature');
  const signature = Buffer.from(s, 'base64url');
  if (signature.length !== 64) return fail('bad_signature');
  let valid: boolean;
  try {
    const key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
    valid = verify(
      'sha256',
      Buffer.from(`${h}.${p}`, 'ascii'),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature');

  const { jti, htm, htu, iat, ath, nonce } = payload;
  if (typeof jti !== 'string' || jti.length < 16 || jti.length > 128) return fail('bad_claims');
  if (typeof htm !== 'string' || typeof htu !== 'string') return fail('bad_claims');
  if (typeof iat !== 'number' || !Number.isInteger(iat)) return fail('bad_claims');
  if (Math.abs(expect.nowMs - iat * 1000) > expect.skewMs) return fail('stale');
  if (htm !== expect.method.toUpperCase()) return fail('bad_htm');
  if (htu !== expect.url) return fail('bad_htu');
  if (expect.accessToken !== undefined) {
    if (typeof ath !== 'string') return fail('bad_ath');
    const want = Buffer.from(accessTokenHash(expect.accessToken));
    const got = Buffer.from(ath);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return fail('bad_ath');
  } else if (ath !== undefined) {
    return fail('bad_ath'); // una prueba con `ath` no se acepta donde no hay token de acceso
  }
  if (expect.requireNonce) {
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128)
      return fail('bad_nonce');
  } else if (nonce !== undefined && typeof nonce !== 'string') {
    return fail('bad_claims');
  }
  return {
    ok: true,
    jwk,
    thumbprint: jwkThumbprint(jwk),
    jti,
    iat,
    nonce: typeof nonce === 'string' ? nonce : null,
  };
}
