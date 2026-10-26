import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { registerErrorHandling } from './shared/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';
import {
  registerAuth,
  registerHttpSecurity,
  type AuthModuleOptions,
} from './modules/auth/auth.module.js';

export interface AppDependencies {
  /** Si se entrega, la app lo cierra al hacer app.close(). */
  database?: Database;
  /** Si se entrega, se registran los endpoints /auth/*; sin almacen no hay autenticacion. */
  auth?: AuthModuleOptions;
  /** Destino alternativo de los logs (pruebas: comprobar que no se filtran secretos). */
  logStream?: { write(chunk: string): void };
}

export async function buildApp(env: Env, deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
      ],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    // trustProxy queda en su valor por defecto (false): ni la IP ni el esquema se toman de cabeceras X-Forwarded-*.
  });

  const origins = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins, credentials: true });
  registerErrorHandling(app);
  await registerHttpSecurity(app, env);

  if (deps.database) {
    const { database } = deps;
    database.onError?.((code) => app.log.error({ code }, 'error en el pool de PostgreSQL'));
    app.addHook('onClose', async () => {
      await database.close();
    });
  }

  // Cada modulo de negocio se registra aqui con su prefijo (p. ej. /api/v1/alumnos).
  healthRoutes(app, { database: deps.database, readyTimeoutMs: env.READY_TIMEOUT_MS });
  if (deps.auth) await registerAuth(app, env, deps.auth);

  return app;
}
