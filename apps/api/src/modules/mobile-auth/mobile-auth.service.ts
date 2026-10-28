/**
 * Autenticacion movil AISLADA (prototipo de sandbox; ADR 0005 PROPUESTO, no aceptado). Sin HTTP: opera sobre el puerto SQL
 * (`SessionStore`) para probarse con PGlite y con PostgreSQL real.
 *
 * Seis conceptos separados (la POSESION de un dispositivo no demuestra por si sola la identidad de una persona):
 *  1. IDENTIDAD de la persona: su cuenta escolar activa con el rol `prefectura` vigente, autenticada en el canal WEB (cookie + CSRF).
 *  2. REGISTRO del dispositivo: la solicitud la crea el dispositivo (anonima, solo clave PUBLICA), la RECLAMA la persona titular con
 *     su sesion web y el codigo que ve en la pantalla del dispositivo, y la APRUEBA otra persona con autoridad que confirma la huella.
 *  3. POSESION de la clave privada (Android Keystore): prueba DPoP firmada con un nonce del servidor.
 *  4. AUTORIZACION escolar: se revalida en CADA peticion (cuenta activa, rol vigente, asignaciones de grupo, dispositivo activo).
 *  5. SESION movil: tokens opacos de vida corta, ligados a la clave del dispositivo (DPoP, `ath`), con rotacion de la renovacion y
 *     deteccion de reuso. Solo se guardan sus SHA-256.
 *  6. Concesion OFFLINE: no existe todavia (decision institucional pendiente).
 * Los tiempos son valores de ENSAYO del sandbox, no politica institucional.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type {
  MobileDeviceDto,
  MobileRequestDto,
  MobileRequestStatus,
} from '@eta15/shared-contracts';
import type { Grant } from '../access-control/authorize.js';
import type { Scope } from '../access-control/catalog.js';
import { recordAudit, type AuditContext } from '../audit/audit-log.js';
import { hashSessionToken, type SessionStore, type SqlClient } from '../auth/session-service.js';
import {
  isEcPublicJwk,
  jwkThumbprint,
  normalizeFingerprint,
  shortFingerprint,
  type EcPublicJwk,
} from './dpop.js';

export interface MobileAuthConfig {
  /** Base canonica de las URL (esquema + host + puerto, sin barra final) para el `htu` de las pruebas DPoP. No se toma de cabeceras. */
  publicBaseUrl: string;
  accessTtlSeconds: number;
  idleTtlSeconds: number;
  absoluteTtlSeconds: number;
  requestTtlSeconds: number;
  proofSkewSeconds: number;
  nonceTtlSeconds: number;
  maxPendingRequests: number;
  maxClaimFailures: number;
  /** Solicitudes pendientes (sin vencer) que una misma IP puede tener abiertas: una IP no agota el cupo global de las demas. */
  maxPendingPerIp: number;
  /** Pruebas DPoP vigentes (dentro de su ventana de aceptacion) que UNA clave conocida puede tener registradas. */
  maxProofsPerKey: number;
  /** Nonces sin gastar ni vencer que UNA clave conocida puede tener a la vez. */
  maxNoncesPerKey: number;
  /** Solicitudes de vinculacion que una IP puede crear por ventana (limite COMPARTIDO en PostgreSQL; defensa adicional, no unica). */
  maxRequestsPerIp: number;
  ipWindowSeconds: number;
  /** Reclamos fallidos de UNA cuenta autenticada por ventana (contados en el registro de auditoria: compartidos entre instancias). */
  maxClaimFailuresPerUser: number;
  claimFailureWindowSeconds: number;
  /**
   * LECTURA de asistencia por el canal movil (ADR 0006, propuesto). Apagado por omision. Con `true` el token movil incluye
   * `attendance:read` SOLO con alcance `assigned_groups` (nunca `all`, nunca `attendance:capture`). Solo se configura desde
   * `registerMobile`, que ya no existe con NODE_ENV=production.
   */
  attendanceRead?: boolean;
  /**
   * ESCRITURA de asistencia por el canal movil (ADR 0006, fase 2; solo sandbox). Apagado por omision y NUNCA se enciende por tener la
   * lectura: exige `attendanceRead`. Con `true` el token incluye ademas `attendance:capture` SOLO con alcance `assigned_groups`.
   */
  attendanceWrite?: boolean;
}

/** Valores de ENSAYO del sandbox (no son politica institucional; ver ADR 0005). */
export const SANDBOX_MOBILE_DEFAULTS: Omit<MobileAuthConfig, 'publicBaseUrl'> = {
  accessTtlSeconds: 600,
  idleTtlSeconds: 1800,
  absoluteTtlSeconds: 8 * 3600,
  requestTtlSeconds: 600,
  proofSkewSeconds: 60,
  nonceTtlSeconds: 120,
  maxPendingRequests: 200,
  maxClaimFailures: 5,
  maxPendingPerIp: 10,
  maxProofsPerKey: 300,
  maxNoncesPerKey: 5,
  maxRequestsPerIp: 20,
  ipWindowSeconds: 3600,
  maxClaimFailuresPerUser: 10,
  claimFailureWindowSeconds: 900,
};

/** Permisos que un token movil puede ejercer (los demas del rol NO se exponen por este canal). Hoy: solo lectura. */
export const MOBILE_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'prefect_assignments:read',
  'students:read_basic',
]);

/** Permiso de lectura de asistencia que el token movil puede ejercer cuando `MobileAuthConfig.attendanceRead` esta activo. */
export const MOBILE_ATTENDANCE_READ_PERMISSION = 'attendance:read';

/** Permiso de captura que el token movil puede ejercer cuando `MobileAuthConfig.attendanceWrite` esta activo. */
export const MOBILE_ATTENDANCE_CAPTURE_PERMISSION = 'attendance:capture';

export type MobileFailure =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';
export type MobileResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: MobileFailure;
      message: string;
      reason: string;
      /** Segundos hasta poder reintentar (limites con ventana): la ruta lo traduce a `Retry-After`. */
      retryAfterSeconds?: number;
    };
const fail = (code: MobileFailure, reason: string, message: string, retryAfterSeconds?: number) =>
  ({
    ok: false,
    code,
    message,
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }) as const;

export interface WebContext {
  actorId: string;
  grants: readonly Grant[];
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}
export interface DeviceContext {
  /** IP exacta de la conexion: solo para el limite por IP y la sesion (retencion provisional; ver el ADR 0005). */
  ip?: string | null;
  /** IP `gruesa` (red /24 o /48) para el registro de auditoria, que es inmutable y no debe guardar la IP exacta. */
  auditIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  idleExpiresAt: Date;
  sessionExpiresAt: Date;
  deviceId: string;
}

export interface MobileIdentity {
  deviceId: string;
  sessionId: string;
  thumbprint: string;
  userId: string;
  roles: string[];
  grants: Grant[];
  createdAt: Date;
  accessExpiresAt: Date;
  idleExpiresAt: Date;
  sessionExpiresAt: Date;
}

export type AccessFailure =
  | 'invalid_token'
  | 'wrong_key'
  | 'token_expired'
  | 'session_expired'
  | 'session_revoked'
  | 'device_revoked'
  | 'not_eligible'
  | 'password_change_required'
  /** La prueba DPoP ya se habia aceptado (repeticion) o la clave agoto su cupo de pruebas vigentes. */
  | 'replay'
  | 'proof_limit';

/**
 * Para que la clave de una prueba pueda dejar estado en la base debe estar LIGADA a algo ya existente y acotado:
 *  - `request`: la clave de la solicitud de vinculacion `requestId` (consulta y activacion);
 *  - `device`: la clave de un dispositivo registrado (token y renovacion);
 *  - `known_key`: cualquiera de las dos (desafios).
 * Una clave arbitraria, generada por quien sea, NUNCA deja estado: la prueba se rechaza antes de tocar la base de replay.
 */
export type ProofScope =
  { kind: 'request'; requestId: string } | { kind: 'device' } | { kind: 'known_key' };

export type ProofAdmission =
  { ok: true } | { ok: false; reason: 'unknown_key' | 'replay' | 'rate_limited' | 'bad_nonce' };

const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();
const newToken = () => randomBytes(32).toString('base64url');
const hashOfToken = (token: string): Buffer => hashSessionToken(token) ?? sha256('invalid');
export const hashPairingCode = (code: string) => sha256(`eta15-pairing-v1:${code}`);

function newPairingCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i += 1) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Red /24 (IPv4) o /48 (IPv6) de una IP: suficiente para analizar un incidente sin guardar la direccion exacta. */
export function coarseIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (mapped) return `${mapped[1]}.${mapped[2]}.${mapped[3]}.0`;
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((g) => g !== '');
    return `${groups.slice(0, 3).join(':') || '0'}::`;
  }
  return null;
}
/** Contexto de auditoria de un evento del canal movil anonimo: sin persona autenticada y con IP gruesa. */
const deviceAudit = (ctx: DeviceContext) => ({
  ...ctx,
  ip: ctx.auditIp !== undefined ? ctx.auditIp : coarseIp(ctx.ip),
  actorId: null,
});

const has = (grants: readonly Grant[], permission: string, scope: Scope) =>
  grants.some((g) => g.permission === permission && g.scope === scope);

interface RequestRow {
  id: string;
  user_id: string | null;
  key_thumbprint: string;
  public_key_jwk: EcPublicJwk;
  device_label: string;
  pairing_code_hash: Buffer;
  claim_failures: number;
  status: Exclude<MobileRequestStatus, 'expired'>;
  created_at: Date;
  expires_at: Date;
  approved_by: string | null;
  titular_name: string | null;
}

interface DeviceRow {
  id: string;
  user_id: string;
  key_thumbprint: string;
  label: string;
  status: 'active' | 'revoked';
  registered_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  titular_name: string;
}

const REQUEST_SELECT = `SELECT r.id, r.user_id, r.key_thumbprint, r.public_key_jwk, r.device_label, r.pairing_code_hash, r.claim_failures,
  r.status, r.created_at, r.expires_at, r.approved_by, u.display_name AS titular_name
  FROM mobile_device_requests r LEFT JOIN users u ON u.id = r.user_id`;

const DEVICE_SELECT = `SELECT d.id, d.user_id, d.key_thumbprint, d.label, d.status, d.registered_at, d.last_seen_at, d.revoked_at,
  d.revoke_reason, u.display_name AS titular_name
  FROM mobile_devices d JOIN users u ON u.id = d.user_id`;

/** Traduce los errores de reglas de la base (SQLSTATE + CONSTRAINT nombrado) a resultados de negocio. */
function mapDbError(error: unknown): MobileResult<never> | null {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '42P01' || e.code === '42501') {
    return fail(
      'UNAVAILABLE',
      'MOBILE_AUTH_UNAVAILABLE',
      'La autenticación móvil no está habilitada en esta base',
    );
  }
  const byConstraint: Record<string, [MobileFailure, string, string]> = {
    mdr_user_eligible: ['FORBIDDEN', 'NOT_ELIGIBLE', 'La cuenta no puede vincular dispositivos'],
    md_user_eligible: ['FORBIDDEN', 'NOT_ELIGIBLE', 'La cuenta no puede vincular dispositivos'],
    ms_user_eligible: ['FORBIDDEN', 'NOT_ELIGIBLE', 'La cuenta no puede abrir sesiones móviles'],
    mdr_not_expired: ['CONFLICT', 'REQUEST_EXPIRED', 'La solicitud venció'],
    md_request_not_expired: ['CONFLICT', 'REQUEST_EXPIRED', 'La solicitud venció'],
    mdr_not_self_approved: ['FORBIDDEN', 'SELF_APPROVAL', 'Nadie aprueba su propia vinculación'],
    mdr_approver_authority: ['FORBIDDEN', 'NO_AUTHORITY', 'No tiene autoridad para aprobar'],
    md_device_limit: [
      'CONFLICT',
      'DEVICE_LIMIT',
      'La persona ya tiene el máximo de dispositivos activos',
    ],
    md_from_approved_request: ['CONFLICT', 'NOT_APPROVED', 'La solicitud no está aprobada'],
    ms_device_active: ['FORBIDDEN', 'DEVICE_REVOKED', 'El dispositivo no está activo'],
  };
  if (e.code === '23514' && e.constraint && byConstraint[e.constraint]) {
    const [code, reason, message] = byConstraint[e.constraint]!;
    return fail(code, reason, message);
  }
  if (e.code === '23505') {
    if (e.constraint === 'mdr_open_user_key')
      return fail(
        'CONFLICT',
        'REQUEST_ALREADY_OPEN',
        'Ya hay una vinculación en curso para esta cuenta',
      );
    if (e.constraint === 'mdr_open_thumbprint_key')
      return fail(
        'CONFLICT',
        'REQUEST_ALREADY_OPEN',
        'Ya hay una solicitud en curso para esta clave',
      );
    if (e.constraint === 'md_thumbprint_key' || e.constraint === 'md_request_key')
      return fail(
        'CONFLICT',
        'KEY_ALREADY_REGISTERED',
        'Esta clave ya fue registrada: genere una nueva',
      );
    if (e.constraint === 'ms_one_active_per_device')
      return fail(
        'CONFLICT',
        'CONCURRENT_SESSION',
        'Otra sesión se abrió al mismo tiempo; reintente',
      );
  }
  return null;
}

export interface MobileAuthServiceOptions {
  store: SessionStore;
  config: MobileAuthConfig;
  clock?: () => Date;
}

export function createMobileAuthService(options: MobileAuthServiceOptions) {
  const { store, config } = options;
  const nowOf = async (tx: SqlClient): Promise<Date> =>
    options.clock?.() ??
    (await tx.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]!.now;
  const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

  /** Ejecuta `fn` en una transaccion y convierte los errores de reglas de la base en resultados controlados. */
  async function run<T>(fn: (tx: SqlClient) => Promise<MobileResult<T>>): Promise<MobileResult<T>> {
    try {
      return await store.transaction(fn);
    } catch (error) {
      const mapped = mapDbError(error);
      if (mapped) return mapped;
      throw error;
    }
  }

  const requestStatus = (row: RequestRow, now: Date): MobileRequestStatus =>
    ['pending', 'claimed', 'approved'].includes(row.status) && row.expires_at <= now
      ? 'expired'
      : row.status;

  const requestDto = (row: RequestRow, now: Date): MobileRequestDto => ({
    id: row.id,
    status: requestStatus(row, now),
    label: row.device_label,
    fingerprint: shortFingerprint(row.key_thumbprint),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    titular:
      row.user_id && row.titular_name ? { id: row.user_id, displayName: row.titular_name } : null,
  });

  const deviceDto = (row: DeviceRow): MobileDeviceDto => ({
    id: row.id,
    label: row.label,
    fingerprint: shortFingerprint(row.key_thumbprint),
    status: row.status,
    registeredAt: row.registered_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokeReason: row.revoke_reason,
    titular: { id: row.user_id, displayName: row.titular_name },
  });

  /** Vida de una prueba registrada: la ventana completa en la que `iat` (+/- tolerancia) podria aceptarla, mas un margen. */
  const proofTtlSeconds = config.proofSkewSeconds * 2 + 5;
  const hashJti = (jti: string) => sha256(`eta15-dpop-jti-v1:${jti}`);
  const hashNonce = (nonce: string) => sha256(`eta15-dpop-nonce-v1:${nonce}`);

  /** Serializa el estado de seguridad de UNA clave (no bloquea a otras) hasta el fin de la transaccion. */
  const lockKey = (tx: SqlClient, thumbprint: string) =>
    tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [thumbprint]);

  /**
   * Registra una prueba DPoP aceptada: respeta el cupo de la clave y rechaza la repeticion con la restriccion UNIQUE (clave, hash del
   * jti), de modo atomico aunque dos instancias reciban la misma prueba a la vez. Devuelve `true` solo si es la PRIMERA vez.
   * La clave debe estar ya comprobada como conocida por quien llama.
   */
  async function recordProof(
    tx: SqlClient,
    thumbprint: string,
    jti: string,
    now: Date,
  ): Promise<'ok' | 'replay' | 'rate_limited'> {
    await lockKey(tx, thumbprint);
    const live = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_proof_jtis WHERE key_thumbprint = $1 AND expires_at > $2`,
      [thumbprint, now],
    );
    if (live.rows[0]!.n >= config.maxProofsPerKey) return 'rate_limited';
    const inserted = await tx.query(
      `INSERT INTO mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING 1`,
      [thumbprint, hashJti(jti), now, addSeconds(now, proofTtlSeconds)],
    );
    return inserted.rows.length === 1 ? 'ok' : 'replay';
  }

  /** Revoca las sesiones moviles activas del dispositivo (la hora la fija el trigger). */
  async function revokeDeviceSessions(
    tx: SqlClient,
    deviceId: string,
    reason: 'device_revoked' | 'replaced' | 'authority',
    by: string | null,
  ): Promise<number> {
    const r = await tx.query(
      `UPDATE mobile_sessions SET revoked_reason = $2, revoked_by = $3 WHERE device_id = $1 AND revoked_at IS NULL RETURNING id`,
      [deviceId, reason, by],
    );
    return r.rows.length;
  }

  return {
    // ================================================================================================ DISPOSITIVO (anonimo)

    /** El dispositivo pide ser vinculado: solo su clave PUBLICA y una etiqueta. Nace pendiente y sin persona titular. */
    async createRequest(
      input: { publicKey: unknown; label: string },
      ctx: DeviceContext,
    ): Promise<
      MobileResult<{ requestId: string; pairingCode: string; fingerprint: string; expiresAt: Date }>
    > {
      if (!isEcPublicJwk(input.publicKey))
        return fail('VALIDATION', 'BAD_KEY', 'Clave pública no válida');
      const jwk = input.publicKey;
      const thumbprint = jwkThumbprint(jwk);
      const code = newPairingCode();
      return run(async (tx) => {
        const now = await nowOf(tx);
        // Solicitudes abiertas pero vencidas de esta misma clave se cierran para no bloquear un reintento.
        await tx.query(
          `UPDATE mobile_device_requests SET status = 'cancelled'
            WHERE key_thumbprint = $1 AND status IN ('pending', 'claimed', 'approved') AND expires_at <= $2`,
          [thumbprint, now],
        );
        const known = await tx.query(`SELECT 1 FROM mobile_devices WHERE key_thumbprint = $1`, [
          thumbprint,
        ]);
        if (known.rows.length > 0)
          return fail(
            'CONFLICT',
            'KEY_ALREADY_REGISTERED',
            'Esta clave ya fue registrada: genere una nueva',
          );
        const open = await tx.query(
          `SELECT 1 FROM mobile_device_requests WHERE key_thumbprint = $1 AND status IN ('pending', 'claimed', 'approved')`,
          [thumbprint],
        );
        if (open.rows.length > 0)
          return fail(
            'CONFLICT',
            'REQUEST_ALREADY_OPEN',
            'Ya hay una solicitud en curso para esta clave',
          );
        // Las solicitudes abiertas ya vencidas se CIERRAN (no se borran) en lotes pequenos: no ocupan cupos ni bloquean a nadie.
        await tx.query(
          `UPDATE mobile_device_requests SET status = 'cancelled'
            WHERE id IN (SELECT id FROM mobile_device_requests
                          WHERE status IN ('pending', 'claimed', 'approved') AND expires_at <= $1
                          ORDER BY expires_at LIMIT 25)`,
          [now],
        );
        let minePending = 0;
        if (ctx.ip) {
          // Limite COMPARTIDO (PostgreSQL) de solicitudes por IP y ventana: defensa adicional, no unica (una IP puede ser
          // la de varios dispositivos legitimos); el crecimiento de la tabla queda acotado por este mismo limite.
          const window = await tx.query<{ n: number; oldest: Date | null }>(
            `SELECT count(*)::int AS n, min(created_at) AS oldest FROM mobile_device_requests
              WHERE requested_ip = $2::inet AND created_at > $1`,
            [addSeconds(now, -config.ipWindowSeconds), ctx.ip],
          );
          const w = window.rows[0]!;
          if (w.n >= config.maxRequestsPerIp)
            return fail(
              'RATE_LIMITED',
              'IP_RATE_LIMITED',
              'Demasiadas solicitudes desde esta red; intente más tarde',
              Math.max(
                1,
                Math.ceil(
                  (addSeconds(w.oldest ?? now, config.ipWindowSeconds).getTime() - now.getTime()) /
                    1000,
                ),
              ),
            );
          const mine = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM mobile_device_requests
              WHERE status = 'pending' AND expires_at > $1 AND requested_ip = $2::inet`,
            [now, ctx.ip],
          );
          minePending = mine.rows[0]!.n;
          if (minePending >= config.maxPendingPerIp)
            return fail(
              'RATE_LIMITED',
              'TOO_MANY_PENDING',
              'Hay demasiadas solicitudes pendientes desde esta red; intente más tarde',
              config.requestTtlSeconds,
            );
        }
        const pending = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM mobile_device_requests WHERE status = 'pending' AND expires_at > $1`,
          [now],
        );
        if (pending.rows[0]!.n >= config.maxPendingRequests) {
          // Cupo global lleno: expulsion JUSTA. Si otra red acumula claramente mas pendientes que esta, se cierra la mas antigua
          // de ESA red y se admite esta; si no, se rechaza. Asi muchas solicitudes anonimas no impiden la vinculacion legitima.
          const top = await tx.query<{ ip: string; n: number }>(
            `SELECT host(requested_ip) AS ip, count(*)::int AS n FROM mobile_device_requests
              WHERE status = 'pending' AND expires_at > $1 AND requested_ip IS NOT NULL
              GROUP BY requested_ip ORDER BY n DESC LIMIT 1`,
            [now],
          );
          const heavy = top.rows[0];
          const evicted =
            heavy && heavy.ip !== ctx.ip && heavy.n > minePending + 1
              ? await tx.query<{ id: string }>(
                  `UPDATE mobile_device_requests SET status = 'cancelled'
                    WHERE id = (SELECT id FROM mobile_device_requests
                                 WHERE status = 'pending' AND expires_at > $1 AND requested_ip = $2::inet
                                 ORDER BY created_at LIMIT 1)
                RETURNING id`,
                  [now, heavy.ip],
                )
              : null;
          if (!evicted || evicted.rows.length === 0)
            return fail(
              'RATE_LIMITED',
              'TOO_MANY_PENDING',
              'Hay demasiadas solicitudes pendientes; intente más tarde',
              60,
            );
          await recordAudit(tx, deviceAudit(ctx), {
            type: 'mobile.request_evicted',
            outcome: 'success',
            details: { requestId: evicted.rows[0]!.id, reason: 'capacity' },
          });
        }
        const expiresAt = addSeconds(now, config.requestTtlSeconds);
        const created = await tx.query<{ id: string }>(
          `INSERT INTO mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, created_at, expires_at, requested_ip)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::inet) RETURNING id`,
          [
            thumbprint,
            JSON.stringify(jwk),
            input.label.trim(),
            hashPairingCode(code),
            now,
            expiresAt,
            ctx.ip ?? null,
          ],
        );
        const requestId = created.rows[0]!.id;
        await recordAudit(tx, deviceAudit(ctx), {
          type: 'mobile.device_requested',
          outcome: 'success',
          details: { requestId, fingerprint: shortFingerprint(thumbprint) },
        });
        return {
          ok: true,
          value: {
            requestId,
            pairingCode: code,
            fingerprint: shortFingerprint(thumbprint),
            expiresAt,
          },
        };
      });
    },

    /**
     * ADMISION de una prueba DPoP del canal anonimo/de dispositivo (ya verificada su firma y reclamos, SIN estado). En UNA transaccion:
     *  1. la clave debe estar ligada a algo existente (`scope`): si no, se rechaza SIN escribir nada;
     *  2. se registra el `jti` (cupo por clave; la repeticion la rechaza la restriccion UNIQUE, tambien entre instancias);
     *  3. si la operacion lo exige, se gasta UN nonce de esa clave (vigente y sin usar).
     * Un fallo de la base se propaga como excepcion: quien llama RECHAZA la peticion (falla cerrado, nunca "abre").
     */
    async admitProof(input: {
      thumbprint: string;
      jti: string;
      nonce: string | null;
      scope: ProofScope;
    }): Promise<ProofAdmission> {
      return store.transaction(async (tx): Promise<ProofAdmission> => {
        const now = await nowOf(tx);
        const { thumbprint, scope } = input;
        let known: boolean;
        if (scope.kind === 'request') {
          known =
            (
              await tx.query(
                `SELECT 1 FROM mobile_device_requests WHERE id = $1 AND key_thumbprint = $2`,
                [scope.requestId, thumbprint],
              )
            ).rows.length > 0;
        } else if (scope.kind === 'device') {
          known =
            (await tx.query(`SELECT 1 FROM mobile_devices WHERE key_thumbprint = $1`, [thumbprint]))
              .rows.length > 0;
        } else {
          known =
            (
              await tx.query(
                `SELECT 1 FROM mobile_devices WHERE key_thumbprint = $1
                 UNION ALL
                 SELECT 1 FROM mobile_device_requests
                  WHERE key_thumbprint = $1 AND status IN ('pending', 'claimed', 'approved') AND expires_at > $2`,
                [thumbprint, now],
              )
            ).rows.length > 0;
        }
        if (!known) return { ok: false, reason: 'unknown_key' };
        const recorded = await recordProof(tx, thumbprint, input.jti, now);
        if (recorded !== 'ok')
          return { ok: false, reason: recorded === 'replay' ? 'replay' : 'rate_limited' };
        if (input.nonce !== null) {
          const spent = await tx.query(
            `UPDATE mobile_nonces SET consumed_at = $3
              WHERE nonce_hash = $1 AND key_thumbprint = $2 AND consumed_at IS NULL AND expires_at > $3
          RETURNING 1`,
            [hashNonce(input.nonce), thumbprint, now],
          );
          if (spent.rows.length !== 1) return { ok: false, reason: 'bad_nonce' };
        }
        return { ok: true };
      });
    },

    /**
     * Emite un nonce (desafio) de UN SOLO USO por operacion de negocio para una clave que YA probo su posesion con una prueba DPoP y
     * esta ligada a una solicitud abierta o a un dispositivo. Tope de nonces vigentes por clave. Nada se guarda en claro: solo su
     * SHA-256. Devuelve `null` si la clave agoto su cupo.
     */
    async issueNonce(thumbprint: string): Promise<{ nonce: string; expiresAt: Date } | null> {
      return store.transaction(async (tx) => {
        const now = await nowOf(tx);
        await lockKey(tx, thumbprint);
        const live = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM mobile_nonces WHERE key_thumbprint = $1 AND consumed_at IS NULL AND expires_at > $2`,
          [thumbprint, now],
        );
        if (live.rows[0]!.n >= config.maxNoncesPerKey) return null;
        const nonce = randomBytes(24).toString('base64url');
        const expiresAt = addSeconds(now, config.nonceTtlSeconds);
        await tx.query(
          `INSERT INTO mobile_nonces (nonce_hash, key_thumbprint, issued_at, expires_at) VALUES ($1, $2, $3, $4)`,
          [hashNonce(nonce), thumbprint, now, expiresAt],
        );
        return { nonce, expiresAt };
      });
    },

    /** Estado de SU solicitud (solo quien posee la clave: la prueba DPoP ya se verifico fuera). Otra clave => 404. */
    async requestStatus(requestId: string, thumbprint: string) {
      return run(async (tx) => {
        const now = await nowOf(tx);
        const r = await tx.query<RequestRow>(
          `${REQUEST_SELECT} WHERE r.id = $1 AND r.key_thumbprint = $2`,
          [requestId, thumbprint],
        );
        const row = r.rows[0];
        if (!row) return fail('NOT_FOUND', 'REQUEST_NOT_FOUND', 'Solicitud no encontrada');
        return {
          ok: true as const,
          value: {
            requestId: row.id,
            status: requestStatus(row, now),
            expiresAt: row.expires_at.toISOString(),
            fingerprint: shortFingerprint(row.key_thumbprint),
            claimedBy: row.titular_name ? { displayName: row.titular_name } : null,
          },
        };
      });
    },

    /** Activa el dispositivo: la solicitud debe estar APROBADA y vigente; el nonce y la firma ya se verificaron. */
    async activate(requestId: string, thumbprint: string, ctx: DeviceContext) {
      return run(async (tx) => {
        const now = await nowOf(tx);
        const r = await tx.query<RequestRow>(
          `${REQUEST_SELECT} WHERE r.id = $1 AND r.key_thumbprint = $2 FOR UPDATE OF r`,
          [requestId, thumbprint],
        );
        const row = r.rows[0];
        if (!row) return fail('NOT_FOUND', 'REQUEST_NOT_FOUND', 'Solicitud no encontrada');
        if (row.status === 'activated')
          return fail('CONFLICT', 'ALREADY_ACTIVATED', 'La solicitud ya fue activada');
        if (row.status !== 'approved' || row.user_id === null || row.approved_by === null)
          return fail('CONFLICT', 'NOT_APPROVED', 'La solicitud aún no está aprobada');
        if (row.expires_at <= now)
          return fail('CONFLICT', 'REQUEST_EXPIRED', 'La solicitud venció');
        const device = await tx.query<{ id: string }>(
          `INSERT INTO mobile_devices (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
          [
            row.user_id,
            row.key_thumbprint,
            JSON.stringify(row.public_key_jwk),
            row.device_label,
            row.id,
            row.approved_by,
          ],
        );
        await tx.query(`UPDATE mobile_device_requests SET status = 'activated' WHERE id = $1`, [
          row.id,
        ]);
        await recordAudit(tx, deviceAudit(ctx), {
          type: 'mobile.device_activated',
          outcome: 'success',
          subject: row.user_id,
          details: {
            requestId: row.id,
            deviceId: device.rows[0]!.id,
            fingerprint: shortFingerprint(row.key_thumbprint),
          },
        });
        return { ok: true as const, value: { deviceId: device.rows[0]!.id } };
      });
    },

    // ================================================================================================ PERSONA TITULAR (web)

    /**
     * La persona titular liga la solicitud del dispositivo a SU cuenta con el codigo que ve en la pantalla del dispositivo. Un codigo
     * conocido por un tercero no basta: se exige su sesion web, el permiso, el rol vigente, y despues la aprobacion de otra persona
     * con autoridad que confirme la huella. Intentos fallidos limitados por solicitud.
     */
    async claim(ctx: WebContext, input: { requestId: string; code: string }) {
      if (!has(ctx.grants, 'mobile_devices:enroll', 'own'))
        return fail('FORBIDDEN', 'NO_PERMISSION', 'No tiene permiso para vincular dispositivos');
      const invalidClaim = fail(
        'VALIDATION',
        'CLAIM_INVALID',
        'El código no es válido o la solicitud ya no está disponible',
      );
      return run(async (tx) => {
        const now = await nowOf(tx);
        // Una vinculacion VENCIDA de esta persona no la bloquea: se cierra (sin borrar) antes de reclamar otra.
        await tx.query(
          `UPDATE mobile_device_requests SET status = 'cancelled'
            WHERE user_id = $1 AND status IN ('claimed', 'approved') AND expires_at <= $2`,
          [ctx.actorId, now],
        );
        // Limite COMPARTIDO por cuenta autenticada: los reclamos fallidos ya quedan en el registro de auditoria (indice por persona).
        const failures = await tx.query<{ n: number; oldest: Date | null }>(
          `SELECT count(*)::int AS n, min(occurred_at) AS oldest FROM audit_events
            WHERE event_type = 'mobile.device_claim_failed' AND subject_user_id = $1
              AND occurred_at > now() - make_interval(secs => $2)`,
          [ctx.actorId, config.claimFailureWindowSeconds],
        );
        if (failures.rows[0]!.n >= config.maxClaimFailuresPerUser)
          return fail(
            'RATE_LIMITED',
            'CLAIM_RATE_LIMITED',
            'Demasiados intentos. Intente más tarde.',
            Math.max(
              1,
              Math.ceil(
                (addSeconds(
                  failures.rows[0]!.oldest ?? now,
                  config.claimFailureWindowSeconds,
                ).getTime() -
                  Date.now()) /
                  1000,
              ),
            ),
          );
        const r = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [
          input.requestId,
        ]);
        const row = r.rows[0];
        if (!row || row.status !== 'pending' || row.expires_at <= now) {
          await recordAudit(tx, ctx, {
            type: 'mobile.device_claim_failed',
            outcome: 'denied',
            subject: ctx.actorId,
            details: { reason: 'unavailable' },
          });
          return invalidClaim;
        }
        const given = hashPairingCode(input.code);
        const same = timingSafeEqual(given, row.pairing_code_hash);
        if (!same) {
          const closes = row.claim_failures + 1 >= config.maxClaimFailures;
          await tx.query(
            `UPDATE mobile_device_requests SET claim_failures = claim_failures + 1, status = CASE WHEN $2 THEN 'cancelled' ELSE status END WHERE id = $1`,
            [row.id, closes],
          );
          await recordAudit(tx, ctx, {
            type: 'mobile.device_claim_failed',
            outcome: 'denied',
            subject: ctx.actorId,
            details: { requestId: row.id, reason: 'code_mismatch', locked: closes },
          });
          return invalidClaim;
        }
        await tx.query(
          `UPDATE mobile_device_requests SET status = 'claimed', user_id = $2 WHERE id = $1`,
          [row.id, ctx.actorId],
        );
        await recordAudit(tx, ctx, {
          type: 'mobile.device_claimed',
          outcome: 'success',
          subject: ctx.actorId,
          details: { requestId: row.id, fingerprint: shortFingerprint(row.key_thumbprint) },
        });
        const fresh = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [row.id]);
        return { ok: true as const, value: requestDto(fresh.rows[0]!, now) };
      });
    },

    /** Solicitudes en curso y dispositivos de la propia persona (nunca de otra). */
    async listMine(ctx: WebContext) {
      if (!has(ctx.grants, 'mobile_devices:enroll', 'own'))
        return fail('FORBIDDEN', 'NO_PERMISSION', 'No tiene permiso para ver sus dispositivos');
      return run(async (tx) => {
        const now = await nowOf(tx);
        const reqs = await tx.query<RequestRow>(
          `${REQUEST_SELECT} WHERE r.user_id = $1 AND r.status IN ('claimed', 'approved') AND r.expires_at > $2 ORDER BY r.created_at`,
          [ctx.actorId, now],
        );
        const devs = await tx.query<DeviceRow>(
          `${DEVICE_SELECT} WHERE d.user_id = $1 ORDER BY d.registered_at DESC LIMIT 50`,
          [ctx.actorId],
        );
        return {
          ok: true as const,
          value: {
            requests: reqs.rows.map((x) => requestDto(x, now)),
            devices: devs.rows.map(deviceDto),
          },
        };
      });
    },

    // ================================================================================================ AUTORIDAD (web)

    async listForAuthority(ctx: WebContext) {
      if (!has(ctx.grants, 'mobile_devices:manage', 'all'))
        return fail(
          'FORBIDDEN',
          'NO_PERMISSION',
          'No tiene permiso para administrar dispositivos móviles',
        );
      return run(async (tx) => {
        const now = await nowOf(tx);
        const reqs = await tx.query<RequestRow>(
          `${REQUEST_SELECT} WHERE r.status IN ('claimed', 'approved') AND r.expires_at > $1 ORDER BY r.created_at`,
          [now],
        );
        const devs = await tx.query<DeviceRow>(
          `${DEVICE_SELECT} ORDER BY d.registered_at DESC LIMIT 200`,
        );
        return {
          ok: true as const,
          value: {
            requests: reqs.rows.map((x) => requestDto(x, now)),
            devices: devs.rows.map(deviceDto),
          },
        };
      });
    },

    /**
     * Aprueba una solicitud YA reclamada por su titular. La autoridad escribe la huella que ve en la pantalla DEL DISPOSITIVO
     * (verificacion presencial): si no coincide con la de la solicitud, no se aprueba. Nadie aprueba su propia vinculacion.
     */
    async approve(ctx: WebContext, requestId: string, input: { fingerprint: string }) {
      if (!has(ctx.grants, 'mobile_devices:manage', 'all'))
        return fail('FORBIDDEN', 'NO_PERMISSION', 'No tiene permiso para aprobar vinculaciones');
      return run(async (tx) => {
        const now = await nowOf(tx);
        const r = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [
          requestId,
        ]);
        const row = r.rows[0];
        if (!row) return fail('NOT_FOUND', 'REQUEST_NOT_FOUND', 'Solicitud no encontrada');
        if (row.status !== 'claimed')
          return fail('CONFLICT', 'NOT_CLAIMED', 'La solicitud no está lista para aprobarse');
        if (row.expires_at <= now)
          return fail('CONFLICT', 'REQUEST_EXPIRED', 'La solicitud venció');
        const expected = shortFingerprint(row.key_thumbprint);
        const a = Buffer.from(normalizeFingerprint(input.fingerprint));
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          await recordAudit(tx, ctx, {
            type: 'mobile.device_approval_denied',
            outcome: 'denied',
            subject: row.user_id,
            details: { requestId: row.id, reason: 'fingerprint_mismatch' },
          });
          return fail(
            'VALIDATION',
            'FINGERPRINT_MISMATCH',
            'La huella no coincide con la del dispositivo',
          );
        }
        await tx.query(
          `UPDATE mobile_device_requests SET status = 'approved', approved_by = $2 WHERE id = $1`,
          [row.id, ctx.actorId],
        );
        await recordAudit(tx, ctx, {
          type: 'mobile.device_approved',
          outcome: 'success',
          subject: row.user_id,
          details: { requestId: row.id, fingerprint: expected },
        });
        const fresh = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [row.id]);
        return { ok: true as const, value: requestDto(fresh.rows[0]!, now) };
      });
    },

    /** Rechaza (autoridad: `mobile_devices:manage`) o cancela (la propia persona titular: `mobile_devices:enroll`, solo la suya). */
    async closeRequest(ctx: WebContext, requestId: string, mode: 'reject' | 'cancel') {
      const manage = has(ctx.grants, 'mobile_devices:manage', 'all');
      const enroll = has(ctx.grants, 'mobile_devices:enroll', 'own');
      if (mode === 'reject' ? !manage : !enroll)
        return fail('FORBIDDEN', 'NO_PERMISSION', 'No tiene permiso para esta operación');
      return run(async (tx) => {
        const now = await nowOf(tx);
        const r = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [
          requestId,
        ]);
        const row = r.rows[0];
        if (!row || (mode === 'cancel' && row.user_id !== ctx.actorId))
          return fail('NOT_FOUND', 'REQUEST_NOT_FOUND', 'Solicitud no encontrada');
        if (!['pending', 'claimed', 'approved'].includes(row.status))
          return fail('CONFLICT', 'REQUEST_CLOSED', 'La solicitud ya terminó');
        await tx.query(
          `UPDATE mobile_device_requests SET status = $2, closed_by = $3 WHERE id = $1`,
          [row.id, mode === 'reject' ? 'rejected' : 'cancelled', ctx.actorId],
        );
        await recordAudit(tx, ctx, {
          type: mode === 'reject' ? 'mobile.device_rejected' : 'mobile.device_cancelled',
          outcome: 'success',
          subject: row.user_id,
          details: { requestId: row.id },
        });
        void now;
        return { ok: true as const, value: { id: row.id } };
      });
    },

    /**
     * Revoca un dispositivo y sus sesiones EN LA MISMA transaccion. Como AUTORIDAD (`mobile_devices:manage`) cualquiera; como PERSONA
     * TITULAR (`mobile_devices:enroll`) solo los suyos (uno ajeno responde 404, igual que uno inexistente).
     */
    async revokeDevice(
      ctx: WebContext,
      deviceId: string,
      reason: 'titular' | 'authority' | 'lost',
      as: 'authority' | 'titular' = 'authority',
    ) {
      const allowed =
        as === 'authority'
          ? has(ctx.grants, 'mobile_devices:manage', 'all')
          : has(ctx.grants, 'mobile_devices:enroll', 'own');
      if (!allowed)
        return fail('FORBIDDEN', 'NO_PERMISSION', 'No tiene permiso para revocar dispositivos');
      return run(async (tx) => {
        const r = await tx.query<DeviceRow>(`${DEVICE_SELECT} WHERE d.id = $1 FOR UPDATE OF d`, [
          deviceId,
        ]);
        const row = r.rows[0];
        if (!row || (as === 'titular' && row.user_id !== ctx.actorId))
          return fail('NOT_FOUND', 'DEVICE_NOT_FOUND', 'Dispositivo no encontrado');
        if (row.status === 'revoked')
          return fail('CONFLICT', 'ALREADY_REVOKED', 'El dispositivo ya está revocado');
        await tx.query(
          `UPDATE mobile_devices SET status = 'revoked', revoked_by = $2, revoke_reason = $3 WHERE id = $1`,
          [row.id, ctx.actorId, reason],
        );
        const sessions = await revokeDeviceSessions(tx, row.id, 'device_revoked', ctx.actorId);
        await recordAudit(tx, ctx, {
          type: 'mobile.device_revoked',
          outcome: 'success',
          subject: row.user_id,
          details: { deviceId: row.id, reason, sessionsRevoked: sessions },
        });
        return { ok: true as const, value: { id: row.id, sessionsRevoked: sessions } };
      });
    },

    // ================================================================================================ SESIONES MOVILES

    /**
     * Abre una sesion movil para un dispositivo ACTIVO (la posesion de la clave ya se verifico con el nonce). Revalida cuenta y rol;
     * una sesion activa por dispositivo (la anterior se revoca 'replaced'). Devuelve los tokens UNA vez (solo se guardan sus hashes).
     */
    async issueSession(thumbprint: string, ctx: DeviceContext): Promise<MobileResult<TokenSet>> {
      return run(async (tx) => {
        const now = await nowOf(tx);
        const d = await tx.query<{
          id: string;
          user_id: string;
          status: string;
          registered_at: Date;
        }>(
          `SELECT id, user_id, status, registered_at FROM mobile_devices WHERE key_thumbprint = $1 FOR UPDATE`,
          [thumbprint],
        );
        const dev = d.rows[0];
        if (!dev) return fail('UNAUTHENTICATED', 'UNKNOWN_DEVICE', 'Dispositivo no registrado');
        if (dev.status !== 'active') {
          await recordAudit(tx, deviceAudit(ctx), {
            type: 'mobile.access_denied',
            outcome: 'denied',
            subject: dev.user_id,
            details: { deviceId: dev.id, reason: 'device_revoked', stage: 'token' },
          });
          return fail('UNAUTHENTICATED', 'DEVICE_REVOKED', 'El dispositivo fue revocado');
        }
        const elig = await tx.query<{ ok: boolean; must_change: boolean }>(
          `SELECT mobile_user_eligible($1, $2) AS ok, (SELECT must_change_password FROM users WHERE id = $1) AS must_change`,
          [dev.user_id, dev.registered_at],
        );
        if (!elig.rows[0]!.ok) {
          await recordAudit(tx, deviceAudit(ctx), {
            type: 'mobile.access_denied',
            outcome: 'denied',
            subject: dev.user_id,
            details: { deviceId: dev.id, reason: 'not_eligible', stage: 'token' },
          });
          return fail('FORBIDDEN', 'NOT_ELIGIBLE', 'La cuenta no puede abrir sesiones móviles');
        }
        if (elig.rows[0]!.must_change)
          return fail(
            'FORBIDDEN',
            'PASSWORD_CHANGE_REQUIRED',
            'La cuenta debe cambiar su contraseña en el portal',
          );
        await revokeDeviceSessions(tx, dev.id, 'replaced', null);
        const access = newToken();
        const refresh = newToken();
        const absolute = addSeconds(now, config.absoluteTtlSeconds);
        const accessExp = new Date(
          Math.min(addSeconds(now, config.accessTtlSeconds).getTime(), absolute.getTime()),
        );
        const idleExp = new Date(
          Math.min(addSeconds(now, config.idleTtlSeconds).getTime(), absolute.getTime()),
        );
        await tx.query(
          `INSERT INTO mobile_sessions (device_id, user_id, access_hash, refresh_hash, created_at, access_expires_at, idle_expires_at,
                                        absolute_expires_at, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10)`,
          [
            dev.id,
            dev.user_id,
            hashOfToken(access),
            hashOfToken(refresh),
            now,
            accessExp,
            idleExp,
            absolute,
            ctx.ip ?? null,
            ctx.userAgent?.slice(0, 256) ?? null,
          ],
        );
        await tx.query(`UPDATE mobile_devices SET last_seen_at = $2 WHERE id = $1`, [dev.id, now]);
        await recordAudit(tx, deviceAudit(ctx), {
          type: 'mobile.session_issued',
          outcome: 'success',
          subject: dev.user_id,
          details: { deviceId: dev.id },
        });
        return {
          ok: true as const,
          value: {
            accessToken: access,
            refreshToken: refresh,
            accessExpiresAt: accessExp,
            idleExpiresAt: idleExp,
            sessionExpiresAt: absolute,
            deviceId: dev.id,
          },
        };
      });
    },

    /**
     * Renueva con rotacion: el token de renovacion se gasta (uno nuevo reemplaza al anterior). Si el ANTERIOR se presenta otra vez
     * (reuso: copia o robo) la sesion completa se revoca. La renovacion exige la misma clave del dispositivo y revalida todo.
     */
    async refresh(
      refreshToken: string,
      thumbprint: string,
      ctx: DeviceContext,
    ): Promise<MobileResult<TokenSet>> {
      const hash = hashSessionToken(refreshToken);
      if (!hash) return fail('UNAUTHENTICATED', 'INVALID_TOKEN', 'Credencial no válida');
      return run(async (tx) => {
        const now = await nowOf(tx);
        const r = await tx.query<{
          id: string;
          device_id: string;
          user_id: string;
          revoked_at: Date | null;
          idle_expires_at: Date;
          absolute_expires_at: Date;
          key_thumbprint: string;
          dev_status: string;
          registered_at: Date;
        }>(
          `SELECT s.id, s.device_id, s.user_id, s.revoked_at, s.idle_expires_at, s.absolute_expires_at, d.key_thumbprint,
                  d.status AS dev_status, d.registered_at
             FROM mobile_sessions s JOIN mobile_devices d ON d.id = s.device_id
            WHERE s.refresh_hash = $1 FOR UPDATE OF s`,
          [hash],
        );
        const s = r.rows[0];
        if (!s) {
          const reused = await tx.query<{ id: string; user_id: string; revoked_at: Date | null }>(
            `SELECT id, user_id, revoked_at FROM mobile_sessions WHERE previous_refresh_hash = $1 FOR UPDATE`,
            [hash],
          );
          const old = reused.rows[0];
          if (old) {
            if (!old.revoked_at)
              await tx.query(
                `UPDATE mobile_sessions SET revoked_reason = 'refresh_reuse' WHERE id = $1`,
                [old.id],
              );
            await recordAudit(tx, deviceAudit(ctx), {
              type: 'mobile.session_reuse',
              outcome: 'denied',
              subject: old.user_id,
              details: { sessionId: old.id },
            });
            return fail(
              'UNAUTHENTICATED',
              'REFRESH_REUSED',
              'La credencial de renovación ya se usó: la sesión se cerró',
            );
          }
          return fail('UNAUTHENTICATED', 'INVALID_TOKEN', 'Credencial no válida');
        }
        if (s.key_thumbprint !== thumbprint) {
          await recordAudit(tx, deviceAudit(ctx), {
            type: 'mobile.access_denied',
            outcome: 'denied',
            subject: s.user_id,
            details: { deviceId: s.device_id, reason: 'wrong_key', stage: 'refresh' },
          });
          return fail('UNAUTHENTICATED', 'INVALID_TOKEN', 'Credencial no válida');
        }
        if (s.revoked_at)
          return fail('UNAUTHENTICATED', 'SESSION_REVOKED', 'La sesión fue revocada');
        if (s.absolute_expires_at <= now || s.idle_expires_at <= now)
          return fail('UNAUTHENTICATED', 'SESSION_EXPIRED', 'La sesión venció');
        if (s.dev_status !== 'active') {
          await tx.query(
            `UPDATE mobile_sessions SET revoked_reason = 'device_revoked' WHERE id = $1`,
            [s.id],
          );
          return fail('UNAUTHENTICATED', 'DEVICE_REVOKED', 'El dispositivo fue revocado');
        }
        const elig = await tx.query<{ ok: boolean }>(`SELECT mobile_user_eligible($1, $2) AS ok`, [
          s.user_id,
          s.registered_at,
        ]);
        if (!elig.rows[0]!.ok) {
          await tx.query(
            `UPDATE mobile_sessions SET revoked_reason = 'account_inactive' WHERE id = $1`,
            [s.id],
          );
          await recordAudit(tx, deviceAudit(ctx), {
            type: 'mobile.access_denied',
            outcome: 'denied',
            subject: s.user_id,
            details: { deviceId: s.device_id, reason: 'not_eligible', stage: 'refresh' },
          });
          return fail('FORBIDDEN', 'NOT_ELIGIBLE', 'La cuenta ya no puede usar sesiones móviles');
        }
        const access = newToken();
        const refreshNew = newToken();
        const accessExp = new Date(
          Math.min(
            addSeconds(now, config.accessTtlSeconds).getTime(),
            s.absolute_expires_at.getTime(),
          ),
        );
        const idleExp = new Date(
          Math.min(
            addSeconds(now, config.idleTtlSeconds).getTime(),
            s.absolute_expires_at.getTime(),
          ),
        );
        await tx.query(
          `UPDATE mobile_sessions SET previous_refresh_hash = refresh_hash, refresh_hash = $2, access_hash = $3, access_expires_at = $4,
                  idle_expires_at = $5, refresh_count = refresh_count + 1 WHERE id = $1`,
          [s.id, hashOfToken(refreshNew), hashOfToken(access), accessExp, idleExp],
        );
        await tx.query(`UPDATE mobile_devices SET last_seen_at = $2 WHERE id = $1`, [
          s.device_id,
          now,
        ]);
        await recordAudit(tx, deviceAudit(ctx), {
          type: 'mobile.session_refreshed',
          outcome: 'success',
          subject: s.user_id,
          details: { deviceId: s.device_id, sessionId: s.id },
        });
        return {
          ok: true as const,
          value: {
            accessToken: access,
            refreshToken: refreshNew,
            accessExpiresAt: accessExp,
            idleExpiresAt: idleExp,
            sessionExpiresAt: s.absolute_expires_at,
            deviceId: s.device_id,
          },
        };
      });
    },

    /**
     * Valida un token de acceso para UNA peticion (la prueba DPoP y su `ath` ya se verificaron con `thumbprint`): sesion vigente y
     * LIGADA a esa clave, dispositivo activo, cuenta y rol vigentes. Los grants salen de la base y se limitan a los permisos moviles.
     */
    async verifyAccess(
      accessToken: string,
      thumbprint: string,
      /** `jti` de la prueba: se registra SOLO cuando el token y la clave ya coinciden con una sesion vigente (no antes). */
      proofJti: string,
    ): Promise<{ ok: true; identity: MobileIdentity } | { ok: false; reason: AccessFailure }> {
      const hash = hashSessionToken(accessToken);
      if (!hash) return { ok: false, reason: 'invalid_token' };
      return store.transaction(async (tx) => {
        const now = await nowOf(tx);
        const r = await tx.query<{
          id: string;
          device_id: string;
          user_id: string;
          created_at: Date;
          revoked_at: Date | null;
          access_expires_at: Date;
          idle_expires_at: Date;
          absolute_expires_at: Date;
          key_thumbprint: string;
          dev_status: string;
          registered_at: Date;
        }>(
          `SELECT s.id, s.device_id, s.user_id, s.created_at, s.revoked_at, s.access_expires_at, s.idle_expires_at, s.absolute_expires_at,
                  d.key_thumbprint, d.status AS dev_status, d.registered_at
             FROM mobile_sessions s JOIN mobile_devices d ON d.id = s.device_id WHERE s.access_hash = $1`,
          [hash],
        );
        const s = r.rows[0];
        if (!s) return { ok: false as const, reason: 'invalid_token' as const };
        // Un token robado SIN la clave privada no sirve: la prueba debe ser de la clave del dispositivo de esta sesion.
        if (s.key_thumbprint !== thumbprint)
          return { ok: false as const, reason: 'wrong_key' as const };
        if (s.revoked_at) return { ok: false as const, reason: 'session_revoked' as const };
        if (s.absolute_expires_at <= now)
          return { ok: false as const, reason: 'session_expired' as const };
        if (s.access_expires_at <= now)
          return { ok: false as const, reason: 'token_expired' as const };
        if (s.dev_status !== 'active')
          return { ok: false as const, reason: 'device_revoked' as const };
        // Anti-replay compartido y atomico: solo una sesion REAL y vigente de ESTA clave puede dejar estado.
        const proof = await recordProof(tx, thumbprint, proofJti, now);
        if (proof !== 'ok')
          return {
            ok: false as const,
            reason: proof === 'replay' ? ('replay' as const) : ('proof_limit' as const),
          };
        const user = await tx.query<{ ok: boolean; must_change: boolean }>(
          `SELECT mobile_user_eligible($1, $2) AS ok, (SELECT must_change_password FROM users WHERE id = $1) AS must_change`,
          [s.user_id, s.registered_at],
        );
        if (!user.rows[0]!.ok) return { ok: false as const, reason: 'not_eligible' as const };
        if (user.rows[0]!.must_change)
          return { ok: false as const, reason: 'password_change_required' as const };
        const roles = await tx.query<{ key: string }>(
          `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND ur.revoked_at IS NULL ORDER BY r.key`,
          [s.user_id],
        );
        const grants = await tx.query<{ permission: string; scope: Scope }>(
          `SELECT DISTINCT p.key AS permission, rp.scope
             FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE ur.user_id = $1 AND ur.revoked_at IS NULL ORDER BY p.key, rp.scope`,
          [s.user_id],
        );
        await tx.query(
          `UPDATE mobile_devices SET last_seen_at = $2 WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2::timestamptz - interval '1 minute')`,
          [s.device_id, now],
        );
        return {
          ok: true as const,
          identity: {
            deviceId: s.device_id,
            sessionId: s.id,
            thumbprint,
            userId: s.user_id,
            roles: roles.rows.map((x) => x.key),
            grants: grants.rows.filter(
              (g) =>
                MOBILE_ALLOWED_PERMISSIONS.has(g.permission) ||
                (config.attendanceRead === true &&
                  g.permission === MOBILE_ATTENDANCE_READ_PERMISSION &&
                  g.scope === 'assigned_groups') ||
                (config.attendanceRead === true &&
                  config.attendanceWrite === true &&
                  g.permission === MOBILE_ATTENDANCE_CAPTURE_PERMISSION &&
                  g.scope === 'assigned_groups'),
            ),
            createdAt: s.created_at,
            accessExpiresAt: s.access_expires_at,
            idleExpiresAt: s.idle_expires_at,
            sessionExpiresAt: s.absolute_expires_at,
          },
        };
      });
    },

    /** Cierra la sesion movil actual. */
    async logout(sessionId: string, userId: string, ctx: DeviceContext): Promise<boolean> {
      return store.transaction(async (tx) => {
        const r = await tx.query(
          `UPDATE mobile_sessions SET revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
          [sessionId],
        );
        if (r.rows.length === 0) return false;
        await recordAudit(tx, deviceAudit(ctx), {
          type: 'mobile.session_revoked',
          outcome: 'success',
          subject: userId,
          details: { sessionId, reason: 'logout' },
        });
        return true;
      });
    },
  };
}

export type MobileAuthService = ReturnType<typeof createMobileAuthService>;
export type { AuditContext };
