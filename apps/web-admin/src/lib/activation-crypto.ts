/**
 * Criptografia de la activacion EN EL NAVEGADOR DEL TITULAR (Web Crypto, sin bibliotecas):
 *  - el secreto son 32 bytes aleatorios (`crypto.getRandomValues`) en base64url (43 caracteres), en memoria de esta pagina;
 *  - al servidor solo se envia su SHA-256 (base64url) y, al completar, el secreto;
 *  - el codigo corto que lee la autoridad se deriva del mismo hash.
 * Requiere un contexto seguro (https o http://127.0.0.1), que es el origen de desarrollo del proyecto.
 */
import { activationCodeFromHash } from '@eta15/shared-contracts';

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (text: string): Uint8Array => {
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

export interface ActivationProof {
  /** NO sale de la memoria de esta pagina salvo al completar la activacion. */
  secret: string;
  secretHash: string;
  /** Codigo corto `XXXXX-XXXXX` que la persona muestra a la autoridad. */
  code: string;
}

export async function createActivationProof(): Promise<ActivationProof> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Este navegador no ofrece criptografía segura en esta dirección');
  }
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', raw));
  return {
    secret: toBase64Url(raw),
    secretHash: toBase64Url(digest),
    code: activationCodeFromHash(digest),
  };
}

/** Solo pruebas: reconstruye el hash de un secreto conocido. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    fromBase64Url(secret) as BufferSource,
  );
  return toBase64Url(new Uint8Array(digest));
}
