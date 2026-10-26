/**
 * Control dual de la activacion y procedimiento EXCEPCIONAL para incorporar a la segunda autoridad de un dominio.
 *
 * Regla general: ninguna autoridad aprueba la activacion de una cuenta que ella misma creo (otra autoridad distinta lo hace).
 * Consecuencia: con UNA sola autoridad en el dominio nadie puede aprobar activaciones. El unico camino es esta dispensa
 * excepcional, que NO se puede pedir por HTTP: la concede el propietario del esquema desde la consola, con acta, para UNA cuenta
 * pendiente que ya tiene un rol de autoridad y solo mientras el dominio tenga una sola autoridad activa. La dispensa caduca,
 * se consume una sola vez y todo queda en `audit_events` (`activation.waiver_granted` / `activation.waiver_used`).
 *
 * Limite honesto: es un control de aplicacion (la base no distingue "creador"); lo vigila la auditoria. Quien controle las
 * credenciales de la API o de la base podria falsificar un evento: es el techo de confianza de cualquier control en datos.
 */
import type { RoleDomain } from '../access-control/catalog.js';
import type { OwnerClient } from '../auth/bootstrap.js';
import type { SqlClient } from '../auth/session-service.js';
import { normalizeEmail } from '@eta15/shared-contracts';

export const WAIVER_DEFAULT_HOURS = 24;
export const WAIVER_MAX_HOURS = 72;

/**
 * Estado del procedimiento institucional por dominio. `school` esta BLOQUEADO: falta definir quien, como y con que documento
 * autoriza incorporar la segunda autoridad escolar (decision D-ESC/D-DUAL de docs/architecture/auth-rbac.md). Cambiarlo es un
 * cambio de codigo revisado, junto con el procedimiento aprobado.
 */
export const SECOND_AUTHORITY_PROCEDURES: Record<
  RoleDomain,
  { approved: boolean; blockedReason: string }
> = {
  technical: { approved: true, blockedReason: '' },
  school: {
    approved: false,
    blockedReason:
      'Falta el procedimiento institucional que autorice incorporar a la segunda autoridad escolar (quien firma, que documento y quien custodia el acta). El paso esta preparado pero bloqueado hasta que se apruebe (auth-rbac.md §6, decisiones D-ESC y D-DUAL).',
  },
};

export type WaiverErrorCode =
  'procedure_blocked' | 'invalid_input' | 'not_owner' | 'not_applicable' | 'database_rejected';

export class WaiverError extends Error {
  constructor(
    readonly code: WaiverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WaiverError';
  }
}

/** Titulares ACTIVOS con autoridad (roles:grant_<dominio>) en el dominio. */
export async function activeAuthorityCount(tx: SqlClient, domain: RoleDomain): Promise<number> {
  const r = await tx.query<{ n: number }>(
    `SELECT count(DISTINCT ur.user_id)::int AS n
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id AND u.status = 'active'
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.domain = $1 AND ur.revoked_at IS NULL AND p.key = 'roles:grant_' || $1`,
    [domain],
  );
  return r.rows[0]!.n;
}

/** ¿La cuenta tiene un rol vigente con permisos de AUTORIDAD? */
export async function holdsAuthorityRole(tx: SqlClient, userId: string): Promise<boolean> {
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND p.is_authority`,
    [userId],
  );
  return r.rows[0]!.n > 0;
}

/**
 * Dispensa vigente para que el CREADOR apruebe la activacion de `userId`: sin caducar, sin usar, la cuenta con rol de autoridad
 * y el dominio con una sola autoridad activa (si ya hay otra, debe aprobar ella).
 */
export async function findUsableWaiver(
  tx: SqlClient,
  userId: string,
  domain: RoleDomain,
): Promise<string | null> {
  const w = await tx.query<{ id: string }>(
    `SELECT w.id::text AS id FROM audit_events w
      WHERE w.event_type = 'activation.waiver_granted' AND w.subject_user_id = $1
        AND (w.details->>'expiresAt')::timestamptz > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM audit_events u
                         WHERE u.event_type = 'activation.waiver_used' AND u.details->>'waiverId' = w.id::text)
      ORDER BY w.occurred_at DESC LIMIT 1`,
    [userId],
  );
  const id = w.rows[0]?.id;
  if (!id) return null;
  if (!(await holdsAuthorityRole(tx, userId))) return null;
  if ((await activeAuthorityCount(tx, domain)) > 1) return null;
  return id;
}

export interface WaiverInput {
  /** Correo de la cuenta PENDIENTE (con rol de autoridad) que se va a activar. */
  email: string;
  /** Referencia del acta firmada (autorizacion externa). Evidencia humana: no sustituye la decision institucional. */
  acta: string;
  hours?: number;
}

export interface WaiverResult {
  waiverId: string;
  userId: string;
  domain: RoleDomain;
  expiresAt: Date;
}

/** Concede la dispensa. Solo el propietario del esquema (consola); `procedures` se puede sustituir unicamente en pruebas. */
export async function grantSecondAuthorityWaiver(
  input: WaiverInput,
  deps: { client: OwnerClient; procedures?: typeof SECOND_AUTHORITY_PROCEDURES },
): Promise<WaiverResult> {
  const { client } = deps;
  const acta = input.acta.trim();
  const email = normalizeEmail(input.email);
  const hours = input.hours ?? WAIVER_DEFAULT_HOURS;
  if (acta.length < 3 || acta.length > 200)
    throw new WaiverError(
      'invalid_input',
      'La referencia del acta debe tener entre 3 y 200 caracteres',
    );
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new WaiverError('invalid_input', 'Correo no valido');
  if (!Number.isFinite(hours) || hours <= 0 || hours > WAIVER_MAX_HOURS)
    throw new WaiverError(
      'invalid_input',
      `La vigencia debe ser mayor que 0 y de maximo ${WAIVER_MAX_HOURS} horas`,
    );

  const owner = await client.query<{ owner: boolean }>(`SELECT auth_is_schema_owner() AS owner`);
  if (!owner.rows[0]?.owner)
    throw new WaiverError(
      'not_owner',
      'Solo el propietario del esquema (eta15_app) puede conceder la dispensa',
    );

  const user = (
    await client.query<{ id: string; account_domain: RoleDomain; status: string }>(
      `SELECT id, account_domain, status FROM users WHERE email = $1`,
      [email],
    )
  ).rows[0];
  if (!user || user.status !== 'pending')
    throw new WaiverError('not_applicable', 'No existe una cuenta pendiente con ese correo');
  const procedure = (deps.procedures ?? SECOND_AUTHORITY_PROCEDURES)[user.account_domain];
  if (!procedure.approved) throw new WaiverError('procedure_blocked', procedure.blockedReason);
  if (!(await holdsAuthorityRole(client, user.id)))
    throw new WaiverError(
      'not_applicable',
      'La cuenta no tiene un rol de autoridad: la activa otra autoridad sin dispensa',
    );
  const authorities = await activeAuthorityCount(client, user.account_domain);
  if (authorities !== 1)
    throw new WaiverError(
      'not_applicable',
      authorities === 0
        ? 'El dominio no tiene ninguna autoridad activa: corresponde el procedimiento de recuperacion, no esta dispensa'
        : 'El dominio ya tiene mas de una autoridad activa: la activacion la aprueba otra autoridad sin dispensa',
    );

  try {
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO audit_events (event_type, outcome, subject_user_id, details)
       VALUES ('activation.waiver_granted', 'success', $1, $2::jsonb) RETURNING id::text AS id`,
      [
        user.id,
        JSON.stringify({
          procedure: 'second_authority',
          domain: user.account_domain,
          acta,
          expiresAt: expiresAt.toISOString(),
          activeAuthorities: authorities,
        }),
      ],
    );
    return {
      waiverId: inserted.rows[0]!.id,
      userId: user.id,
      domain: user.account_domain,
      expiresAt,
    };
  } catch (error) {
    throw new WaiverError(
      'database_rejected',
      `La base de datos rechazo la dispensa (${(error as { code?: string }).code ?? 'sin codigo'})`,
    );
  }
}
