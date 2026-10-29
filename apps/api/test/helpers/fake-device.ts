import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  accessTokenHash,
  jwkThumbprint,
  shortFingerprint,
  type EcPublicJwk,
} from '../../src/modules/mobile-auth/dpop.js';

/**
 * Dispositivo FICTICIO para las pruebas: genera un par EC P-256 y firma pruebas DPoP como lo hace Android Keystore
 * (ES256 con firma en formato P1363). La clave privada vive solo en memoria de la prueba.
 */
export interface ProofOptions {
  method: string;
  url: string;
  accessToken?: string;
  nonce?: string;
  jti?: string;
  iat?: number;
  /** Para pruebas adversariales: sobrescribe la cabecera o el cuerpo. */
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  /** Firma con otra clave (prueba de clave incorrecta). */
  signWith?: KeyObject;
}

const b64u = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export class FakeDevice {
  readonly privateKey: KeyObject;
  readonly jwk: EcPublicJwk;
  readonly thumbprint: string;
  readonly fingerprint: string;
  /** Reloj del dispositivo (ms) para pruebas con reloj del servidor controlado; por defecto el reloj real. */
  clock?: () => number;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const jwk = publicKey.export({ format: 'jwk' }) as {
      kty: 'EC';
      crv: 'P-256';
      x: string;
      y: string;
    };
    this.jwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    this.thumbprint = jwkThumbprint(this.jwk);
    this.fingerprint = shortFingerprint(this.thumbprint);
  }

  proof(options: ProofOptions): string {
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: this.jwk, ...options.header };
    const claims: Record<string, unknown> = {
      jti: options.jti ?? randomBytes(16).toString('base64url'),
      htm: options.method.toUpperCase(),
      htu: options.url,
      iat: options.iat ?? Math.floor((this.clock?.() ?? Date.now()) / 1000),
      ...(options.accessToken ? { ath: accessTokenHash(options.accessToken) } : {}),
      ...(options.nonce ? { nonce: options.nonce } : {}),
      ...options.claims,
    };
    const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: options.signWith ?? this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${b64u(signature)}`;
  }
}
