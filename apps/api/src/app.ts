import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { registerErrorHandling } from './shared/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';

export interface AppDependencies {
  /** Si se entrega, la app lo cierra al hacer app.close(). */
  database?: Database;
}

export async function buildApp(env: Env, deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  await app.register(cors, { origin: env.CORS_ORIGIN.split(',') });
  registerErrorHandling(app);

  if (deps.database) {
    const { database } = deps;
    database.onError?.((code) => app.log.error({ code }, 'error en el pool de PostgreSQL'));
    app.addHook('onClose', async () => {
      await database.close();
    });
  }

  // Cada modulo de negocio se registra aqui con su prefijo (p. ej. /api/v1/alumnos).
  healthRoutes(app, { database: deps.database, readyTimeoutMs: env.READY_TIMEOUT_MS });

  return app;
}
