import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@eta15/shared-contracts';

/**
 * Liveness: confirma unicamente que el proceso HTTP responde.
 * No consulta PostgreSQL ni otras dependencias; un readiness check real llegara con la capa de datos.
 */
export function healthRoutes(app: FastifyInstance): void {
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'eta15-api',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));
}
