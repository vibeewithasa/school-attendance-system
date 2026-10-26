/**
 * Activacion de cuentas pendientes por reclamo en dos partes. Reutiliza `auth_tokens` y sus triggers (no hay mecanismo nuevo):
 *
 *  - SOLICITUD (publica, limitada): el titular registra solo el SHA-256 de un secreto que genero en SU navegador, ligado a una
 *    cuenta PENDIENTE (proposito `invite`). Se responde igual exista o no la cuenta (sin enumeracion). Una solicitud nueva
 *    reemplaza a la anterior SIN autorizar; una ya autorizada no puede pisarse (indice unico + trigger).
 *  - APROBACION (autoridad del mismo dominio, sesion + CSRF): verifica la identidad en persona y teclea el codigo que lee en la
 *    pantalla del titular. La autoridad nunca recibe el secreto ni la contrasena y no puede cambiar el hash (trigger).
 *    Nadie aprueba su propia activacion ni la de otro dominio (CHECK/trigger en la base y comprobacion previa aqui).
 *  - FINALIZACION (publica, limitada): el titular entrega el secreto y SU contrasena. En una sola transaccion se consume el token
 *    (un solo uso, bajo bloqueo de fila) y la cuenta pasa a activa (el trigger exige que el consumo ocurra en la misma
 *    transaccion). No se abre ninguna sesion: la persona vuelve a iniciar sesion con su contrasena.
 *
 * Los fallos de finalizacion devuelven un unico resultado generico (`invalid`), salvo la politica de contrasenas, que solo
 * informa motivos sobre la propia contrasena (nunca la repite) y NO consume el token.
 */
import { createHash } from 'node:crypto';
import {
  ACTIVATION_TTL_MINUTES,
  activationCodeFromHash,
  normalizeActivationCode,
  validateNewPassword,
  type ActivationRequest,
  type ActivationState,
  type PasswordPolicyReason,
  type VerificationMethod,
} from '@eta15/shared-contracts';
import { canManageAccount } from '../access-control/grant-policy.js';
import type { RoleDomain } from '../access-control/catalog.js';
import { recordAudit } from '../audit/audit-log.js';
import type { ActorContext } from '../admin-users/admin-users.service.js';
import type { PasswordService } from '../auth/password.js';
import { PasswordError } from '../auth/password.js';
import { hashSessionToken, type SessionStore } from '../auth/session-service.js';
import { findUsableWaiver } from './dual-control.js';

const DOMAINS: readonly RoleDomain[] = ['school', 'technical'];

/** SHA-256 en base64url (43 caracteres) -> 32 bytes; `null` si no es canonico. */
export function secretHashToBytes(secretHash: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secretHash)) return null;
  const bytes = Buffer.from(secretHash, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === secretHash ? bytes : null;
}

export type CompleteResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'policy'; policy: PasswordPolicyReason[] };

export type ApproveFailure = 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED' | 'CODE_MISMATCH';
export type AdminActivationResult<T> =
  { ok: true; value: T } | { ok: false; code: ApproveFailure; message: string };
const fail = (code: ApproveFailure, message: string) => ({ ok: false as const, code, message });

interface RequestRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  account_domain: RoleDomain;
  created_by: string | null;
  user_status: string;
  token_hash: Buffer;
  created_at: Date;
  expires_at: Date;
  authorized_at: Date | null;
  used_at: Date | null;
  invalidated_at: Date | null;
  db_now: Date;
}

const REQUEST_SELECT = `
  SELECT t.id, t.user_id, u.email, u.display_name, u.account_domain, u.created_by, u.status AS user_status, t.token_hash,
         t.created_at, t.expires_at, t.authorized_at, t.used_at, t.invalidated_at, clock_timestamp() AS db_now
    FROM auth_tokens t JOIN users u ON u.id = t.user_id`;

export function createActivationService(options: {
  store: SessionStore;
  passwords: PasswordService;
}) {
  const { store, passwords } = options;

  const manageable = (ctx: ActorContext): RoleDomain[] =>
    DOMAINS.filter((d) => ctx.actor.permissions.has(`users:manage_${d}`));

  const stateOf = (row: RequestRow): ActivationRequest['state'] | null => {
    if (row.used_at || row.invalidated_at || row.user_status !== 'pending') return null;
    if (row.expires_at <= row.db_now) return 'expired';
    return row.authorized_at ? 'authorized' : 'requested';
  };

  return {
    // ------------------------------------------------------------------------------------------ titular (publico)

    /**
     * Registra la solicitud si existe una cuenta PENDIENTE con ese correo. Sin resultado observable: la API responde igual
     * exista o no la cuenta y aunque la solicitud no pueda registrarse (p. ej. ya hay una autorizada).
     */
    async request(input: {
      email: string;
      secretHash: string;
      ip?: string | null;
      userAgent?: string | null;
    }): Promise<void> {
      const tokenHash = secretHashToBytes(input.secretHash);
      if (!tokenHash) return;
      try {
        await store.transaction(async (tx) => {
          // Se bloquea la fila de la cuenta: dos solicitudes simultaneas no pueden reemplazarse entre si.
          const found = await tx.query<{ id: string }>(
            `SELECT id FROM users WHERE email = $1 AND status = 'pending' FOR UPDATE`,
            [input.email],
          );
          const user = found.rows[0];
          if (!user) return;
          // Una solicitud VENCIDA se da de baja (expiracion normal; tambien libera una aprobada que nunca se completo).
          await tx.query(
            `UPDATE auth_tokens SET invalidated_at = now()
              WHERE user_id = $1 AND purpose = 'invite' AND used_at IS NULL AND invalidated_at IS NULL
                AND expires_at <= now()`,
            [user.id],
          );
          // Una solicitud VIGENTE (con o sin aprobar) NO se reemplaza repitiendo una peticion publica con el correo:
          // el reinicio exige que una autoridad la cancele o que venza.
          const live = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM auth_tokens
              WHERE user_id = $1 AND purpose = 'invite' AND used_at IS NULL AND invalidated_at IS NULL`,
            [user.id],
          );
          if (live.rows[0]!.n > 0) return;
          await tx.query(
            `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at, requested_ip)
             VALUES ($1, 'invite', $2, now() + make_interval(mins => $3), $4::inet)`,
            [user.id, tokenHash, ACTIVATION_TTL_MINUTES, input.ip ?? null],
          );
          await recordAudit(
            tx,
            { ip: input.ip, userAgent: input.userAgent },
            {
              type: 'activation.requested',
              outcome: 'success',
              subject: user.id,
              details: { ttlMinutes: ACTIVATION_TTL_MINUTES },
            },
          );
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        // 23505: ya existe una solicitud vigente (autorizada) o el mismo hash; 42501: la base la rechazo. Sin detalles.
        if (code !== '23505' && code !== '42501') throw error;
      }
    },

    /** Estado de la solicitud, consultado por el hash de su propio secreto. */
    async status(secretHash: string): Promise<ActivationState> {
      const tokenHash = secretHashToBytes(secretHash);
      if (!tokenHash) return 'unknown';
      const row = await store.transaction(
        async (tx) =>
          (
            await tx.query<RequestRow>(
              `${REQUEST_SELECT} WHERE t.token_hash = $1 AND t.purpose = 'invite'`,
              [tokenHash],
            )
          ).rows[0],
      );
      if (!row) return 'unknown';
      const state = stateOf(row);
      if (!state) return 'unknown';
      return state === 'requested' ? 'waiting' : state;
    },

    /** Consume el token y activa la cuenta con la contrasena del titular. Transaccional y de un solo uso. */
    async complete(input: {
      secret: string;
      newPassword: string;
      ip?: string | null;
      userAgent?: string | null;
    }): Promise<CompleteResult> {
      const tokenHash = hashSessionToken(input.secret); // SHA-256 del secreto binario (misma regla que el navegador)
      if (!tokenHash) return { ok: false, reason: 'invalid' };

      // 1) Lectura barata: sin solicitud autorizada vigente no se gasta Argon2id.
      const row = await store.transaction(
        async (tx) =>
          (
            await tx.query<RequestRow>(
              `${REQUEST_SELECT} WHERE t.token_hash = $1 AND t.purpose = 'invite'`,
              [tokenHash],
            )
          ).rows[0],
      );
      if (!row || stateOf(row) !== 'authorized') return { ok: false, reason: 'invalid' };

      // 2) Politica de contrasenas (con el correo y el nombre de ESTA cuenta). No consume el token.
      const policy = validateNewPassword(input.newPassword, {
        email: row.email,
        displayName: row.display_name,
      });
      if (!policy.ok) return { ok: false, reason: 'policy', policy: policy.reasons };

      let hash: string;
      try {
        hash = await passwords.hash(input.newPassword);
      } catch (error) {
        if (error instanceof PasswordError) return { ok: false, reason: 'invalid' };
        throw error;
      }

      // 3) Consumo + activacion en UNA transaccion, con la fila del token bloqueada (dos finalizaciones simultaneas: una).
      try {
        return await store.transaction<CompleteResult>(async (tx) => {
          const locked = (
            await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [
              row.id,
            ])
          ).rows[0];
          if (!locked || stateOf(locked) !== 'authorized') return { ok: false, reason: 'invalid' };
          await tx.query(
            `UPDATE auth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
            [locked.id],
          );
          const activated = await tx.query(
            `UPDATE users SET status = 'active', password_hash = $2, password_changed_at = now()
              WHERE id = $1 AND status = 'pending' RETURNING id`,
            [locked.user_id, hash],
          );
          if (activated.rows.length === 0)
            throw Object.assign(new Error('cuenta no pendiente'), { code: '40001' });
          await recordAudit(
            tx,
            { ip: input.ip, userAgent: input.userAgent },
            {
              type: 'activation.completed',
              outcome: 'success',
              subject: locked.user_id,
              details: { domain: locked.account_domain },
            },
          );
          return { ok: true };
        });
      } catch (error) {
        // 42501 (el trigger rechazo un consumo repetido), 23514 (p. ej. correo personal sin verificar), 40001/40P01 (carrera).
        const code = (error as { code?: string }).code;
        if (code === '42501' || code === '23514' || code === '40001' || code === '40P01') {
          return { ok: false, reason: 'invalid' };
        }
        throw error;
      }
    },

    // ------------------------------------------------------------------------------------------ autoridad (administrativo)

    /** Solicitudes que el actor puede aprobar (cuentas pendientes de los dominios que administra). Sin el codigo. */
    async list(ctx: ActorContext): Promise<AdminActivationResult<ActivationRequest[]>> {
      const domains = manageable(ctx);
      if (!ctx.actor.permissions.has('users:read') || domains.length === 0) {
        return fail('FORBIDDEN', 'No tiene permiso para consultar solicitudes de activación');
      }
      const rows = await store.transaction(
        async (tx) =>
          (
            await tx.query<RequestRow>(
              `${REQUEST_SELECT}
              WHERE t.purpose = 'invite' AND t.used_at IS NULL AND t.invalidated_at IS NULL AND u.status = 'pending'
                AND u.account_domain = ANY($1::text[])
              ORDER BY t.created_at DESC, t.id LIMIT 100`,
              [domains],
            )
          ).rows,
      );
      const items: ActivationRequest[] = [];
      for (const row of rows) {
        const state = stateOf(row);
        if (!state) continue;
        items.push({
          id: row.id,
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          accountDomain: row.account_domain,
          createdByActor: row.created_by === ctx.actor.id,
          state,
          requestedAt: row.created_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
        });
      }
      return { ok: true, value: items };
    },

    /** Aprueba la identidad del titular (presencial). El codigo debe coincidir con el de SU solicitud. */
    async approve(
      ctx: ActorContext,
      id: string,
      input: { code: string; verificationMethod: VerificationMethod },
    ): Promise<AdminActivationResult<{ state: 'authorized' }>> {
      type Denied = { ok: false; denied: string };
      try {
        const result = await store.transaction<
          AdminActivationResult<{ state: 'authorized' }> | Denied
        >(async (tx) => {
          const row = (
            await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id])
          ).rows[0];
          if (!row || !manageable(ctx).includes(row.account_domain))
            return fail('NOT_FOUND', 'Solicitud no encontrada');
          if (row.user_id === ctx.actor.id) return { ok: false as const, denied: 'self_approval' };
          const decision = canManageAccount(
            ctx.actor,
            { id: row.user_id, accountDomain: row.account_domain },
            'issue_invite',
          );
          if (!decision.allowed) return { ok: false as const, denied: decision.reason };
          const state = stateOf(row);
          if (!state) return fail('NOT_FOUND', 'Solicitud no encontrada');
          if (state === 'expired')
            return fail(
              'EXPIRED',
              'La solicitud venció; cancélela y pida a la persona iniciar otra',
            );
          if (state === 'authorized') return fail('CONFLICT', 'La solicitud ya fue aprobada');
          // Control dual: ninguna autoridad aprueba la activacion de una cuenta que ELLA creo (otra autoridad distinta lo hace).
          // Unica excepcion: dispensa de la consola para la segunda autoridad de un dominio con una sola (dual-control.ts).
          let waiverId: string | null = null;
          if (row.created_by === ctx.actor.id) {
            waiverId = await findUsableWaiver(tx, row.user_id, row.account_domain);
            if (!waiverId) return { ok: false as const, denied: 'dual_control_required' };
          }
          if (normalizeActivationCode(input.code) !== activationCodeFromHash(row.token_hash)) {
            return { ok: false as const, denied: 'code_mismatch' };
          }
          await tx.query(
            `UPDATE auth_tokens SET authorized_at = now(), authorized_by = $2, verification_method = $3
              WHERE id = $1 AND authorized_at IS NULL AND used_at IS NULL AND invalidated_at IS NULL`,
            [row.id, ctx.actor.id, input.verificationMethod],
          );
          await recordAudit(
            tx,
            {
              actorId: ctx.actor.id,
              ip: ctx.ip,
              userAgent: ctx.userAgent,
              requestId: ctx.requestId,
            },
            {
              type: 'activation.authorized',
              outcome: 'success',
              subject: row.user_id,
              details: { method: input.verificationMethod, domain: row.account_domain },
            },
          );
          if (waiverId) {
            await recordAudit(
              tx,
              {
                actorId: ctx.actor.id,
                ip: ctx.ip,
                userAgent: ctx.userAgent,
                requestId: ctx.requestId,
              },
              {
                type: 'activation.waiver_used',
                outcome: 'success',
                subject: row.user_id,
                details: { waiverId, domain: row.account_domain },
              },
            );
          }
          return { ok: true as const, value: { state: 'authorized' as const } };
        });
        if ('denied' in result) {
          await store
            .transaction((tx) =>
              recordAudit(
                tx,
                {
                  actorId: ctx.actor.id,
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                {
                  type: 'authz.denied',
                  outcome: 'denied',
                  subject: null,
                  details: { action: 'activation.approve', reason: result.denied },
                },
              ),
            )
            .catch(() => undefined);
          return result.denied === 'code_mismatch'
            ? fail(
                'CODE_MISMATCH',
                'El código no coincide con el que muestra la pantalla de la persona',
              )
            : result.denied === 'dual_control_required'
              ? fail(
                  'FORBIDDEN',
                  'La activación no la aprueba quien creó la cuenta: debe hacerlo otra autoridad del dominio. Si solo existe una autoridad, se requiere el procedimiento excepcional con acta (consola)',
                )
              : fail('FORBIDDEN', 'No tiene permiso para aprobar esa activación');
        }
        return result;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '42501') return fail('FORBIDDEN', 'La base de datos rechazó la aprobación');
        if (code === '40001' || code === '40P01')
          return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente');
        throw error;
      }
    },

    /** Cancela una solicitud sin consumir (vencida, huerfana o ya aprobada) para que la persona pueda iniciar otra. */
    async cancel(
      ctx: ActorContext,
      id: string,
    ): Promise<AdminActivationResult<{ state: 'cancelled' }>> {
      try {
        return await store.transaction<AdminActivationResult<{ state: 'cancelled' }>>(
          async (tx) => {
            const row = (
              await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id])
            ).rows[0];
            if (
              !row ||
              !manageable(ctx).includes(row.account_domain) ||
              row.used_at ||
              row.invalidated_at
            ) {
              return fail('NOT_FOUND', 'Solicitud no encontrada');
            }
            await tx.query(`UPDATE auth_tokens SET invalidated_at = now() WHERE id = $1`, [row.id]);
            await recordAudit(
              tx,
              {
                actorId: ctx.actor.id,
                ip: ctx.ip,
                userAgent: ctx.userAgent,
                requestId: ctx.requestId,
              },
              {
                type: 'activation.cancelled',
                outcome: 'success',
                subject: row.user_id,
                details: {
                  wasAuthorized: row.authorized_at !== null,
                  wasExpired: row.expires_at <= row.db_now,
                },
              },
            );
            return { ok: true, value: { state: 'cancelled' } };
          },
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '42501') return fail('FORBIDDEN', 'La base de datos rechazó la cancelación');
        if (code === '40001' || code === '40P01')
          return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente');
        throw error;
      }
    },
  };
}

export type ActivationService = ReturnType<typeof createActivationService>;

/** SHA-256 en base64url de un secreto binario (misma operacion que realiza el navegador). Util para pruebas. */
export function hashSecretForTests(secret: string): string {
  return createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
}
