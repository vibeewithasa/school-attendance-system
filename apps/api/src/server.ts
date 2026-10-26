import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';

const env = loadEnv();
const database = createDatabase(env);
const app = await buildApp(env, { database });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'cerrando servidor');
  await app.close(); // cierra HTTP y despues el pool de PostgreSQL
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.fatal({ err }, 'no se pudo iniciar el servidor');
  await database.close().catch(() => undefined);
  process.exit(1);
}
