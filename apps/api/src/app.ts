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

/**
 * Los valores de la cadena de consulta NO se registran: ningun cliente legitimo pone credenciales en la URL, pero un cliente con
 * un defecto (p. ej. `?access_token=...`) no debe terminar dejando su token en los registros. Se conservan los NOMBRES de los
 * parametros (utiles para depurar) y se omiten sus valores.
 */
export function redactQueryValues(url: string): string {
  const i = url.indexOf('?');
  return i < 0 ? url : `${url.slice(0, i)}${url.slice(i).replace(/=[^&#]*/g, '=[redacted]')}`;
}

export async function buildApp(env: Env, deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      serializers: {
        // Igual que el serializador por defecto de Fastify, pero sin los valores de la consulta.
        req: (request) => ({
          method: request.method,
          url: redactQueryValues(request.url),
          version: String(request.headers['accept-version'] ?? '') || undefined,
          hostname: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }),
      },
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
  await app.register(cors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
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
