/**
 * Administracion de cuentas (logica de dominio, sin HTTP). Reutiliza las reglas puras de
 * `access-control/grant-policy.ts` y deja a los triggers de PostgreSQL como ultima defensa.
 *
 *  - El ACTOR sale siempre de la sesion autenticada (`ActorContext`); ningun identificador de actor llega del cliente.
 *  - Denegar por defecto: cada operacion exige el permiso del dominio de la cuenta/rol afectado (`users:manage_<d>`,
 *    `roles:grant_<d>`). Un administrador tecnico no gestiona cuentas escolares ni al reves; lo que queda fuera del
 *    alcance del actor es indistinguible de lo inexistente (404).
 *  - Las cuentas se crean PENDIENTES y sin contrasena: la administracion jamas elige ni conoce una contrasena ni activa por
 *    si misma (la activacion es un reclamo de la propia persona; ver auth-rbac.md §6).
 *  - Asignar/revocar roles inserta/actualiza `user_roles` (nunca `role_permissions`, que es solo lectura para la API).
 *    Los triggers vuelven a validar al concedente y auditan (`role.granted`, `role.revoked`) y revocan las sesiones.
 *  - No se puede dejar un dominio sin ningun titular activo con `roles:grant_<d>` (deshabilitar o revocar al ultimo):
 *    bajo un bloqueo consultivo por dominio, de modo que dos solicitudes simultaneas no lo eludan.
 *  - Auditoria: `user.created`, `user.disabled`, `authz.denied` (sin secretos) ademas de la de los triggers.
 */
import type {
  AdminRole,
  AdminUser,
  AdminUserList,
  CreateUserBody,
  ListUsersQuery,
} from '@eta15/shared-contracts';
import {
  canGrantRole,
  canManageAccount,
  canRevokeRole,
  type Actor,
} from '../access-control/grant-policy.js';
import type { RoleDomain } from '../access-control/catalog.js';
import type { SessionStore, SqlClient } from '../auth/session-service.js';

/** Quien actua y desde donde: se construye a partir de la sesion verificada, nunca del cuerpo de la peticion. */
export interface ActorContext {
  actor: Actor;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export type AdminFailure = 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'LAST_AUTHORITY' | 'VALIDATION';
export type AdminResult<T> =
  { ok: true; value: T } | { ok: false; code: AdminFailure; message: string };

const fail = (
  code: AdminFailure,
  message: string,
): { ok: false; code: AdminFailure; message: string } => ({
  ok: false,
  code,
  message,
});

const DOMAINS: readonly RoleDomain[] = ['school', 'technical'];

interface UserRow {
  id: string;
  email: string;
  email_kind: 'institutional' | 'personal';
  display_name: string;
  account_domain: RoleDomain;
  status: 'pending' | 'active' | 'disabled';
  created_at: Date;
  last_login_at: Date | null;
  locked: boolean;
  roles: Array<{ key: string; name: string; domain: RoleDomain; grantedAt: string }>;
  activation: 'requested' | 'authorized' | null;
}

const USER_SELECT = `
  SELECT u.id, u.email, u.email_kind, u.display_name, u.account_domain, u.status, u.created_at, u.last_login_at,
         (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('key', r.key, 'name', r.name, 'domain', r.domain, 'grantedAt', ur.granted_at)
                                    ORDER BY r.key)
                     FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND ur.revoked_at IS NULL), '[]'::jsonb) AS roles,
         CASE WHEN u.status = 'pending' THEN
           (SELECT CASE WHEN t.authorized_at IS NOT NULL THEN 'authorized' ELSE 'requested' END
              FROM auth_tokens t
             WHERE t.user_id = u.id AND t.purpose = 'invite' AND t.used_at IS NULL AND t.invalidated_at IS NULL
               AND t.expires_at > now() LIMIT 1)
         END AS activation
    FROM users u`;

/** Solo estos campos salen de la API: nunca password_hash, tokens ni contadores internos. */
function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    emailKind: row.email_kind,
    displayName: row.display_name,
    accountDomain: row.account_domain,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    locked: row.locked,
    roles: row.roles.map((r) => ({
      key: r.key,
      name: r.name,
      domain: r.domain,
      grantedAt: new Date(r.grantedAt).toISOString(),
    })),
    activation: row.activation,
  };
}

/** Dominios cuyas cuentas administra el actor (los unicos que puede ver). */
const manageableDomains = (actor: Actor): RoleDomain[] =>
  DOMAINS.filter((d) => actor.permissions.has(`users:manage_${d}`));

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

interface SqlError {
  code?: string;
  constraint?: string;
}

export function createAdminUsersService(options: { store: SessionStore }) {
  const { store } = options;

  async function audit(
    tx: SqlClient,
    ctx: ActorContext,
    event: {
      type: string;
      outcome: 'success' | 'denied';
      subject?: string | null;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO audit_events (event_type, outcome, actor_user_id, subject_user_id, ip, user_agent, request_id, details)
       VALUES ($1, $2, $3, $4, $5::inet, $6, $7, $8::jsonb)`,
      [
        event.type,
        event.outcome,
        ctx.actor.id,
        event.subject ?? null,
        ctx.ip ?? null,
        ctx.userAgent ? ctx.userAgent.slice(0, 256) : null,
        ctx.requestId ?? null,
        JSON.stringify(event.details),
      ],
    );
  }

  /** Registra una denegacion en una transaccion propia (la de la operacion ya se revirtio o no escribio nada). */
  async function denied(
    ctx: ActorContext,
    action: string,
    reason: string,
    subject?: string | null,
  ): Promise<void> {
    await store
      .transaction((tx) =>
        audit(tx, ctx, {
          type: 'authz.denied',
          outcome: 'denied',
          subject,
          details: { action, reason },
        }),
      )
      .catch(() => undefined); // la auditoria de una denegacion no debe convertir un 403 en un 500
  }

  /** Traduce errores de PostgreSQL a resultados de dominio sin exponer su mensaje. */
  function mapDbError(error: unknown): AdminResult<never> {
    const e = error as SqlError;
    if (e.code === '23505') {
      return fail(
        'CONFLICT',
        e.constraint === 'users_email_key'
          ? 'Ya existe una cuenta con ese correo'
          : 'La asignación ya existe',
      );
    }
    if (e.code === '42501') return fail('FORBIDDEN', 'La base de datos rechazó la operación');
    // Interbloqueo o fallo de serializacion bajo concurrencia: la operacion se revirtio por completo; se puede reintentar.
    if (e.code === '40P01' || e.code === '40001')
      return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente');
    if (e.code === '23503' || e.code === '23514' || e.code === '22P02' || e.code === '23502') {
      return fail('VALIDATION', 'Datos no válidos para la operación');
    }
    throw error;
  }

  /** Carga una cuenta con sus datos de lista; `null` si no existe. */
  const loadUser = async (tx: SqlClient, id: string, lock = false) => {
    const r = await tx.query<UserRow>(
      `${USER_SELECT} WHERE u.id = $1${lock ? ' FOR UPDATE OF u' : ''}`,
      [id],
    );
    return r.rows[0] ?? null;
  };

  /** Bloqueo consultivo por dominio: serializa los cambios que podrian dejarlo sin titulares. */
  const lockDomainAuthority = (tx: SqlClient, domain: RoleDomain) =>
    tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `eta15.authority.${domain}`,
    ]);

  /** Titulares ACTIVOS con roles:grant_<dominio>, descontando una cuenta o una asignacion concreta. */
  async function otherAuthorityHolders(
    tx: SqlClient,
    domain: RoleDomain,
    excluded: { userId?: string; assignmentId?: string },
  ): Promise<number> {
    const r = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id AND u.status = 'active'
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.domain = $1 AND ur.revoked_at IS NULL AND p.key = 'roles:grant_' || $1
          AND ($2::uuid IS NULL OR ur.user_id <> $2::uuid)
          AND ($3::uuid IS NULL OR ur.id <> $3::uuid)`,
      [domain, excluded.userId ?? null, excluded.assignmentId ?? null],
    );
    return r.rows[0]!.n;
  }

  /** ¿La cuenta es hoy titular de autoridad de su dominio (algun rol vigente con roles:grant_<d>)? */
  async function isAuthorityHolder(
    tx: SqlClient,
    userId: string,
    domain: RoleDomain,
  ): Promise<boolean> {
    const r = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND p.key = 'roles:grant_' || $2`,
      [userId, domain],
    );
    return r.rows[0]!.n > 0;
  }

  return {
    /** Lista paginada de las cuentas de los dominios que el actor administra. */
    async list(ctx: ActorContext, query: ListUsersQuery): Promise<AdminResult<AdminUserList>> {
      const domains = manageableDomains(ctx.actor);
      if (!ctx.actor.permissions.has('users:read') || domains.length === 0) {
        await denied(ctx, 'users.list', 'missing_permission');
        return fail('FORBIDDEN', 'No tiene permiso para consultar cuentas');
      }
      const visible = query.domain ? domains.filter((d) => d === query.domain) : domains;
      const where = `
        WHERE u.account_domain = ANY($1::text[])
          AND ($2::text IS NULL OR u.status = $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                            WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND r.key = $3))
          AND ($4::text IS NULL OR u.email ILIKE '%' || $4 || '%' ESCAPE '\\' OR u.display_name ILIKE '%' || $4 || '%' ESCAPE '\\')`;
      const params = [
        visible,
        query.status ?? null,
        query.role ?? null,
        query.q ? escapeLike(query.q) : null,
      ];
      return store.transaction(async (tx) => {
        const total = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM users u ${where}`,
          params,
        );
        const rows = await tx.query<UserRow>(
          `${USER_SELECT} ${where} ORDER BY u.created_at DESC, u.id LIMIT $5 OFFSET $6`,
          [...params, query.pageSize, (query.page - 1) * query.pageSize],
        );
        return {
          ok: true as const,
          value: {
            items: rows.rows.map(toAdminUser),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          },
        };
      });
    },

    async get(ctx: ActorContext, id: string): Promise<AdminResult<AdminUser>> {
      const domains = manageableDomains(ctx.actor);
      const row = await store.transaction((tx) => loadUser(tx, id));
      // Fuera de alcance o inexistente: la misma respuesta.
      if (
        !ctx.actor.permissions.has('users:read') ||
        !row ||
        !domains.includes(row.account_domain)
      ) {
        return fail('NOT_FOUND', 'Cuenta no encontrada');
      }
      return { ok: true, value: toAdminUser(row) };
    },

    /** Alta de una cuenta PENDIENTE (sin contrasena). El creador es el actor de la sesion. */
    async create(ctx: ActorContext, body: CreateUserBody): Promise<AdminResult<AdminUser>> {
      const decision = canManageAccount(
        ctx.actor,
        { id: '00000000-0000-0000-0000-000000000000', accountDomain: body.accountDomain },
        'create',
      );
      if (!decision.allowed) {
        await denied(ctx, 'users.create', decision.reason);
        return fail('FORBIDDEN', 'No tiene permiso para crear cuentas de ese dominio');
      }
      try {
        return await store.transaction(async (tx) => {
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO users (email, email_kind, display_name, account_domain, status, created_by)
             VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
            [body.email, body.emailKind, body.displayName, body.accountDomain, ctx.actor.id],
          );
          const id = inserted.rows[0]!.id;
          await audit(tx, ctx, {
            type: 'user.created',
            outcome: 'success',
            subject: id,
            details: { domain: body.accountDomain, emailKind: body.emailKind },
          });
          return { ok: true as const, value: toAdminUser((await loadUser(tx, id))!) };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },

    /** Deshabilita una cuenta (revoca sus sesiones por trigger). No se re-habilita: exige una nueva activacion. */
    async disable(ctx: ActorContext, id: string): Promise<AdminResult<AdminUser>> {
      try {
        const result = await store.transaction<
          AdminResult<AdminUser> | { ok: false; denied: string }
        >(async (tx) => {
          // Orden de bloqueo fijo (evita interbloqueos): 1) autorizar con una lectura sin bloqueo, 2) bloqueo consultivo del
          // dominio, 3) fila de la cuenta. Quien no esta autorizado nunca llega a tomar el bloqueo del dominio.
          const peek = await loadUser(tx, id);
          const domains = manageableDomains(ctx.actor);
          const canSee = peek && domains.includes(peek.account_domain);
          if (!peek || (!canSee && !ctx.actor.permissions.has('users:disable_any'))) {
            return fail('NOT_FOUND', 'Cuenta no encontrada');
          }
          if (peek.id === ctx.actor.id) return { ok: false as const, denied: 'self_disable' };
          const decision = canManageAccount(
            ctx.actor,
            { id: peek.id, accountDomain: peek.account_domain },
            'disable',
          );
          if (!decision.allowed) return { ok: false as const, denied: decision.reason };

          await lockDomainAuthority(tx, peek.account_domain);
          const target = (await loadUser(tx, id, true))!;
          if (target.status === 'disabled')
            return { ok: true as const, value: toAdminUser(target) };
          if (
            target.status === 'active' &&
            (await isAuthorityHolder(tx, target.id, target.account_domain)) &&
            (await otherAuthorityHolders(tx, target.account_domain, { userId: target.id })) === 0
          ) {
            return fail(
              'LAST_AUTHORITY',
              'No puede deshabilitarse al último titular con autoridad del dominio',
            );
          }
          await tx.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [target.id]);
          await audit(tx, ctx, {
            type: 'user.disabled',
            outcome: 'success',
            subject: target.id,
            details: { domain: target.account_domain },
          });
          return { ok: true as const, value: toAdminUser((await loadUser(tx, target.id))!) };
        });
        if ('denied' in result) {
          await denied(ctx, 'users.disable', result.denied, id);
          return fail('FORBIDDEN', 'No tiene permiso para deshabilitar esa cuenta');
        }
        return result;
      } catch (error) {
        return mapDbError(error);
      }
    },

    /** Roles que el actor puede consultar/asignar: los de los dominios en los que tiene `roles:grant_<d>`. */
    async listRoles(ctx: ActorContext): Promise<AdminResult<AdminRole[]>> {
      const domains = DOMAINS.filter((d) => ctx.actor.permissions.has(`roles:grant_${d}`));
      if (!ctx.actor.permissions.has('roles:read') || domains.length === 0) {
        await denied(ctx, 'roles.list', 'missing_permission');
        return fail('FORBIDDEN', 'No tiene permiso para consultar roles');
      }
      const r = await store.transaction((tx) =>
        tx.query<{
          key: string;
          name: string;
          description: string;
          domain: RoleDomain;
          requires_mfa: boolean;
        }>(
          `SELECT key, name, description, domain, requires_mfa FROM roles WHERE domain = ANY($1::text[]) ORDER BY domain, key`,
          [domains],
        ),
      );
      return {
        ok: true,
        value: r.rows.map((x) => ({
          key: x.key,
          name: x.name,
          description: x.description,
          domain: x.domain,
          requiresMfa: x.requires_mfa,
        })),
      };
    },

    /** Asigna un rol existente a una cuenta del mismo dominio. `granted_by` es siempre el actor de la sesion. */
    async assignRole(
      ctx: ActorContext,
      userId: string,
      roleKey: string,
    ): Promise<AdminResult<AdminUser>> {
      try {
        const result = await store.transaction<
          AdminResult<AdminUser> | { ok: false; denied: string }
        >(async (tx) => {
          const target = await loadUser(tx, userId);
          if (!target || !manageableDomains(ctx.actor).includes(target.account_domain)) {
            return fail('NOT_FOUND', 'Cuenta no encontrada');
          }
          const role = (
            await tx.query<{ id: string; key: string; domain: RoleDomain }>(
              `SELECT id, key, domain FROM roles WHERE key = $1`,
              [roleKey],
            )
          ).rows[0];
          if (!role) return fail('NOT_FOUND', 'Rol no encontrado');
          const decision = canGrantRole(
            ctx.actor,
            { id: target.id, status: target.status, accountDomain: target.account_domain },
            role,
          );
          if (!decision.allowed) return { ok: false as const, denied: decision.reason };
          await tx.query(
            `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source)
             VALUES ($1, $2, $3, $4, 'grant')`,
            [target.id, role.id, role.domain, ctx.actor.id],
          );
          return { ok: true as const, value: toAdminUser((await loadUser(tx, target.id))!) };
        });
        if ('denied' in result) {
          await denied(ctx, 'roles.assign', result.denied, userId);
          return fail('FORBIDDEN', 'No tiene permiso para asignar ese rol');
        }
        return result;
      } catch (error) {
        const mapped = mapDbError(error);
        if (mapped.ok === false && mapped.code === 'FORBIDDEN')
          await denied(ctx, 'roles.assign', 'database_guard', userId);
        return mapped;
      }
    },

    /** Revoca la asignacion vigente de un rol (el historial se conserva). */
    async revokeRole(
      ctx: ActorContext,
      userId: string,
      roleKey: string,
    ): Promise<AdminResult<AdminUser>> {
      try {
        const result = await store.transaction<
          AdminResult<AdminUser> | { ok: false; denied: string }
        >(async (tx) => {
          const target = await loadUser(tx, userId);
          const self = target?.id === ctx.actor.id;
          if (!target || (!self && !manageableDomains(ctx.actor).includes(target.account_domain))) {
            return fail('NOT_FOUND', 'Cuenta no encontrada');
          }
          const assignment = (
            await tx.query<{ id: string; role_id: string; domain: RoleDomain }>(
              `SELECT ur.id, ur.role_id, ur.domain FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = $1 AND r.key = $2 AND ur.revoked_at IS NULL`,
              [target.id, roleKey],
            )
          ).rows[0];
          if (!assignment) return fail('NOT_FOUND', 'La cuenta no tiene ese rol');
          const decision = canRevokeRole(
            ctx.actor,
            { id: target.id, status: target.status, accountDomain: target.account_domain },
            { key: roleKey, domain: assignment.domain },
          );
          if (!decision.allowed) return { ok: false as const, denied: decision.reason };

          await lockDomainAuthority(tx, assignment.domain);
          const holdsAuthority =
            (
              await tx.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                WHERE rp.role_id = $1 AND p.key = 'roles:grant_' || $2`,
                [assignment.role_id, assignment.domain],
              )
            ).rows[0]!.n > 0;
          if (
            holdsAuthority &&
            target.status === 'active' &&
            (await otherAuthorityHolders(tx, assignment.domain, {
              assignmentId: assignment.id,
            })) === 0
          ) {
            return fail(
              'LAST_AUTHORITY',
              'No puede revocarse al último titular con autoridad del dominio',
            );
          }
          await tx.query(
            `UPDATE user_roles SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`,
            [assignment.id, ctx.actor.id],
          );
          return { ok: true as const, value: toAdminUser((await loadUser(tx, target.id))!) };
        });
        if ('denied' in result) {
          await denied(ctx, 'roles.revoke', result.denied, userId);
          return fail('FORBIDDEN', 'No tiene permiso para revocar ese rol');
        }
        return result;
      } catch (error) {
        const mapped = mapDbError(error);
        if (mapped.ok === false && mapped.code === 'FORBIDDEN')
          await denied(ctx, 'roles.revoke', 'database_guard', userId);
        return mapped;
      }
    },
  };
}

export type AdminUsersService = ReturnType<typeof createAdminUsersService>;
