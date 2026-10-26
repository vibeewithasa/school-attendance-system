/**
 * Politica de sesiones (pura y con reloj inyectable). Los tiempos por rol viven en roles.session_*_minutes
 * (semilla aprobada: general 60 min / 12 h; direccion 30 min / 8 h; admin_tecnico 15 min / 8 h).
 */

export interface RoleSessionSettings {
  sessionIdleMinutes: number;
  sessionAbsoluteMinutes: number;
}

/** Valores usados si un usuario no tiene ningun rol vigente (personal general). */
export const DEFAULT_SESSION_POLICY: RoleSessionSettings = {
  sessionIdleMinutes: 60,
  sessionAbsoluteMinutes: 720,
};

/** Maximo inicial de sesiones concurrentes por usuario (configurable). */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;

/** La politica efectiva es la mas estricta entre los roles vigentes del usuario. */
export function effectiveSessionPolicy(roles: readonly RoleSessionSettings[]): RoleSessionSettings {
  if (roles.length === 0) return DEFAULT_SESSION_POLICY;
  return {
    sessionIdleMinutes: Math.min(...roles.map((r) => r.sessionIdleMinutes)),
    sessionAbsoluteMinutes: Math.min(...roles.map((r) => r.sessionAbsoluteMinutes)),
  };
}

const minutes = (m: number) => m * 60_000;

export function newSessionTimes(now: Date, policy: RoleSessionSettings) {
  const expiresAt = new Date(now.getTime() + minutes(policy.sessionAbsoluteMinutes));
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + minutes(policy.sessionIdleMinutes), expiresAt.getTime()),
  );
  return { expiresAt, idleExpiresAt };
}

export interface SessionRow {
  expiresAt: Date;
  idleExpiresAt: Date;
  revokedAt: Date | null;
}

export type SessionState = 'valid' | 'revoked' | 'idle_expired' | 'absolute_expired';

export function sessionState(session: SessionRow, now: Date): SessionState {
  if (session.revokedAt) return 'revoked';
  if (now >= session.expiresAt) return 'absolute_expired';
  if (now >= session.idleExpiresAt) return 'idle_expired';
  return 'valid';
}

/** Nueva caducidad por inactividad tras una peticion valida (nunca supera la absoluta). */
export function renewedIdleExpiry(
  now: Date,
  session: SessionRow,
  policy: RoleSessionSettings,
): Date {
  return new Date(
    Math.min(now.getTime() + minutes(policy.sessionIdleMinutes), session.expiresAt.getTime()),
  );
}

/**
 * Sesiones activas a revocar (las mas antiguas) para que, al crear una nueva, el usuario no supere `max`.
 */
export function sessionsToRevoke<T extends { id: string; createdAt: Date }>(
  active: readonly T[],
  max: number = DEFAULT_MAX_CONCURRENT_SESSIONS,
): T[] {
  const excess = active.length + 1 - max;
  if (excess <= 0) return [];
  return [...active].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, excess);
}
