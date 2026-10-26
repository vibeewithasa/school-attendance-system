/**
 * Servicio de sesiones de servidor (sin Fastify, sin cookies, sin HTTP). Opera sobre un puerto minimo de SQL
 * (`SessionStore`) para poder probarse con PGlite y con PostgreSQL real.
 *
 *  - El token es opaco: 32 bytes del CSPRNG, codificados en base64url (43 caracteres). Solo se guarda su SHA-256
 *    (`sessions.token_hash`); el token en claro se devuelve UNA vez al crear y no se registra ni persiste en ningun lado.
 *    Como el token ya es de 256 bits de entropia, SHA-256 (sin sal ni KDF lento) es suficiente y permite buscar por indice.
 *  - Caducidad absoluta + por inactividad segun el rol mas estricto del usuario (session-policy.ts).
 *  - En cada verificacion se revalida el estado de la cuenta, los roles vigentes y los permisos desde la base de datos:
 *    nada de autoridad vive en el token. Un cambio de rol, de contrasena o la inhabilitacion tambien revocan las sesiones
 *    mediante triggers (reason roles_changed / password_changed / disabled), y aqui se comprueba de nuevo.
 *  - El limite de sesiones concurrentes (5 por defecto, min(roles.max_concurrent_sessions)) lo impone el trigger
 *    `sessions_before_insert` bajo bloqueo de la fila del usuario: es atomico incluso con peticiones simultaneas.
 *  - Solo usa SQL parametrizado y las columnas que `eta15_api` tiene concedidas (roles-postgresql.md).
 *  - Los resultados negativos son datos (`{ ok: false, reason }`), no excepciones, y nunca incluyen el token ni su hash.
 *    La capa HTTP debe responder igual (401 generico) para cualquier `reason`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Grant } from '../access-control/authorize.js';
import type { Scope } from '../access-control/catalog.js';
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  effectiveSessionPolicy,
  newSessionTimes,
  renewedIdleExpiry,
  sessionState,
  type RoleSessionSettings,
} from './session-policy.js';

/** Un cliente SQL dentro de una transaccion (compatible con `pg` y PGlite). */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** Ejecuta `fn` en una transaccion (READ COMMITTED): COMMIT si termina, ROLLBACK si lanza. */
export interface SessionStore {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export type ClientType = 'web' | 'android';

export const REVOCATION_REASONS = [
  'logout',
  'admin',
  'password_changed',
  'roles_changed',
  'disabled',
  'concurrency',
  'reuse',
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

export type CreateFailure =
  'account_inactive' | 'account_locked' | 'no_active_roles' | 'mfa_required';
export type VerifyFailure =
  | 'invalid_token'
  | 'revoked'
  | 'idle_expired'
  | 'absolute_expired'
  | 'password_changed'
  | CreateFailure;

export interface SessionSummary {
  id: string;
  userId: string;
  clientType: ClientType;
  createdAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  mfaVerifiedAt: Date | null;
}

export interface CreateSessionInput {
  userId: string;
  clientType?: ClientType;
  ip?: string | null;
  userAgent?: string | null;
  /** `true` solo si ya se verifico un segundo factor en este inicio de sesion. */
  mfaVerified?: boolean;
}

export type CreateSessionResult =
  | {
      ok: true;
      token: string;
      session: SessionSummary;
      /** `true` si algun rol exige MFA y la sesion se abrio SIN segundo factor por la politica `deferred` (queda auditado). */
      mfaDeferred: boolean;
    }
  | { ok: false; reason: CreateFailure };

/** Estado de MFA de una sesion verificada, para que el cliente y los guardas futuros decidan sin adivinar. */
export interface MfaState {
  /** Algun rol vigente del usuario exige MFA. */
  required: boolean;
  /** `true` si el servidor lo impone (`required`); `false` si esta diferido por decision del MVP. */
  enforced: boolean;
  /** La sesion tiene segundo factor verificado. Con MFA diferido nunca se simula: queda en `false`. */
  verified: boolean;
}

export interface VerifiedSession {
  session: SessionSummary;
  user: { id: string; accountDomain: 'school' | 'technical'; mustChangePassword: boolean };
  roles: string[];
  grants: Grant[];
  policy: RoleSessionSettings;
  mfa: MfaState;
}

export type VerifySessionResult =
  ({ ok: true } & VerifiedSession) | { ok: false; reason: VerifyFailure };

export interface SessionServiceOptions {
  store: SessionStore;
  /** Reloj inyectable (pruebas). Por defecto se usa la hora del servidor de base de datos. */
  clock?: () => Date;
  /** Solo se escribe `last_seen_at` si pasaron al menos tantos ms desde la ultima escritura (menos escrituras). */
  touchIntervalMs?: number;
  /** Generador del token (solo pruebas); por defecto `crypto.randomBytes`. */
  randomBytes?: (n: number) => Buffer;
  /**
   * Politica de MFA (ver AUTH_MFA_ENFORCEMENT en config/env.ts). `required` es el valor seguro por defecto: un rol con
   * `requires_mfa` no obtiene sesion ni autoriza sin `mfa_verified_at`. `deferred` (solo desarrollo local, decision del
   * MVP) permite la sesion con contrasena, NO marca nunca el segundo factor como verificado y audita cada alta.
   */
  mfaEnforcement?: 'required' | 'deferred';
}

export const TOKEN_BYTES = 32;
export const DEFAULT_TOUCH_INTERVAL_MS = 30_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const USER_AGENT_MAX = 256;

/** SHA-256 del token binario. Devuelve `null` si el texto no es un token canonico de 256 bits. */
export function hashSessionToken(token: unknown): Buffer | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES || raw.toString('base64url') !== token) return null; // rechaza codificaciones no canonicas
  return createHash('sha256').update(raw).digest();
}

interface UserRow {
  id: string;
  account_domain: 'school' | 'technical';
  status: string;
  locked_until: Date | null;
  must_change_password: boolean;
  password_changed_at: Date | null;
  db_now: Date;
}

interface RoleRow {
  key: string;
  session_idle_minutes: number;
  session_absolute_minutes: number;
  requires_mfa: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  client_type: ClientType;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  idle_expires_at: Date;
  mfa_verified_at: Date | null;
  revoked_at: Date | null;
}

const USER_COLUMNS = `u.id, u.account_domain, u.status, u.locked_until, u.must_change_password, u.password_changed_at,
  clock_timestamp() AS db_now`;

const loadRoles = (tx: SqlClient, userId: string) =>
  tx.query<RoleRow>(
    `SELECT r.key, r.session_idle_minutes, r.session_absolute_minutes, r.requires_mfa
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL
      ORDER BY r.key`,
    [userId],
  );

const toSettings = (roles: readonly RoleRow[]): RoleSessionSettings =>
  effectiveSessionPolicy(
    roles.map((r) => ({
      sessionIdleMinutes: r.session_idle_minutes,
      sessionAbsoluteMinutes: r.session_absolute_minutes,
    })),
  );

const summary = (row: SessionRow): SessionSummary => ({
  id: row.id,
  userId: row.user_id,
  clientType: row.client_type,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  idleExpiresAt: row.idle_expires_at,
  mfaVerifiedAt: row.mfa_verified_at,
});

function accountProblem(user: UserRow, now: Date): CreateFailure | null {
  if (user.status !== 'active') return 'account_inactive';
  if (user.locked_until && user.locked_until > now) return 'account_locked';
  return null;
}

export function createSessionService(options: SessionServiceOptions) {
  const { store } = options;
  const touchIntervalMs = options.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
  const random = options.randomBytes ?? ((n: number) => randomBytes(n));
  const mfaDeferredAllowed = options.mfaEnforcement === 'deferred';

  async function createWithin(
    tx: SqlClient,
    input: CreateSessionInput,
  ): Promise<CreateSessionResult> {
    const raw = random(TOKEN_BYTES);
    const token = raw.toString('base64url');
    const tokenHash = createHash('sha256').update(raw).digest();
    const userAgent = input.userAgent ? input.userAgent.slice(0, USER_AGENT_MAX) : null;

    const found = await tx.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 FOR UPDATE`,
      [input.userId],
    );
    const user = found.rows[0];
    // Usuario inexistente: mismo resultado que cuenta inactiva (no revela si existe).
    if (!user) return { ok: false, reason: 'account_inactive' };
    const now = options.clock?.() ?? user.db_now;
    const problem = accountProblem(user, now);
    if (problem) return { ok: false, reason: problem };

    const roles = (await loadRoles(tx, user.id)).rows;
    if (roles.length === 0) return { ok: false, reason: 'no_active_roles' };
    // Con `required`, ningun camino produce una sesion para un rol que exige MFA sin segundo factor verificado.
    const mfaRoles = roles.filter((r) => r.requires_mfa).map((r) => r.key);
    const mfaDeferred = mfaRoles.length > 0 && !input.mfaVerified;
    if (mfaDeferred && !mfaDeferredAllowed) return { ok: false, reason: 'mfa_required' };
    const { expiresAt, idleExpiresAt } = newSessionTimes(now, toSettings(roles));

    const inserted = await tx.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, client_type, created_at, last_seen_at, expires_at, idle_expires_at,
                             mfa_verified_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8::inet, $9)
       RETURNING id, user_id, client_type, created_at, last_seen_at, expires_at, idle_expires_at, mfa_verified_at, revoked_at`,
      [
        user.id,
        tokenHash,
        input.clientType ?? 'web',
        now,
        expiresAt,
        idleExpiresAt,
        input.mfaVerified ? now : null,
        input.ip ?? null,
        userAgent,
      ],
    );
    const created = inserted.rows[0]!;
    if (mfaDeferred) {
      // Trazabilidad de la excepcion del MVP: cada sesion de un rol con MFA obligatorio abierta sin segundo factor.
      await tx.query(
        `INSERT INTO audit_events (event_type, outcome, actor_user_id, subject_user_id, session_id, ip, user_agent, details)
         VALUES ('auth.session_without_mfa', 'success', $1, $1, $2, $3::inet, $4, $5::jsonb)`,
        [
          user.id,
          created.id,
          input.ip ?? null,
          userAgent,
          JSON.stringify({ roles: mfaRoles, enforcement: 'deferred' }),
        ],
      );
    }
    return { ok: true, token, session: summary(created), mfaDeferred };
  }

  return {
    /**
     * Crea una sesion. Bloquea la fila del usuario (FOR UPDATE): serializa creaciones simultaneas y la
     * inhabilitacion de la cuenta. El trigger revoca las mas antiguas si se supera el maximo de sesiones.
     */
    async create(input: CreateSessionInput): Promise<CreateSessionResult> {
      return store.transaction((tx) => createWithin(tx, input));
    },

    /**
     * Igual que `create`, pero dentro de una transaccion del llamador (p. ej. el login, que re-hashea la contrasena y abre la
     * sesion en la MISMA transaccion: el re-hash revoca las sesiones anteriores y la nueva se inserta despues, intacta).
     */
    createWithin,

    /**
     * Verifica un token y, si es valido, renueva la actividad. Revalida cuenta, roles y permisos en cada llamada.
     * Con `touch: false` no escribe nada (solo lectura).
     */
    async verify(token: unknown, opts: { touch?: boolean } = {}): Promise<VerifySessionResult> {
      const tokenHash = hashSessionToken(token);
      if (!tokenHash) return { ok: false, reason: 'invalid_token' };

      return store.transaction<VerifySessionResult>(async (tx) => {
        const sessionRows = await tx.query<SessionRow>(
          `SELECT id, user_id, client_type, created_at, last_seen_at, expires_at, idle_expires_at, mfa_verified_at, revoked_at
             FROM sessions WHERE token_hash = $1`,
          [tokenHash],
        );
        const row = sessionRows.rows[0];
        if (!row) return { ok: false, reason: 'invalid_token' };

        const userRows = await tx.query<UserRow>(
          `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`,
          [row.user_id],
        );
        const user = userRows.rows[0];
        if (!user) return { ok: false, reason: 'invalid_token' };
        const now = options.clock?.() ?? user.db_now;

        if (row.revoked_at) return { ok: false, reason: 'revoked' };
        const problem = accountProblem(user, now);
        if (problem) return { ok: false, reason: problem };
        // Defensa adicional al trigger users_revoke_sessions: una contrasena cambiada despues de crear la sesion la invalida.
        if (user.password_changed_at && user.password_changed_at > row.created_at) {
          return { ok: false, reason: 'password_changed' };
        }

        const roles = (await loadRoles(tx, user.id)).rows;
        if (roles.length === 0) return { ok: false, reason: 'no_active_roles' };
        // Una sesion sin segundo factor verificado nunca autoriza si algun rol vigente lo exige (sin sesiones parciales).
        const mfaRequired = roles.some((r) => r.requires_mfa);
        if (mfaRequired && !row.mfa_verified_at && !mfaDeferredAllowed) {
          return { ok: false, reason: 'mfa_required' };
        }
        const policy = toSettings(roles);

        // La politica vigente puede ser mas estricta que la del momento de crear la sesion (cambio de roles).
        const minutes = (m: number) => m * 60_000;
        const expiresAt = new Date(
          Math.min(
            row.expires_at.getTime(),
            row.created_at.getTime() + minutes(policy.sessionAbsoluteMinutes),
          ),
        );
        const idleExpiresAt = new Date(
          Math.min(
            row.idle_expires_at.getTime(),
            row.last_seen_at.getTime() + minutes(policy.sessionIdleMinutes),
          ),
        );
        const state = sessionState({ expiresAt, idleExpiresAt, revokedAt: row.revoked_at }, now);
        if (state !== 'valid')
          return { ok: false, reason: state as 'revoked' | 'idle_expired' | 'absolute_expired' };

        let current = row;
        if (opts.touch !== false && now.getTime() - row.last_seen_at.getTime() >= touchIntervalMs) {
          const next = renewedIdleExpiry(
            now,
            { expiresAt, idleExpiresAt, revokedAt: null },
            policy,
          );
          const updated = await tx.query<SessionRow>(
            `UPDATE sessions SET last_seen_at = $2, idle_expires_at = GREATEST(idle_expires_at, $3)
              WHERE id = $1 AND revoked_at IS NULL
          RETURNING id, user_id, client_type, created_at, last_seen_at, expires_at, idle_expires_at, mfa_verified_at, revoked_at`,
            [row.id, now, next],
          );
          // 0 filas: otra transaccion la revoco entre la lectura y la renovacion.
          if (updated.rows.length === 0) return { ok: false, reason: 'revoked' };
          current = updated.rows[0]!;
        }

        const grantRows = await tx.query<{ permission: string; scope: Scope }>(
          `SELECT DISTINCT p.key AS permission, rp.scope
             FROM user_roles ur
             JOIN role_permissions rp ON rp.role_id = ur.role_id
             JOIN permissions p ON p.id = rp.permission_id
            WHERE ur.user_id = $1 AND ur.revoked_at IS NULL
            ORDER BY p.key, rp.scope`,
          [user.id],
        );

        return {
          ok: true,
          session: summary(current),
          user: {
            id: user.id,
            accountDomain: user.account_domain,
            mustChangePassword: user.must_change_password,
          },
          roles: roles.map((r) => r.key),
          grants: grantRows.rows.map((g) => ({ permission: g.permission, scope: g.scope })),
          policy,
          mfa: {
            required: mfaRequired,
            enforced: !mfaDeferredAllowed,
            verified: current.mfa_verified_at !== null,
          },
        };
      });
    },

    /** Cierre de sesion individual a partir del token. `true` si estaba vigente y se revoco. */
    async revokeByToken(token: unknown, reason: RevocationReason = 'logout'): Promise<boolean> {
      const tokenHash = hashSessionToken(token);
      if (!tokenHash) return false;
      return store.transaction(async (tx) => {
        const r = await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
            WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
          [tokenHash, assertReason(reason)],
        );
        return r.rows.length > 0;
      });
    },

    /** Revocacion individual por id (p. ej. una persona con autoridad cierra una sesion ajena). */
    async revokeSession(
      sessionId: string,
      opts: { reason?: RevocationReason; by?: string | null } = {},
    ): Promise<boolean> {
      return store.transaction(async (tx) => {
        const r = await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = $2, revoked_by = $3
            WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
          [sessionId, assertReason(opts.reason ?? 'admin'), opts.by ?? null],
        );
        return r.rows.length > 0;
      });
    },

    /** Revocacion global de un usuario (todas sus sesiones vigentes, salvo `exceptSessionId`). Devuelve cuantas. */
    async revokeAllForUser(
      userId: string,
      opts: { reason?: RevocationReason; by?: string | null; exceptSessionId?: string | null } = {},
    ): Promise<number> {
      return store.transaction(async (tx) => {
        const r = await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = $2, revoked_by = $3
            WHERE user_id = $1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4::uuid) RETURNING id`,
          [
            userId,
            assertReason(opts.reason ?? 'admin'),
            opts.by ?? null,
            opts.exceptSessionId ?? null,
          ],
        );
        return r.rows.length;
      });
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

function assertReason(reason: RevocationReason): RevocationReason {
  if (!REVOCATION_REASONS.includes(reason)) throw new Error('Motivo de revocacion no valido');
  return reason;
}

export { DEFAULT_MAX_CONCURRENT_SESSIONS };
