import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

/** Politica de MFA diferido (decision del MVP): segura por defecto y rechazada fuera del desarrollo local. */
describe('AUTH_MFA_ENFORCEMENT', () => {
  it('por defecto es required (MFA exigido)', () => {
    expect(loadEnv({}).AUTH_MFA_ENFORCEMENT).toBe('required');
    expect(loadEnv({ NODE_ENV: 'production' }).AUTH_MFA_ENFORCEMENT).toBe('required');
  });

  it('deferred se acepta en desarrollo y pruebas con servidor y base en loopback', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadEnv({ NODE_ENV, AUTH_MFA_ENFORCEMENT: 'deferred' }).AUTH_MFA_ENFORCEMENT).toBe(
        'deferred',
      );
    }
    expect(
      loadEnv({ AUTH_MFA_ENFORCEMENT: 'deferred', HOST: 'localhost', DB_HOST: '::1' })
        .AUTH_MFA_ENFORCEMENT,
    ).toBe('deferred');
  });

  it('deferred se rechaza en produccion (la API no arranca)', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', AUTH_MFA_ENFORCEMENT: 'deferred' })).toThrow(
      /AUTH_MFA_ENFORCEMENT: deferred no esta permitido con NODE_ENV=production/,
    );
  });

  it('deferred se rechaza si el servidor o la base no estan en loopback', () => {
    expect(() => loadEnv({ AUTH_MFA_ENFORCEMENT: 'deferred', HOST: '0.0.0.0' })).toThrow(
      /loopback/,
    );
    expect(() => loadEnv({ AUTH_MFA_ENFORCEMENT: 'deferred', DB_HOST: '10.0.0.5' })).toThrow(
      /loopback/,
    );
  });

  it('valores desconocidos se rechazan y el error no imprime el valor', () => {
    expect(() => loadEnv({ AUTH_MFA_ENFORCEMENT: 'off' })).toThrow(/Configuracion invalida/);
    expect(() => loadEnv({ AUTH_MFA_ENFORCEMENT: 'disabled-secreto-xyz' })).not.toThrow(
      /secreto-xyz/,
    );
  });
});
