import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, inet } from './_columns.js';
import { users } from './auth.js';

/**
 * Autenticacion movil AISLADA (prototipo de sandbox; ver docs/decisions/0005-android-autenticacion-movil.md, propuesta NO aceptada).
 *
 * Tres tablas, sin borrado fisico (FK RESTRICT + triggers) y con las reglas de transicion en la migracion 0011:
 *  - `mobile_device_requests`: solicitud de vinculacion de UN dispositivo. La crea el propio dispositivo (anonima, solo con su clave
 *    PUBLICA), la RECLAMA la persona titular con su sesion web y la APRUEBA otra persona con autoridad que confirma la huella de la
 *    clave. Despues el dispositivo prueba la posesion de la clave privada y se registra. Caduca en minutos.
 *  - `mobile_devices`: dispositivo registrado (cuenta + clave publica). Solo pasa de `active` a `revoked`; una clave revocada no se
 *    vuelve a registrar nunca (UNIQUE sobre la huella).
 *  - `mobile_sessions`: sesion movil de corta duracion LIGADA al dispositivo (credenciales opacas guardadas solo como SHA-256; el
 *    token de acceso va con una prueba DPoP firmada con la clave del dispositivo). Una sola activa por dispositivo.
 * Nunca se guardan claves privadas, tokens en claro ni contrasenas.
 */

export const MOBILE_REQUEST_STATUSES = [
  'pending',
  'claimed',
  'approved',
  'activated',
  'rejected',
  'cancelled',
] as const;

export const MOBILE_REVOKE_REASONS = ['titular', 'authority', 'lost', 'replaced'] as const;

export const MOBILE_SESSION_REVOKE_REASONS = [
  'logout',
  'device_revoked',
  'replaced',
  'account_inactive',
  'role_changed',
  'refresh_reuse',
  'authority',
] as const;

const jwkOk = (c: unknown) =>
  sql`jsonb_typeof(${c}) = 'object' AND (${c} ->> 'kty') = 'EC' AND (${c} ->> 'crv') = 'P-256'
      AND (${c} ->> 'x') ~ '^[A-Za-z0-9_-]{43}$' AND (${c} ->> 'y') ~ '^[A-Za-z0-9_-]{43}$' AND (${c} -> 'd') IS NULL`;

export const mobileDeviceRequests = pgTable(
  'mobile_device_requests',
  {
    id: id(),
    /** NULL hasta que la persona titular reclama la solicitud con su sesion web. */
    userId: uuid('user_id'),
    /** Huella RFC 7638 (SHA-256 del JWK canonico, base64url) de la clave publica del dispositivo. */
    keyThumbprint: text('key_thumbprint').notNull(),
    publicKeyJwk: jsonb('public_key_jwk').notNull(),
    deviceLabel: text('device_label').notNull(),
    platform: text('platform').notNull().default('android'),
    /** SHA-256 del codigo de emparejamiento (el codigo solo se muestra en el dispositivo; nunca se guarda en claro). */
    pairingCodeHash: bytea('pairing_code_hash').notNull(),
    /** Intentos fallidos de reclamo con el codigo; al llegar al limite la solicitud se cancela. */
    claimFailures: smallint('claim_failures').notNull().default(0),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    requestedIp: inet('requested_ip'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'mdr_user_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'mdr_approved_by_fkey',
      columns: [t.approvedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'mdr_closed_by_fkey', columns: [t.closedBy], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('mdr_thumbprint_format', sql`${t.keyThumbprint} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('mdr_jwk_valid', jwkOk(t.publicKeyJwk)),
    check('mdr_label_length', sql`char_length(btrim(${t.deviceLabel})) BETWEEN 1 AND 60`),
    check('mdr_platform_values', sql`${t.platform} IN ('android')`),
    check('mdr_code_hash_length', sql`octet_length(${t.pairingCodeHash}) = 32`),
    check('mdr_claim_failures_range', sql`${t.claimFailures} BETWEEN 0 AND 10`),
    check(
      'mdr_status_values',
      sql`${t.status} IN ('pending', 'claimed', 'approved', 'activated', 'rejected', 'cancelled')`,
    ),
    check(
      'mdr_expiry_window',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '30 minutes'`,
    ),
    // La persona titular existe en cuanto se reclama; sin reclamo no hay titular.
    check(
      'mdr_claim_consistent',
      sql`(${t.status} <> 'pending' OR ${t.userId} IS NULL) AND (${t.status} NOT IN ('claimed', 'approved', 'activated') OR (${t.userId} IS NOT NULL AND ${t.claimedAt} IS NOT NULL))`,
    ),
    // La aprobacion es completa y nunca de la propia persona titular (separacion de funciones).
    check(
      'mdr_approval_consistent',
      sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL) AND (${t.status} NOT IN ('approved', 'activated') OR ${t.approvedBy} IS NOT NULL) AND (${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.userId})`,
    ),
    check(
      'mdr_activation_consistent',
      sql`(${t.status} = 'activated') = (${t.activatedAt} IS NOT NULL)`,
    ),
    check(
      'mdr_closed_consistent',
      sql`(${t.status} IN ('rejected', 'cancelled')) = (${t.closedAt} IS NOT NULL)`,
    ),
    // Una solicitud abierta por clave y una por persona titular (frena la acumulacion de solicitudes pendientes de aprobar).
    uniqueIndex('mdr_open_thumbprint_key')
      .on(t.keyThumbprint)
      .where(sql`${t.status} IN ('pending', 'claimed', 'approved')`),
    uniqueIndex('mdr_open_user_key')
      .on(t.userId)
      .where(sql`${t.status} IN ('claimed', 'approved')`),
    index('mdr_status_expires_idx').on(t.status, t.expiresAt),
    // Limite compartido de solicitudes por IP y ventana (la anonimizacion por retencion pone la IP en NULL y las saca del indice).
    index('mdr_ip_created_idx')
      .on(t.requestedIp, t.createdAt)
      .where(sql`${t.requestedIp} IS NOT NULL`),
  ],
);

export const mobileDevices = pgTable(
  'mobile_devices',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    keyThumbprint: text('key_thumbprint').notNull(),
    publicKeyJwk: jsonb('public_key_jwk').notNull(),
    label: text('label').notNull(),
    requestId: uuid('request_id').notNull(),
    approvedBy: uuid('approved_by').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('active'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** NULL cuando la revocacion la hizo el sistema; por ahora siempre hay persona. */
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    // Una clave jamas se registra dos veces (ni siquiera despues de revocarla): un dispositivo "recuperado" debe generar clave nueva.
    unique('md_thumbprint_key').on(t.keyThumbprint),
    unique('md_request_key').on(t.requestId),
    // Soporta la FK compuesta desde mobile_sessions (sesion y dispositivo siempre de la misma cuenta).
    unique('md_id_user_key').on(t.id, t.userId),
    foreignKey({ name: 'md_user_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'md_request_fkey',
      columns: [t.requestId],
      foreignColumns: [mobileDeviceRequests.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'md_approved_by_fkey', columns: [t.approvedBy], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'md_revoked_by_fkey', columns: [t.revokedBy], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('md_thumbprint_format', sql`${t.keyThumbprint} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('md_jwk_valid', jwkOk(t.publicKeyJwk)),
    check('md_label_length', sql`char_length(btrim(${t.label})) BETWEEN 1 AND 60`),
    check('md_status_values', sql`${t.status} IN ('active', 'revoked')`),
    check(
      'md_revoke_reason_values',
      sql`${t.revokeReason} IS NULL OR ${t.revokeReason} IN ('titular', 'authority', 'lost', 'replaced')`,
    ),
    check(
      'md_revocation_consistent',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL) AND (${t.revokedAt} IS NULL) = (${t.revokeReason} IS NULL)`,
    ),
    index('md_user_active_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * Estado EFIMERO de seguridad del canal movil, COMPARTIDO entre instancias (sustituye a las cachas en memoria):
 *  - `mobile_proof_jtis`: cada prueba DPoP aceptada (clave + SHA-256 de su `jti`). La PRIMARY KEY hace atomico el rechazo de una
 *    repeticion: dos instancias que reciben la misma prueba compiten por el mismo INSERT y solo una lo logra. No se guarda el JWT, ni
 *    la prueba, ni la clave publica; solo la huella de la clave (publica) y el hash del identificador.
 *  - `mobile_nonces`: desafios emitidos por el servidor (SHA-256 del valor) ligados a una clave, de vida corta y de UN SOLO USO por
 *    operacion de negocio (activar, abrir o renovar sesion). Se gastan con UPDATE de `consumed_at` (sin DELETE).
 * La API NO borra: las filas vencidas las retira, con alcance limitado, el propietario (ver docs/architecture/auth-rbac.md).
 */
export const mobileProofJtis = pgTable(
  'mobile_proof_jtis',
  {
    /** Huella RFC 7638 de la clave publica que firmo la prueba (jkt). */
    keyThumbprint: text('key_thumbprint').notNull(),
    /** SHA-256 del `jti` (el identificador no se guarda en claro: lo elige el cliente). */
    jtiHash: bytea('jti_hash').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Fin de la ventana en la que la prueba aun podria aceptarse (iat +/- tolerancia): despues la fila ya no protege nada. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'mpj_pkey', columns: [t.keyThumbprint, t.jtiHash] }),
    check('mpj_thumbprint_format', sql`${t.keyThumbprint} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('mpj_jti_hash_length', sql`octet_length(${t.jtiHash}) = 32`),
    check(
      'mpj_expiry_window',
      sql`${t.expiresAt} > ${t.seenAt} AND ${t.expiresAt} <= ${t.seenAt} + interval '15 minutes'`,
    ),
    index('mpj_key_expires_idx').on(t.keyThumbprint, t.expiresAt),
    index('mpj_expires_idx').on(t.expiresAt),
  ],
);

export const mobileNonces = pgTable(
  'mobile_nonces',
  {
    /** SHA-256 del nonce (el valor solo viaja una vez, hacia el dispositivo). */
    nonceHash: bytea('nonce_hash').primaryKey().notNull(),
    keyThumbprint: text('key_thumbprint').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Se fija una sola vez (NULL -> hora): el nonce ya no sirve. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('mn_thumbprint_format', sql`${t.keyThumbprint} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('mn_nonce_hash_length', sql`octet_length(${t.nonceHash}) = 32`),
    check(
      'mn_expiry_window',
      sql`${t.expiresAt} > ${t.issuedAt} AND ${t.expiresAt} <= ${t.issuedAt} + interval '15 minutes'`,
    ),
    check('mn_consumed_order', sql`${t.consumedAt} IS NULL OR ${t.consumedAt} >= ${t.issuedAt}`),
    index('mn_key_expires_idx').on(t.keyThumbprint, t.expiresAt),
    index('mn_expires_idx').on(t.expiresAt),
  ],
);

export const mobileSessions = pgTable(
  'mobile_sessions',
  {
    id: id(),
    deviceId: uuid('device_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** SHA-256 del token de acceso y del token de renovacion; los tokens nunca se guardan. */
    accessHash: bytea('access_hash').notNull(),
    refreshHash: bytea('refresh_hash').notNull(),
    /** Renovacion anterior: si alguien la vuelve a presentar (reuso) la sesion completa se revoca. */
    previousRefreshHash: bytea('previous_refresh_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    /** Caducidad por inactividad de la renovacion; se corre en cada renovacion sin superar la absoluta. */
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    refreshCount: integer('refresh_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    revokedBy: uuid('revoked_by'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    unique('ms_access_hash_key').on(t.accessHash),
    unique('ms_refresh_hash_key').on(t.refreshHash),
    foreignKey({
      name: 'ms_device_user_fkey',
      columns: [t.deviceId, t.userId],
      foreignColumns: [mobileDevices.id, mobileDevices.userId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({ name: 'ms_revoked_by_fkey', columns: [t.revokedBy], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('ms_access_hash_length', sql`octet_length(${t.accessHash}) = 32`),
    check('ms_refresh_hash_length', sql`octet_length(${t.refreshHash}) = 32`),
    check(
      'ms_previous_hash_length',
      sql`${t.previousRefreshHash} IS NULL OR octet_length(${t.previousRefreshHash}) = 32`,
    ),
    check(
      'ms_expiry_order',
      sql`${t.absoluteExpiresAt} > ${t.createdAt} AND ${t.idleExpiresAt} <= ${t.absoluteExpiresAt} AND ${t.accessExpiresAt} <= ${t.absoluteExpiresAt}`,
    ),
    check('ms_refresh_count_nonneg', sql`${t.refreshCount} >= 0`),
    check(
      'ms_revoked_reason_values',
      sql`${t.revokedReason} IS NULL OR ${t.revokedReason} IN ('logout', 'device_revoked', 'replaced', 'account_inactive', 'role_changed', 'refresh_reuse', 'authority')`,
    ),
    check('ms_revocation_consistent', sql`(${t.revokedAt} IS NULL) = (${t.revokedReason} IS NULL)`),
    check(
      'ms_user_agent_length',
      sql`${t.userAgent} IS NULL OR char_length(${t.userAgent}) <= 256`,
    ),
    // Una sola sesion movil activa por dispositivo: abrir otra revoca la anterior ('replaced').
    uniqueIndex('ms_one_active_per_device')
      .on(t.deviceId)
      .where(sql`${t.revokedAt} IS NULL`),
    index('ms_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
