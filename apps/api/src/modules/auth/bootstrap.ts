/**
 * Bootstrap controlado de la PRIMERA autoridad de un dominio. Es un procedimiento administrativo de consola, separado de
 * la API publica (no existe ningun endpoint de bootstrap) y solo lo puede ejecutar el propietario del esquema (`eta15_app`),
 * porque los triggers de la base rechazan `bootstrap` a cualquier otro rol.
 *
 * Garantias:
 *  - La contrasena la teclea LA PERSONA titular en un prompt oculto (`readPassword`); nunca viaja en argumentos, variables
 *    de entorno, archivos ni logs, y quien opera la consola no la conoce. Aqui solo se hashea (Argon2id).
 *  - Se usa el flujo de activacion por reclamo de la base: se registra un token de un solo uso generado en memoria, se
 *    autoriza con el metodo `ceremony` (solo el propietario puede) y se consume en la MISMA transaccion en que la cuenta
 *    pasa a activa. El secreto del token se descarta; nadie puede reutilizarlo.
 *  - Acta obligatoria (3-200 caracteres). El acta es evidencia humana que queda en `user_roles.grant_reference` y en
 *    la auditoria; NO prueba por si sola que la autorizacion institucional exista (ver `BOOTSTRAP_PROCEDURES`).
 *  - Una sola vez por dominio, para siempre: el trigger rechaza el bootstrap si existe cualquier asignacion historica del
 *    dominio, y serializa ejecuciones simultaneas con un bloqueo consultivo. Despues solo existe `recovery` (con acta).
 *  - Dominios separados: `school` -> `direccion`, `technical` -> `admin_tecnico`.
 *  - El dominio ESCOLAR esta BLOQUEADO hasta que exista un procedimiento verificable de la autoridad escolar inicial.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PASSWORD_MIN_LENGTH, normalizeEmail, validateNewPassword } from '@eta15/shared-contracts';
import type { PasswordService } from './password.js';

export type BootstrapDomain = 'school' | 'technical';

/**
 * Estado del procedimiento verificable por dominio. Cambiar `approved` a `true` es un cambio de codigo revisado: documenta la
 * decision institucional y se hace junto con el procedimiento (docs/architecture/auth-rbac.md §5).
 */
export const BOOTSTRAP_PROCEDURES: Record<
  BootstrapDomain,
  { role: string; approved: boolean; blockedReason: string }
> = {
  technical: {
    role: 'admin_tecnico',
    approved: true,
    blockedReason: '',
  },
  school: {
    role: 'direccion',
    approved: false,
    blockedReason:
      'No existe aun un procedimiento verificable para acreditar a la primera autoridad escolar (Direccion). El paso esta preparado pero bloqueado hasta que la institucion lo defina y se apruebe (auth-rbac.md §5).',
  },
};

/** El bootstrap aplica la politica de contrasenas del proyecto (shared-contracts), con el correo y el nombre de la cuenta. */
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = PASSWORD_MIN_LENGTH;

export type BootstrapErrorCode =
  | 'procedure_blocked'
  | 'invalid_input'
  | 'not_owner'
  | 'already_initialized'
  | 'password_rejected'
  | 'email_taken'
  | 'database_rejected';

export class BootstrapError extends Error {
  constructor(
    readonly code: BootstrapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** Lo minimo que se usa de `pg.Client` (la conexion del propietario). */
export interface OwnerClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface BootstrapInput {
  domain: BootstrapDomain;
  email: string;
  displayName: string;
  /** Referencia del acta firmada que respalda la inicializacion. */
  acta: string;
}

export interface BootstrapDeps {
  client: OwnerClient;
  passwords: PasswordService;
  /** Pide la contrasena a la persona titular (prompt oculto, doble captura). Nunca se registra. */
  readPassword: () => Promise<string>;
  /** Solo pruebas: permite simular la aprobacion del procedimiento escolar en un clúster desechable. */
  procedures?: typeof BOOTSTRAP_PROCEDURES;
}

export interface BootstrapResult {
  userId: string;
  domain: BootstrapDomain;
  role: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface SqlError {
  code?: string;
  message?: string;
}

export async function bootstrapFirstAuthority(
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const { client, passwords } = deps;
  const procedure = (deps.procedures ?? BOOTSTRAP_PROCEDURES)[input.domain];
  if (!procedure) throw new BootstrapError('invalid_input', 'Dominio no valido');
  if (!procedure.approved) throw new BootstrapError('procedure_blocked', procedure.blockedReason);

  const email = normalizeEmail(input.email);
  const acta = input.acta.trim();
  const displayName = input.displayName.trim();
  if (!EMAIL_RE.test(email) || email.length > 254)
    throw new BootstrapError('invalid_input', 'Correo no valido');
  if (displayName.length < 1 || displayName.length > 120)
    throw new BootstrapError('invalid_input', 'El nombre debe tener entre 1 y 120 caracteres');
  if (acta.length < 3 || acta.length > 200)
    throw new BootstrapError(
      'invalid_input',
      'La referencia del acta debe tener entre 3 y 200 caracteres',
    );

  // Precondiciones de solo lectura: ejecutor, estado del dominio, rol existente.
  const owner = await client.query<{ owner: boolean }>(`SELECT auth_is_schema_owner() AS owner`);
  if (!owner.rows[0]?.owner)
    throw new BootstrapError(
      'not_owner',
      'Solo el propietario del esquema (eta15_app) puede ejecutar el bootstrap',
    );
  const initialized = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_roles WHERE domain = $1`,
    [input.domain],
  );
  if (initialized.rows[0]!.n > 0)
    throw new BootstrapError(
      'already_initialized',
      `El dominio ${input.domain} ya fue inicializado; el bootstrap no puede repetirse (use el procedimiento de recuperacion)`,
    );

  // La persona titular teclea su propia contrasena (despues de las comprobaciones, para no pedirla en vano).
  const password = await deps.readPassword();
  const policy =
    typeof password === 'string' ? validateNewPassword(password, { email, displayName }) : null;
  if (!policy || !policy.ok)
    throw new BootstrapError(
      'password_rejected',
      `La contrasena no cumple la politica (${policy && !policy.ok ? policy.reasons.join(', ') : 'no es texto'})`,
    );
  let hash: string;
  try {
    hash = await passwords.hash(password);
  } catch {
    throw new BootstrapError('password_rejected', 'La contrasena no es valida');
  }

  // Secreto de un solo uso: existe unicamente en memoria durante esta transaccion y se descarta.
  const tokenHash = createHash('sha256').update(randomBytes(32)).digest();

  await client.query('BEGIN'); // READ COMMITTED (exigido por el trigger)
  try {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, email_kind, display_name, account_domain, status)
       VALUES ($1, 'institutional', $2, $3, 'pending') RETURNING id`,
      [email, displayName, input.domain],
    );
    const userId = user.rows[0]!.id;
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
       SELECT $1, r.id, r.domain, NULL, 'bootstrap', $3 FROM roles r WHERE r.key = $2`,
      [userId, procedure.role, acta],
    );
    const token = await client.query<{ id: string }>(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'invite', $2, now() + interval '1 hour') RETURNING id`,
      [userId, tokenHash],
    );
    const tokenId = token.rows[0]!.id;
    await client.query(
      `UPDATE auth_tokens SET authorized_at = now(), verification_method = 'ceremony' WHERE id = $1`,
      [tokenId],
    );
    await client.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [tokenId]);
    await client.query(
      `UPDATE users SET status = 'active', password_hash = $2, password_changed_at = now() WHERE id = $1`,
      [userId, hash],
    );
    await client.query(
      `INSERT INTO audit_events (event_type, outcome, subject_user_id, details)
       VALUES ('bootstrap.executed', 'success', $1, $2::jsonb)`,
      [userId, JSON.stringify({ domain: input.domain, role: procedure.role, acta })],
    );
    await client.query('COMMIT');
    return { userId, domain: input.domain, role: procedure.role };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = error as SqlError;
    if (e.code === '23505')
      throw new BootstrapError('email_taken', 'Ya existe una cuenta con ese correo');
    if (e.code === '42501' && /Bootstrap cerrado|ya fue inicializado/.test(e.message ?? ''))
      throw new BootstrapError(
        'already_initialized',
        `El dominio ${input.domain} ya fue inicializado`,
      );
    // Cualquier otra causa: se informa solo el codigo SQLSTATE (nunca el texto, que podria incluir datos).
    throw new BootstrapError(
      'database_rejected',
      `La base de datos rechazo el bootstrap (${e.code ?? 'sin codigo'})`,
    );
  }
}
