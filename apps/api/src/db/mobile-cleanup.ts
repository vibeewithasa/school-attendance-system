/**
 * Limpieza operativa del estado EFIMERO y de los datos de red del canal movil (prototipo; ADR 0005 propuesto).
 *
 * La ejecuta el PROPIETARIO del esquema (`eta15_app`), nunca la API: `eta15_api` no tiene DELETE ni UPDATE sobre estas columnas.
 * Es de alcance acotado y segura por construccion:
 *   1. Retira pruebas DPoP (`mobile_proof_jtis`) y nonces (`mobile_nonces`) vencidos hace MAS del margen (minimo 60 minutos: el
 *      trigger de la base tambien lo exige, de modo que jamas se borra estado que aun protege contra la repeticion).
 *   2. CIERRA (status `cancelled`; no borra) solicitudes de vinculacion abiertas y ya vencidas.
 *   3. ANONIMIZA (pone a NULL; no borra) la IP de solicitudes y la IP y el agente de sesiones tras su plazo de retencion.
 * No toca datos escolares ni cuentas. Cada paso procesa como maximo `limit` filas por ejecucion. Una ejecucion a la vez
 * (advisory lock). Ensayo (`execute: false`): se ejecuta todo en una transaccion y se hace ROLLBACK, asi el informe es exacto y
 * no queda ningun cambio. El informe solo lleva conteos: nunca tokens, hashes, IP ni identificadores.
 */
export interface CleanupClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
    affectedRows?: number;
  }>;
}

export interface CleanupOptions {
  /** `false` (por defecto) = ensayo con ROLLBACK. */
  execute: boolean;
  /** Maximo de filas por paso y por ejecucion. */
  limit: number;
  /** Margen tras el vencimiento antes de retirar estado efimero (minutos; minimo 60). */
  marginMinutes: number;
  /** Dias de conservacion provisional de la IP de una solicitud tras cerrarse o vencer. */
  requestIpDays: number;
  /** Dias de conservacion provisional de la IP y el agente de una sesion tras terminar. */
  sessionIpDays: number;
}

export const CLEANUP_DEFAULTS: CleanupOptions = {
  execute: false,
  limit: 5000,
  marginMinutes: 120,
  requestIpDays: 7,
  sessionIpDays: 30,
};

export interface CleanupReport {
  mode: 'ensayo' | 'ejecucion';
  skipped?: 'tablas-moviles-ausentes';
  limit: number;
  marginMinutes: number;
  requestIpDays: number;
  sessionIpDays: number;
  deleted: { proofJtis: number; nonces: number };
  closedExpiredRequests: number;
  anonymized: { requestIps: number; sessionRows: number };
  /** `true` si algun paso llego al limite: quedan mas filas por procesar en la siguiente ejecucion. */
  moreWork: boolean;
}

export class CleanupBusyError extends Error {
  constructor() {
    super('Ya hay una limpieza movil en curso');
    this.name = 'CleanupBusyError';
  }
}

const LOCK_NAME = 'eta15:mobile-cleanup';

export function validateCleanupOptions(o: CleanupOptions): void {
  const int = (v: number, min: number, max: number, name: string) => {
    if (!Number.isInteger(v) || v < min || v > max)
      throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  };
  int(o.limit, 1, 50_000, 'limit');
  int(o.marginMinutes, 60, 10_080, 'marginMinutes');
  int(o.requestIpDays, 1, 365, 'requestIpDays');
  int(o.sessionIpDays, 1, 365, 'sessionIpDays');
}

export async function runMobileCleanup(
  client: CleanupClient,
  options: CleanupOptions,
): Promise<CleanupReport> {
  validateCleanupOptions(options);
  const { limit } = options;
  const report: CleanupReport = {
    mode: options.execute ? 'ejecucion' : 'ensayo',
    limit,
    marginMinutes: options.marginMinutes,
    requestIpDays: options.requestIpDays,
    sessionIpDays: options.sessionIpDays,
    deleted: { proofJtis: 0, nonces: 0 },
    closedExpiredRequests: 0,
    anonymized: { requestIps: 0, sessionRows: 0 },
    moreWork: false,
  };
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    const lock = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`,
      [LOCK_NAME],
    );
    if (lock.rows[0]!.ok !== true) throw new CleanupBusyError();
    const present = await client.query(
      `SELECT to_regclass('public.mobile_proof_jtis') IS NOT NULL
          AND to_regclass('public.mobile_nonces') IS NOT NULL
          AND to_regclass('public.mobile_device_requests') IS NOT NULL
          AND to_regclass('public.mobile_sessions') IS NOT NULL AS ok`,
    );
    if (present.rows[0]!.ok !== true) {
      report.skipped = 'tablas-moviles-ausentes';
      await client.query('ROLLBACK');
      return report;
    }
    const count = async (sql: string, params: unknown[]) => {
      const r = await client.query(sql, params);
      return r.rowCount ?? r.affectedRows ?? 0;
    };

    // 1. Estado efimero vencido hace mas del margen (la base rechaza cualquier borrado de menos de una hora).
    const cutoff = `now() - make_interval(mins => $2)`;
    for (const [table, key] of [
      ['mobile_proof_jtis', 'proofJtis'],
      ['mobile_nonces', 'nonces'],
    ] as const) {
      const n = await count(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE expires_at < ${cutoff} ORDER BY expires_at LIMIT $1)`,
        [limit, options.marginMinutes],
      );
      report.deleted[key] = n;
      if (n >= limit) report.moreWork = true;
    }
    // 2. Solicitudes abiertas ya vencidas: se cierran (historia conservada) para que no ocupen cupos ni bloqueen a nadie.
    report.closedExpiredRequests = await count(
      `UPDATE mobile_device_requests SET status = 'cancelled'
        WHERE id IN (SELECT id FROM mobile_device_requests
                      WHERE status IN ('pending', 'claimed', 'approved') AND expires_at < now() ORDER BY expires_at LIMIT $1)`,
      [limit],
    );
    if (report.closedExpiredRequests >= limit) report.moreWork = true;
    // 3. Retencion de datos de red: se anonimiza, no se borra la fila.
    report.anonymized.requestIps = await count(
      `UPDATE mobile_device_requests SET requested_ip = NULL
        WHERE id IN (SELECT id FROM mobile_device_requests
                      WHERE requested_ip IS NOT NULL AND status IN ('activated', 'rejected', 'cancelled')
                        AND coalesce(closed_at, activated_at, expires_at) < now() - make_interval(days => $2)
                      ORDER BY created_at LIMIT $1)`,
      [limit, options.requestIpDays],
    );
    report.anonymized.sessionRows = await count(
      `UPDATE mobile_sessions SET ip = NULL, user_agent = NULL
        WHERE id IN (SELECT id FROM mobile_sessions
                      WHERE (ip IS NOT NULL OR user_agent IS NOT NULL)
                        AND least(coalesce(revoked_at, 'infinity'::timestamptz), absolute_expires_at) < now() - make_interval(days => $2)
                      ORDER BY created_at LIMIT $1)`,
      [limit, options.sessionIpDays],
    );
    if (report.anonymized.requestIps >= limit || report.anonymized.sessionRows >= limit)
      report.moreWork = true;

    if (options.execute) {
      // Registro de seguridad de la limpieza (solo conteos y parametros; ningun dato personal ni credencial).
      await client.query(
        `INSERT INTO audit_events (event_type, outcome, details) VALUES ('mobile.cleanup_run', 'success', $1::jsonb)`,
        [JSON.stringify(report)],
      );
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
