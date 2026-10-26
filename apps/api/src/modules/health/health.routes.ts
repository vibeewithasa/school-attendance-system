import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ReadyResponse } from '@eta15/shared-contracts';
import type { Database } from '../../db/client.js';

interface HealthRouteOptions {
  /** Base de datos usada por /ready. Si no se inyecta, /ready responde not_ready. */
  database?: Database;
  readyTimeoutMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadyTimeoutError('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class ReadyTimeoutError extends Error {}

/** Motivo seguro para logs: codigo de error (propio o de la causa de Drizzle); nunca el mensaje. */
function failureReason(err: unknown): string {
  if (err instanceof ReadyTimeoutError) return 'timeout';
  const code =
    (err as { code?: unknown }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' ? code : 'unavailable';
}

/**
 * GET /health (liveness): confirma unicamente que el proceso HTTP responde.
 *   No consulta PostgreSQL ni otras dependencias.
 * GET /ready (readiness): ejecuta una consulta real y ligera a PostgreSQL.
 *   200 {status:"ready"} si responde; 503 {status:"not_ready"} si no, sin detalles internos.
 *   En despliegues futuros su acceso debe restringirse por infraestructura.
 */
export function healthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'eta15-api',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (request, reply): Promise<ReadyResponse> => {
    try {
      if (!options.database) throw new Error('database_not_configured');
      await withTimeout(options.database.ping(), options.readyTimeoutMs);
      return { status: 'ready' };
    } catch (err) {
      // Solo se registra el codigo del error: el mensaje puede contener host, usuario o SQL.
      request.log.warn({ reason: failureReason(err) }, 'readiness fallido');
      return reply.status(503).send({ status: 'not_ready' });
    }
  });
}
