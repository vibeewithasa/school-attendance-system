import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import { checkRuntimeRole } from './db/runtime-guard.js';
import { createPgSessionStore } from './modules/auth/session-store-pg.js';

const env = loadEnv();
const database = createDatabase(env);
const app = await buildApp(env, {
  database,
  auth: { store: createPgSessionStore(database.pool) },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'cerrando servidor');
  await app.close(); // cierra HTTP y despues el pool de PostgreSQL
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// La API jamas debe correr con las credenciales del propietario/migrador (ver docs/architecture/roles-postgresql.md).
const runtime = await checkRuntimeRole(database);
if (runtime.status === 'privileged') {
  app.log.fatal(
    { role: env.DB_USER, problems: runtime.problems },
    'la API se conecto con un rol no apto para ejecucion; configure DB_USER=eta15_api en apps/api/.env',
  );
  // No se usa app.close(): antes de listen() quedaria esperando. Basta cerrar el pool y terminar con error.
  await database.close().catch(() => undefined);
  process.exit(1);
}
if (runtime.status === 'unreachable') {
  app.log.warn(
    'no se pudo verificar el rol de PostgreSQL al arrancar (base no disponible); /ready informara',
  );
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.fatal({ err }, 'no se pudo iniciar el servidor');
  await database.close().catch(() => undefined);
  process.exit(1);
}
