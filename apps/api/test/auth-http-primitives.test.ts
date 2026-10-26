import { describe, expect, it } from 'vitest';
import { createAttemptLimiter } from '../src/modules/auth/attempt-limiter.js';
import {
  checkRequestOrigin,
  csrfTokenFor,
  isUnsafeMethod,
  isValidCsrfToken,
  parseAllowedOrigins,
} from '../src/modules/auth/csrf.js';
import { normalizeEmail } from '../src/modules/auth/email.js';

describe('attempt limiter', () => {
  it('bloquea tras max fallos hasta que vence la ventana y permite reiniciar', () => {
    let t = 0;
    const l = createAttemptLimiter({ max: 3, windowMs: 1000, now: () => t });
    l.fail('a');
    l.fail('a');
    expect(l.blockedFor('a')).toBe(0);
    l.fail('a');
    expect(l.blockedFor('a')).toBe(1000);
    t = 400;
    expect(l.blockedFor('a')).toBe(600);
    expect(l.blockedFor('b')).toBe(0);
    t = 1001;
    expect(l.blockedFor('a')).toBe(0);
    l.fail('c');
    l.fail('c');
    l.fail('c');
    l.reset('c');
    expect(l.blockedFor('c')).toBe(0);
  });

  it('acota la memoria: al llenarse descarta vencidas y luego las mas antiguas', () => {
    let t = 0;
    const l = createAttemptLimiter({ max: 1, windowMs: 1000, maxKeys: 3, now: () => t });
    l.fail('k1');
    l.fail('k2');
    l.fail('k3');
    t = 10;
    l.fail('k4'); // llena: se descarta k1
    expect(l.size).toBe(3);
    expect(l.blockedFor('k1')).toBe(0);
    expect(l.blockedFor('k4')).toBeGreaterThan(0);
    t = 5000;
    l.fail('k5'); // todas vencidas: se limpian
    expect(l.size).toBe(1);
  });
});

describe('csrf y origen', () => {
  const allowed = parseAllowedOrigins(
    'http://127.0.0.1:5173, https://app.eta15.mx/ ,basura, ftp://x',
  );

  it('normaliza la lista de origenes y descarta entradas invalidas', () => {
    expect([...allowed].sort()).toEqual(['http://127.0.0.1:5173', 'https://app.eta15.mx']);
  });

  it('solo GET/HEAD/OPTIONS son seguros', () => {
    for (const m of ['GET', 'head', 'OPTIONS']) expect(isUnsafeMethod(m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isUnsafeMethod(m)).toBe(true);
  });

  it('valida Origin y Fetch Metadata', () => {
    const ok = { origin: 'http://127.0.0.1:5173' };
    expect(checkRequestOrigin(ok, allowed)).toBe('ok');
    expect(checkRequestOrigin({ ...ok, 'sec-fetch-site': 'same-origin' }, allowed)).toBe('ok');
    expect(checkRequestOrigin({ ...ok, 'sec-fetch-site': 'same-site' }, allowed)).toBe('ok');
    expect(checkRequestOrigin({ ...ok, 'sec-fetch-site': 'cross-site' }, allowed)).toBe(
      'cross_site',
    );
    expect(checkRequestOrigin({ ...ok, 'sec-fetch-site': 'none' }, allowed)).toBe('cross_site');
    expect(checkRequestOrigin({}, allowed)).toBe('origin_missing');
    expect(checkRequestOrigin({ origin: 'null' }, allowed)).toBe('origin_missing');
    expect(checkRequestOrigin({ origin: 'http://localhost:5173' }, allowed)).toBe(
      'origin_not_allowed',
    );
    expect(checkRequestOrigin({ origin: 'http://127.0.0.1:5173.evil.mx' }, allowed)).toBe(
      'origin_not_allowed',
    );
  });

  it('el token CSRF es determinista por sesion, distinto entre sesiones y no revela el token', () => {
    const a = Buffer.alloc(32, 1).toString('base64url');
    const b = Buffer.alloc(32, 2).toString('base64url');
    expect(csrfTokenFor(a)).toBe(csrfTokenFor(a));
    expect(csrfTokenFor(a)).not.toBe(csrfTokenFor(b));
    expect(csrfTokenFor(a)).not.toContain(a);
    expect(isValidCsrfToken(a, csrfTokenFor(a))).toBe(true);
    expect(isValidCsrfToken(a, csrfTokenFor(b))).toBe(false);
    for (const bad of [undefined, '', 42, ['x'], 'x'.repeat(500), a])
      expect(isValidCsrfToken(a, bad)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('NFKC, recorte y minusculas', () => {
    expect(normalizeEmail('  Maestra.Ficticia@ESCUELA.mx ')).toBe('maestra.ficticia@escuela.mx');
    expect(normalizeEmail('Ａ@escuela.mx')).toBe('a@escuela.mx'); // letra de ancho completo
  });
});
