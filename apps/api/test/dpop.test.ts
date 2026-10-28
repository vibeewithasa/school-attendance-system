import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accessTokenHash,
  isEcPublicJwk,
  jwkThumbprint,
  normalizeFingerprint,
  shortFingerprint,
  verifyDpopProof,
  type ProofExpectations,
} from '../src/modules/mobile-auth/dpop.js';
import { FakeDevice } from './helpers/fake-device.js';

const URL = 'http://mobile.test/mobile/me';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const expectation = (over: Partial<ProofExpectations> = {}): ProofExpectations => ({
  method: 'GET',
  url: URL,
  nowMs: NOW,
  skewMs: 60_000,
  ...over,
});
const iatNow = Math.floor(NOW / 1000);

describe('DPoP: verificacion de pruebas (RFC 9449, ES256)', () => {
  const device = new FakeDevice();

  it('acepta una prueba valida y devuelve la huella RFC 7638 de la clave', () => {
    const r = verifyDpopProof(
      device.proof({ method: 'GET', url: URL, iat: iatNow }),
      expectation(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.thumbprint).toBe(device.thumbprint);
      expect(r.thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.nonce).toBeNull();
    }
  });

  it('la huella coincide con el vector de la RFC 7638 (calculado sobre el JSON canonico)', () => {
    // Clave de ejemplo (no es secreta): coordenadas P-256 del RFC 7517 apendice A.1.
    const jwk = {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
      y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
    };
    expect(jwkThumbprint(jwk)).toBe('cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s');
  });

  it('rechaza formas invalidas: no es JWT, partes vacias, demasiado larga, no JSON', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'a.b',
      'a.b.c.d',
      '..',
      'x'.repeat(3000),
      '!!!.@@@.###',
    ]) {
      const r = verifyDpopProof(bad, expectation());
      expect(r.ok, String(bad)).toBe(false);
    }
  });

  it('exige typ dpop+jwt y alg ES256 (nada de none, HS256 ni RS256)', () => {
    for (const header of [
      { typ: 'JWT' },
      { alg: 'none' },
      { alg: 'HS256' },
      { alg: 'RS256' },
      { alg: 'ES384' },
    ]) {
      const r = verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow, header }),
        expectation(),
      );
      expect(r.ok).toBe(false);
    }
  });

  it('rechaza una clave publica con componente privado o campos extra', () => {
    const withD = { ...device.jwk, d: 'A'.repeat(43) };
    const withKid = { ...device.jwk, kid: 'abc' };
    for (const jwk of [withD, withKid]) {
      const r = verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow, header: { jwk } }),
        expectation(),
      );
      expect(r).toEqual({ ok: false, reason: 'bad_jwk' });
    }
    expect(isEcPublicJwk({ ...device.jwk, x: 'A'.repeat(43), y: 'A'.repeat(43) })).toBe(false); // punto fuera de la curva
    expect(isEcPublicJwk({ kty: 'RSA', n: 'x', e: 'AQAB' })).toBe(false);
  });

  it('rechaza una firma de OTRA clave y una prueba alterada', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow, signWith: other }),
        expectation(),
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    const good = device.proof({ method: 'GET', url: URL, iat: iatNow });
    const [h, p, s] = good.split('.') as [string, string, string];
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), htu: 'http://evil/x' })).toString('base64url')}.${s}`;
    expect(verifyDpopProof(tampered, expectation()).ok).toBe(false);
  });

  it('verifica metodo, URL y antiguedad (iat) con tolerancia acotada', () => {
    expect(
      verifyDpopProof(device.proof({ method: 'POST', url: URL, iat: iatNow }), expectation()),
    ).toEqual({ ok: false, reason: 'bad_htm' });
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: 'http://mobile.test/mobile/other', iat: iatNow }),
        expectation(),
      ),
    ).toEqual({ ok: false, reason: 'bad_htu' });
    expect(
      verifyDpopProof(device.proof({ method: 'GET', url: URL, iat: iatNow - 120 }), expectation()),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(
      verifyDpopProof(device.proof({ method: 'GET', url: URL, iat: iatNow + 120 }), expectation()),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(
      verifyDpopProof(device.proof({ method: 'GET', url: URL, iat: iatNow - 30 }), expectation())
        .ok,
    ).toBe(true);
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, claims: { iat: 'ahora' } }),
        expectation(),
      ).ok,
    ).toBe(false);
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, claims: { iat: iatNow + 0.5 } }),
        expectation(),
      ),
    ).toEqual({ ok: false, reason: 'bad_claims' });
  });

  it('exige un jti de entre 16 y 128 caracteres', () => {
    for (const jti of ['corto', 'x'.repeat(200)]) {
      expect(
        verifyDpopProof(device.proof({ method: 'GET', url: URL, iat: iatNow, jti }), expectation()),
      ).toEqual({ ok: false, reason: 'bad_claims' });
    }
  });

  it('liga la prueba al token de acceso mediante ath (y no acepta ath donde no hay token)', () => {
    const token = 'T'.repeat(43);
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow, accessToken: token }),
        expectation({ accessToken: token }),
      ).ok,
    ).toBe(true);
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow, accessToken: 'U'.repeat(43) }),
        expectation({ accessToken: token }),
      ),
    ).toEqual({ ok: false, reason: 'bad_ath' });
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow }),
        expectation({ accessToken: token }),
      ),
    ).toEqual({ ok: false, reason: 'bad_ath' });
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow, accessToken: token }),
        expectation(),
      ),
    ).toEqual({ ok: false, reason: 'bad_ath' });
    expect(accessTokenHash(token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exige nonce cuando se pide y lo devuelve para que se consuma', () => {
    expect(
      verifyDpopProof(
        device.proof({ method: 'GET', url: URL, iat: iatNow }),
        expectation({ requireNonce: true }),
      ),
    ).toEqual({ ok: false, reason: 'bad_nonce' });
    const r = verifyDpopProof(
      device.proof({ method: 'GET', url: URL, iat: iatNow, nonce: 'N'.repeat(32) }),
      expectation({ requireNonce: true }),
    );
    expect(r.ok && r.nonce).toBe('N'.repeat(32));
  });
});

describe('DPoP: huella corta de comparacion', () => {
  it('es estable, tiene formato XXXX-XXXX-XXXX y distingue claves', () => {
    const a = new FakeDevice();
    const b = new FakeDevice();
    expect(a.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(shortFingerprint(a.thumbprint)).toBe(a.fingerprint);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(normalizeFingerprint('  3f9a-12bc-77d0 ')).toBe('3F9A-12BC-77D0');
  });
});

// La proteccion contra repeticion (jti) y los nonces son estado compartido en PostgreSQL: se prueban contra la base real
// en test/helpers/mobile-suite.ts (PGlite) y test/pgtemp/mobile-auth.pg.test.ts (varias instancias, conexiones independientes).
