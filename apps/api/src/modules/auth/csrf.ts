/**
 * Defensa CSRF en tres capas (no se confia solo en SameSite):
 *  1. Origin: toda peticion que cambia estado debe traer un `Origin` incluido en la lista permitida.
 *  2. Fetch Metadata: si el navegador envia `Sec-Fetch-Site`, debe ser `same-origin` o `same-site` (nunca `cross-site`).
 *  3. Token vinculado a la sesion para las peticiones autenticadas: HMAC-SHA256 con el token de sesion como clave. Sin estado,
 *     no requiere un secreto adicional, solo lo puede calcular quien conoce el token de sesion (la cookie HttpOnly) y no permite
 *     recuperar el token de sesion a partir del valor expuesto al JavaScript del cliente.
 * El login no tiene sesion previa: queda protegido por (1) y (2) mas el requisito de `Content-Type: application/json`
 * (una peticion JSON entre sitios exige preflight CORS, que solo se concede a los orígenes permitidos).
 * No se leen cabeceras de proxy (`X-Forwarded-*`): la IP y el esquema son los de la conexion.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_LABEL = 'eta15-csrf-v1';

export const CSRF_HEADER = 'x-csrf-token';

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Orígenes permitidos normalizados (esquema + host + puerto, sin barra final). */
export function parseAllowedOrigins(list: string): Set<string> {
  const out = new Set<string>();
  for (const raw of list.split(',')) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const u = new URL(value);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.origin);
    } catch {
      // se ignora una entrada invalida: nunca amplia la lista
    }
  }
  return out;
}

export type OriginVerdict = 'ok' | 'origin_missing' | 'origin_not_allowed' | 'cross_site';

export function checkRequestOrigin(
  headers: Record<string, string | string[] | undefined>,
  allowed: ReadonlySet<string>,
): OriginVerdict {
  const origin = headers['origin'];
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return 'origin_missing';
  if (!allowed.has(origin)) return 'origin_not_allowed';
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'same-site') return 'cross_site';
  return 'ok';
}

/** Valor CSRF expuesto al cliente para esta sesion (base64url de 32 bytes). */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_LABEL).digest('base64url');
}

export function isValidCsrfToken(sessionToken: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 128) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const given = Buffer.from(provided);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
