/**
 * Autenticacion por correo y contrasena (logica de dominio, sin HTTP). Reutiliza `PasswordService` y `SessionService`;
 * no duplica su logica.
 *
 *  - Mismo trabajo costoso (una derivacion Argon2id) exista o no la cuenta, este activa o no: usuario inexistente o sin
 *    contrasena => `decoyVerify`; cuenta inactiva/bloqueada => se verifica la contrasena igualmente y despues se rechaza.
 *    Todos los fallos devuelven el mismo resultado `invalid_credentials`.
 *  - Una sesion solo se abre si la autenticacion esta COMPLETA: roles que exigen MFA => `mfa_required` y NO se crea ninguna
 *    sesion (sin sesiones parciales, sin bypass de desarrollo).
 *  - Re-hash (parametros de Argon2id actualizados): se hace en la MISMA transaccion que abre la sesion, con comparacion
 *    del hash anterior (`WHERE password_hash = $viejo`) para no pisar un cambio de contrasena concurrente. Cambiar
 *    `password_hash` dispara el trigger que revoca las sesiones EXISTENTES del usuario (una vez por actualizacion de
 *    parametros); la sesion nueva se inserta despues, asi que no se invalida. No se toca `password_changed_at` (la
 *    contrasena es la misma). Si la sesion no llega a crearse, la transaccion se revierte y tampoco se re-hashea.
 */
import type { PasswordService } from './password.js';
import { PasswordError } from './password.js';
import type {
  ClientType,
  SessionService,
  SessionStore,
  SessionSummary,
} from './session-service.js';

export interface AuthenticateInput {
  /** Correo YA normalizado (ver email.ts). */
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
  clientType?: ClientType;
}

export type AuthenticateResult =
  | { ok: true; token: string; session: SessionSummary; mustChangePassword: boolean }
  | { ok: false; reason: 'invalid_credentials' | 'mfa_required' };

export interface AuthServiceOptions {
  store: SessionStore;
  sessions: SessionService;
  passwords: PasswordService;
  /** Aviso sin datos personales (p. ej. hash almacenado corrupto). */
  onIntegrityProblem?: (code: string) => void;
}

interface LoginRow {
  id: string;
  password_hash: string | null;
  status: string;
  locked_until: Date | null;
  must_change_password: boolean;
  db_now: Date;
}

class RollbackWith<T> extends Error {
  constructor(readonly result: T) {
    super('rollback');
  }
}

const INVALID: AuthenticateResult = { ok: false, reason: 'invalid_credentials' };

export function createAuthService(options: AuthServiceOptions) {
  const { store, sessions, passwords } = options;

  return {
    async authenticate(input: AuthenticateInput): Promise<AuthenticateResult> {
      const found = await store.transaction((tx) =>
        tx.query<LoginRow>(
          `SELECT id, password_hash, status, locked_until, must_change_password, clock_timestamp() AS db_now
             FROM users WHERE email = $1`,
          [input.email],
        ),
      );
      const user = found.rows[0];
      if (!user?.password_hash) {
        await passwords.decoyVerify(input.password);
        return INVALID;
      }

      let matches: boolean;
      try {
        matches = await passwords.verify(user.password_hash, input.password);
      } catch (error) {
        if (!(error instanceof PasswordError)) throw error;
        // Hash almacenado corrupto o no admitido: se informa solo el codigo y se responde igual que un fallo.
        options.onIntegrityProblem?.(error.code);
        return INVALID;
      }
      if (!matches) return INVALID;
      if (user.status !== 'active') return INVALID;
      if (user.locked_until && user.locked_until > user.db_now) return INVALID;

      const upgraded = passwords.needsRehash(user.password_hash)
        ? await passwords.hash(input.password)
        : null;

      try {
        return await store.transaction(async (tx): Promise<AuthenticateResult> => {
          if (upgraded) {
            const swapped = await tx.query(
              `UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3 RETURNING id`,
              [user.id, upgraded, user.password_hash],
            );
            // 0 filas: la contrasena cambio mientras tanto; esta autenticacion ya no es valida.
            if (swapped.rows.length === 0) throw new RollbackWith<AuthenticateResult>(INVALID);
          }
          const created = await sessions.createWithin(tx, {
            userId: user.id,
            clientType: input.clientType,
            ip: input.ip,
            userAgent: input.userAgent,
            mfaVerified: false, // no existe MFA funcional: los roles que lo exigen no obtienen sesion
          });
          if (!created.ok) {
            throw new RollbackWith<AuthenticateResult>(
              created.reason === 'mfa_required' ? { ok: false, reason: 'mfa_required' } : INVALID,
            );
          }
          await tx.query(
            `UPDATE users SET last_login_at = $2, failed_login_count = 0 WHERE id = $1`,
            [user.id, created.session.createdAt],
          );
          return {
            ok: true,
            token: created.token,
            session: created.session,
            mustChangePassword: user.must_change_password,
          };
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.result as AuthenticateResult;
        throw error;
      }
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
