import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/modules/access-control/catalog.js';
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_SESSION_POLICY,
  effectiveSessionPolicy,
  newSessionTimes,
  renewedIdleExpiry,
  sessionState,
  sessionsToRevoke,
} from '../src/modules/auth/session-policy.js';

const settings = (key: string) => {
  const r = ROLES.find((x) => x.key === key)!;
  return {
    sessionIdleMinutes: r.sessionIdleMinutes,
    sessionAbsoluteMinutes: r.sessionAbsoluteMinutes,
  };
};
const T0 = new Date('2026-10-26T08:00:00.000Z');
const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

describe('politica efectiva por rol (valores aprobados)', () => {
  it.each([
    ['prefectura', 60, 720],
    ['trabajo_social', 60, 720],
    ['control_acceso', 60, 720],
    ['direccion', 30, 480],
    ['admin_tecnico', 15, 480],
  ])('%s => %i min de inactividad, %i min absolutos', (role, idle, abs) => {
    expect(effectiveSessionPolicy([settings(role)])).toEqual({
      sessionIdleMinutes: idle,
      sessionAbsoluteMinutes: abs,
    });
  });
  it('con varios roles se aplica el mas estricto en cada eje', () => {
    expect(effectiveSessionPolicy([settings('prefectura'), settings('direccion')])).toEqual({
      sessionIdleMinutes: 30,
      sessionAbsoluteMinutes: 480,
    });
  });
  it('sin roles vigentes se usa el valor por defecto (personal general)', () => {
    expect(effectiveSessionPolicy([])).toEqual(DEFAULT_SESSION_POLICY);
    expect(DEFAULT_SESSION_POLICY).toEqual({ sessionIdleMinutes: 60, sessionAbsoluteMinutes: 720 });
  });
  it('es configurable: respeta valores distintos', () => {
    expect(effectiveSessionPolicy([{ sessionIdleMinutes: 5, sessionAbsoluteMinutes: 20 }])).toEqual(
      {
        sessionIdleMinutes: 5,
        sessionAbsoluteMinutes: 20,
      },
    );
  });
});

describe('caducidades', () => {
  it('una sesion nueva calcula caducidad absoluta e inactividad', () => {
    const { expiresAt, idleExpiresAt } = newSessionTimes(T0, settings('admin_tecnico'));
    expect(expiresAt).toEqual(plus(T0, 480));
    expect(idleExpiresAt).toEqual(plus(T0, 15));
  });
  it('la inactividad nunca supera la caducidad absoluta', () => {
    const { expiresAt, idleExpiresAt } = newSessionTimes(T0, {
      sessionIdleMinutes: 100,
      sessionAbsoluteMinutes: 100,
    });
    expect(idleExpiresAt <= expiresAt).toBe(true);
  });
  it('estados: valida, caducada por inactividad, caducada absoluta y revocada', () => {
    const s = { expiresAt: plus(T0, 480), idleExpiresAt: plus(T0, 15), revokedAt: null };
    expect(sessionState(s, plus(T0, 14))).toBe('valid');
    expect(sessionState(s, plus(T0, 15))).toBe('idle_expired');
    expect(sessionState({ ...s, idleExpiresAt: plus(T0, 500) }, plus(T0, 480))).toBe(
      'absolute_expired',
    );
    expect(sessionState({ ...s, revokedAt: T0 }, plus(T0, 1))).toBe('revoked');
  });
  it('la revocacion tiene prioridad sobre la caducidad', () => {
    const s = { expiresAt: plus(T0, 1), idleExpiresAt: plus(T0, 1), revokedAt: T0 };
    expect(sessionState(s, plus(T0, 999))).toBe('revoked');
  });
  it('actividad renueva la inactividad sin pasar del limite absoluto', () => {
    const s = { expiresAt: plus(T0, 480), idleExpiresAt: plus(T0, 15), revokedAt: null };
    const policy = settings('admin_tecnico');
    expect(renewedIdleExpiry(plus(T0, 10), s, policy)).toEqual(plus(T0, 25));
    expect(renewedIdleExpiry(plus(T0, 475), s, policy)).toEqual(plus(T0, 480));
  });
});

describe('sesiones concurrentes', () => {
  const sessions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `s${i}`, createdAt: plus(T0, i) }));

  it('el maximo inicial es 5', () => {
    expect(DEFAULT_MAX_CONCURRENT_SESSIONS).toBe(5);
  });
  it('con 4 activas se puede abrir otra sin revocar', () => {
    expect(sessionsToRevoke(sessions(4))).toEqual([]);
  });
  it('con 5 activas la nueva revoca la mas antigua', () => {
    expect(sessionsToRevoke(sessions(5)).map((s) => s.id)).toEqual(['s0']);
  });
  it('con exceso previo revoca las necesarias (las mas antiguas)', () => {
    expect(sessionsToRevoke([...sessions(7)].reverse()).map((s) => s.id)).toEqual([
      's0',
      's1',
      's2',
    ]);
  });
  it('el maximo es configurable', () => {
    expect(sessionsToRevoke(sessions(2), 2).map((s) => s.id)).toEqual(['s0']);
  });
});
