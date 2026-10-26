import type { SqlClient } from '../auth/session-service.js';

/** Contexto de una peticion para la auditoria. El actor puede faltar (acciones anonimas del titular). */
export interface AuditContext {
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditEvent {
  /** `categoria.accion` en minusculas (restriccion de la tabla). */
  type: string;
  outcome: 'success' | 'failure' | 'denied';
  subject?: string | null;
  /** Objeto JSON SIN secretos: jamas contrasenas, tokens, hashes ni cuerpos de peticion. */
  details: Record<string, unknown>;
}

export async function recordAudit(
  tx: SqlClient,
  ctx: AuditContext,
  event: AuditEvent,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (event_type, outcome, actor_user_id, subject_user_id, ip, user_agent, request_id, details)
     VALUES ($1, $2, $3, $4, $5::inet, $6, $7, $8::jsonb)`,
    [
      event.type,
      event.outcome,
      ctx.actorId ?? null,
      event.subject ?? null,
      ctx.ip ?? null,
      ctx.userAgent ? ctx.userAgent.slice(0, 256) : null,
      ctx.requestId ?? null,
      JSON.stringify(event.details),
    ],
  );
}
