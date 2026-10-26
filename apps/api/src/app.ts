import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Env } from './config/env.js';
import { registerErrorHandling } from './shared/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN.split(',') });
  registerErrorHandling(app);

  // Cada modulo de negocio se registra aqui con su prefijo (p. ej. /api/v1/alumnos).
  healthRoutes(app);

  return app;
}
