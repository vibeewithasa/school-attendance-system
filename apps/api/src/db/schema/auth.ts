import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { bytea, id, inet, timestamps, xid8 } from './_columns.js';

/**
 * Autenticacion y autorizacion (RBAC). Ver docs/architecture/auth-rbac.md y ADR 0004.
 *
 * Reglas de integridad que Drizzle no expresa (triggers) viven en la migracion manual
 * 0004_auth_integrity: auditoria append-only, validacion de quien concede un rol, bootstrap,
 * y revocacion automatica de sesiones.
 *
 * Separacion de dominios: cada cuenta y cada rol pertenecen a un dominio ('school' | 'technical').
 * Una cuenta solo puede tener roles de su propio dominio (FK compuesta), y un rol solo puede
 * contener permisos de su dominio o 'shared' (FK compuesta). Asi un administrador tecnico no puede
 * obtener acceso escolar por construccion.
 */

export const ACCOUNT_DOMAINS = ['school', 'technical'] as const;

// ---------------------------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Normalizado: minusculas y sin espacios en los bordes. */
    email: text('email').notNull(),
    emailKind: text('email_kind').notNull().default('institutional'),
    /** Para correos personales debe existir antes de activar la cuenta. */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    displayName: text('display_name').notNull(),
    /** Dominio inmutable de la cuenta; limita los roles que puede recibir. */
    accountDomain: text('account_domain').notNull(),
    status: text('status').notNull().default('pending'),
    /** Cadena PHC Argon2id. NULL hasta que la persona activa su cuenta. */
    passwordHash: text('password_hash'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: smallint('failed_login_count').notNull().default(0),
    lastFailedLoginAt: timestamp('last_failed_login_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdBy: uuid('created_by'),
    ...timestamps,
  },
  (t) => [
    unique('users_email_key').on(t.email),
    // Soporta las FK compuestas (id, domain) desde user_roles.
    unique('users_id_account_domain_key').on(t.id, t.accountDomain),
    foreignKey({ name: 'users_created_by_fkey', columns: [t.createdBy], foreignColumns: [t.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('users_email_normalized', sql`${t.email} = lower(btrim(${t.email}))`),
    check(
      'users_email_format',
      sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
    ),
    check('users_email_length', sql`char_length(${t.email}) <= 254`),
    check('users_email_kind_values', sql`${t.emailKind} IN ('institutional', 'personal')`),
    check('users_display_name_length', sql`char_length(btrim(${t.displayName})) BETWEEN 1 AND 120`),
    check('users_account_domain_values', sql`${t.accountDomain} IN ('school', 'technical')`),
    check('users_status_values', sql`${t.status} IN ('pending', 'active', 'disabled')`),
    // Una cuenta activa siempre tiene contrasena y, si el correo es personal, correo verificado.
    check(
      'users_active_has_password',
      sql`${t.status} <> 'active' OR ${t.passwordHash} IS NOT NULL`,
    ),
    check(
      'users_active_email_verified',
      sql`${t.status} <> 'active' OR ${t.emailKind} = 'institutional' OR ${t.emailVerifiedAt} IS NOT NULL`,
    ),
    check('users_failed_login_count_nonneg', sql`${t.failedLoginCount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Roles y permisos (catalogo configurable; semilla en la migracion 0005)
// ---------------------------------------------------------------------------------------------

export const roles = pgTable(
  'roles',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    domain: text('domain').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    /** MFA obligatorio para quien tenga este rol (se aplica al implementar MFA, antes de usar datos reales). */
    requiresMfa: boolean('requires_mfa').notNull().default(false),
    /** Politica de sesion de este rol; se aplica la mas estricta de los roles del usuario. */
    sessionIdleMinutes: integer('session_idle_minutes').notNull().default(60),
    sessionAbsoluteMinutes: integer('session_absolute_minutes').notNull().default(720),
    /** Tope de sesiones activas; lo impone el trigger sessions_before_insert (el menor entre los roles del usuario). */
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(5),
    ...timestamps,
  },
  (t) => [
    unique('roles_key_key').on(t.key),
    unique('roles_id_domain_key').on(t.id, t.domain),
    check('roles_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{1,40}$'`),
    check('roles_domain_values', sql`${t.domain} IN ('school', 'technical')`),
    check('roles_session_idle_positive', sql`${t.sessionIdleMinutes} BETWEEN 1 AND 1440`),
    check(
      'roles_session_absolute_valid',
      sql`${t.sessionAbsoluteMinutes} BETWEEN 1 AND 10080 AND ${t.sessionIdleMinutes} <= ${t.sessionAbsoluteMinutes}`,
    ),
    check('roles_max_sessions_range', sql`${t.maxConcurrentSessions} BETWEEN 1 AND 20`),
  ],
);

export const permissions = pgTable(
  'permissions',
  {
    id: id(),
    key: text('key').notNull(),
    description: text('description').notNull().default(''),
    /** 'shared' puede asignarse a roles de cualquier dominio. */
    domain: text('domain').notNull(),
    /**
     * Permiso de autoridad (conceder roles, administrar cuentas, editar roles). Solo el propietario del
     * esquema (migraciones/DBA) puede agregarlo o quitarlo de un rol; la API no puede delegarlo.
     */
    isAuthority: boolean('is_authority').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('permissions_key_key').on(t.key),
    unique('permissions_id_domain_key').on(t.id, t.domain),
    check('permissions_key_format', sql`${t.key} ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'`),
    check('permissions_domain_values', sql`${t.domain} IN ('school', 'technical', 'shared')`),
  ],
);

/**
 * scope (significado y aplicacion en docs/architecture/auth-rbac.md §6):
 *  - all:             todos los registros del recurso.
 *  - assigned_groups: solo registros de grupos con una asignacion vigente del usuario
 *                     (prefect_group_assignments, futura). Sin asignaciones => conjunto vacio.
 *  - own:             solo registros propios del usuario.
 * Que scopes admite cada permiso lo define el catalogo en codigo (access-control/catalog.ts) y una
 * prueba verifica que la semilla lo respeta.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull(),
    roleDomain: text('role_domain').notNull(),
    permissionId: uuid('permission_id').notNull(),
    permissionDomain: text('permission_domain').notNull(),
    scope: text('scope').notNull().default('all'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'role_permissions_pkey', columns: [t.roleId, t.permissionId] }),
    foreignKey({
      name: 'role_permissions_role_fkey',
      columns: [t.roleId, t.roleDomain],
      foreignColumns: [roles.id, roles.domain],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'role_permissions_permission_fkey',
      columns: [t.permissionId, t.permissionDomain],
      foreignColumns: [permissions.id, permissions.domain],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    // Separacion de dominios: un rol solo recibe permisos de su dominio o compartidos.
    check(
      'role_permissions_domain_match',
      sql`${t.permissionDomain} = 'shared' OR ${t.permissionDomain} = ${t.roleDomain}`,
    ),
    check('role_permissions_scope_values', sql`${t.scope} IN ('all', 'assigned_groups', 'own')`),
  ],
);

/**
 * Asignacion de rol con historial: no se borra, se revoca. Las reglas de quien puede conceder
 * (ni a si mismo, con permiso roles:grant_<dominio>, bootstrap solo en dominio vacio) las aplica el
 * trigger enforce_role_grant (0004). Un trigger posterior audita y revoca las sesiones del usuario.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    /** Dominio comun de la cuenta y del rol (dos FK compuestas lo obligan a coincidir con ambos). */
    domain: text('domain').notNull(),
    grantedBy: uuid('granted_by'),
    /** grant = concedido por un titular; bootstrap = primer titular del dominio; recovery = rescate presencial. */
    grantSource: text('grant_source').notNull().default('grant'),
    /** Referencia del acta (bootstrap/recovery): evidencia humana de la autorizacion institucional. */
    grantReference: text('grant_reference'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    foreignKey({
      name: 'user_roles_user_fkey',
      columns: [t.userId, t.domain],
      foreignColumns: [users.id, users.accountDomain],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'user_roles_role_fkey',
      columns: [t.roleId, t.domain],
      foreignColumns: [roles.id, roles.domain],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'user_roles_granted_by_fkey',
      columns: [t.grantedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'user_roles_revoked_by_fkey',
      columns: [t.revokedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'user_roles_grant_source_values',
      sql`${t.grantSource} IN ('grant', 'bootstrap', 'recovery')`,
    ),
    // Nadie se concede un rol a si mismo. Sin concedente solo existen bootstrap y recovery, y ambos exigen
    // la referencia del acta (3 a 200 caracteres).
    check(
      'user_roles_grantor_valid',
      sql`(${t.grantSource} = 'grant' AND ${t.grantedBy} IS NOT NULL AND ${t.grantedBy} <> ${t.userId} AND ${t.grantReference} IS NULL) OR (${t.grantSource} IN ('bootstrap', 'recovery') AND ${t.grantedBy} IS NULL AND ${t.grantReference} IS NOT NULL AND char_length(btrim(${t.grantReference})) BETWEEN 3 AND 200)`,
    ),
    check(
      'user_roles_revocation_consistent',
      sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`,
    ),
    // Tambien sirve las consultas por user_id (prefijo del indice parcial).
    uniqueIndex('user_roles_active_key')
      .on(t.userId, t.roleId)
      .where(sql`${t.revokedAt} IS NULL`),
    // user_roles_active_key tambien sirve las consultas por user_id (prefijo del indice parcial).
  ],
);

// ---------------------------------------------------------------------------------------------
// Sesiones y tokens de un solo uso
// ---------------------------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    /** SHA-256 del token; el token nunca se guarda. */
    tokenHash: bytea('token_hash').notNull(),
    clientType: text('client_type').notNull().default('web'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Caducidad absoluta. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Caducidad por inactividad (se renueva sin superar expires_at). */
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    /** Momento en que se verifico un segundo factor en esta sesion (MFA, etapa posterior). */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    revokedBy: uuid('revoked_by'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    unique('sessions_token_hash_key').on(t.tokenHash),
    foreignKey({ name: 'sessions_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'sessions_revoked_by_fkey',
      columns: [t.revokedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('sessions_token_hash_length', sql`octet_length(${t.tokenHash}) = 32`),
    check('sessions_client_type_values', sql`${t.clientType} IN ('web', 'android')`),
    check(
      'sessions_expiry_order',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.idleExpiresAt} <= ${t.expiresAt}`,
    ),
    check(
      'sessions_revoked_reason_values',
      sql`${t.revokedReason} IS NULL OR ${t.revokedReason} IN ('logout', 'admin', 'password_changed', 'roles_changed', 'disabled', 'concurrency', 'reuse')`,
    ),
    check(
      'sessions_revocation_consistent',
      sql`(${t.revokedAt} IS NULL) = (${t.revokedReason} IS NULL)`,
    ),
    check(
      'sessions_user_agent_length',
      sql`${t.userAgent} IS NULL OR char_length(${t.userAgent}) <= 256`,
    ),
    index('sessions_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * Activacion de cuenta (invite) y recuperacion de contrasena (password_reset), por RECLAMO en dos partes:
 *  1. La persona titular genera en SU dispositivo un secreto aleatorio y registra solo su SHA-256 (token_hash).
 *  2. Un titular del dominio (nunca la propia cuenta) verifica su identidad en persona y AUTORIZA la solicitud
 *     (authorized_by/at + verification_method). La autoridad nunca ve el secreto ni la contrasena.
 *  3. La persona completa con el secreto: el consumo es un UPDATE atomico (used_at) y revoca sus sesiones.
 * Un solo token vigente por usuario y proposito; las solicitudes sin autorizar se invalidan al reemplazarse.
 * Vigencia maxima 24 h. Detalle en docs/architecture/auth-rbac.md §7.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    purpose: text('purpose').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Transaccion que consumio el token (la fija el trigger; no se puede falsear). Une consumo y activacion. */
    usedTxid: xid8('used_txid'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestedIp: inet('requested_ip'),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    authorizedBy: uuid('authorized_by'),
    /** Como se verifico la identidad de la persona (sin guardar numeros de documento). */
    verificationMethod: text('verification_method'),
    /** Reemplazado o cancelado sin consumirse. */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  },
  (t) => [
    unique('auth_tokens_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'auth_tokens_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'auth_tokens_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('auth_tokens_purpose_values', sql`${t.purpose} IN ('invite', 'password_reset')`),
    check('auth_tokens_token_hash_length', sql`octet_length(${t.tokenHash}) = 32`),
    foreignKey({
      name: 'auth_tokens_authorized_by_fkey',
      columns: [t.authorizedBy],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'auth_tokens_expiry_window',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`,
    ),
    // La autorizacion es completa o no existe; nadie autoriza su propia solicitud.
    // 'ceremony' = autorizacion del propietario del esquema en bootstrap/recovery (sin titular previo): sin authorized_by.
    check(
      'auth_tokens_authorization_complete',
      sql`(${t.authorizedAt} IS NULL AND ${t.authorizedBy} IS NULL AND ${t.verificationMethod} IS NULL) OR (${t.authorizedAt} IS NOT NULL AND ${t.verificationMethod} IS NOT NULL AND (${t.authorizedBy} IS NULL) = (${t.verificationMethod} = 'ceremony'))`,
    ),
    check(
      'auth_tokens_not_self_authorized',
      sql`${t.authorizedBy} IS NULL OR ${t.authorizedBy} <> ${t.userId}`,
    ),
    check(
      'auth_tokens_verification_method_values',
      sql`${t.verificationMethod} IS NULL OR ${t.verificationMethod} IN ('in_person_id', 'in_person_known', 'ceremony')`,
    ),
    // Un token solo se consume si fue autorizado; consumido e invalidado son excluyentes.
    check(
      'auth_tokens_used_requires_authorization',
      sql`${t.usedAt} IS NULL OR ${t.authorizedAt} IS NOT NULL`,
    ),
    check(
      'auth_tokens_used_xor_invalidated',
      sql`${t.usedAt} IS NULL OR ${t.invalidatedAt} IS NULL`,
    ),
    check('auth_tokens_used_txid_consistent', sql`(${t.usedAt} IS NULL) = (${t.usedTxid} IS NULL)`),
    uniqueIndex('auth_tokens_one_active_idx')
      .on(t.userId, t.purpose)
      .where(sql`${t.usedAt} IS NULL AND ${t.invalidatedAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Auditoria (append-only por trigger en 0004)
// ---------------------------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    eventType: text('event_type').notNull(),
    outcome: text('outcome').notNull(),
    actorUserId: uuid('actor_user_id'),
    subjectUserId: uuid('subject_user_id'),
    /** Sin FK a proposito: las sesiones se purgan, la auditoria no. */
    sessionId: uuid('session_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    /** Objeto JSON sin secretos (nunca contrasenas, tokens ni cuerpos de peticion). */
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    foreignKey({
      name: 'audit_events_actor_fkey',
      columns: [t.actorUserId],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'audit_events_subject_fkey',
      columns: [t.subjectUserId],
      foreignColumns: [users.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('audit_events_event_type_format', sql`${t.eventType} ~ '^[a-z][a-z_]*\\.[a-z][a-z_]*$'`),
    check('audit_events_outcome_values', sql`${t.outcome} IN ('success', 'failure', 'denied')`),
    check('audit_events_details_object', sql`jsonb_typeof(${t.details}) = 'object'`),
    index('audit_events_occurred_at_idx').on(t.occurredAt.desc()),
    index('audit_events_subject_idx').on(t.subjectUserId, t.occurredAt.desc()),
    index('audit_events_type_idx').on(t.eventType, t.occurredAt.desc()),
  ],
);

export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type Session = typeof sessions.$inferSelect;
