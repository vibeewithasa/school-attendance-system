import pg from 'pg';
import {
  CLEANUP_DEFAULTS,
  CleanupBusyError,
  runMobileCleanup,
  type CleanupOptions,
} from '../src/db/mobile-cleanup.js';
import { checkOwnerConnection, readEnvFile, safeError } from './db-identity.js';

/**
 * Limpieza del estado efimero y de los datos de red del canal movil (ver src/db/mobile-cleanup.ts y el ADR 0005).
 *   pnpm db:mobile-cleanup                      ENSAYO: ejecuta todo y hace ROLLBACK (informe exacto, nada cambia)
 *   pnpm db:mobile-cleanup -- --execute         COMMIT (solo con autorizacion de operacion)
 *   Opciones: --limit=5000 --margin-minutes=120 --request-ip-days=7 --session-ip-days=30
 * La corre el propietario (apps/api/.env.migrator: eta15_app); la API nunca recibe esas credenciales. Solo 127.0.0.1:5432 /
 * eta15_dev. No se programa ninguna tarea automatica sin aprobacion de operacion. Nunca imprime contrasenas ni cadenas de conexion.
 */
async function main(): Promise<number> {
  const flags = process.argv.slice(2).filter((a) => a !== '--');
  const num = (name: string, fallback: number) => {
    const raw = flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
    return raw === undefined ? fallback : Number(raw);
  };
  const known = [
    '--execute',
    '--limit=',
    '--margin-minutes=',
    '--request-ip-days=',
    '--session-ip-days=',
  ];
  const unknown = flags.filter((f) => !known.some((k) => f === k || f.startsWith(k)));
  if (unknown.length > 0) {
    console.error(`Opciones no reconocidas: ${unknown.join(' ')}`);
    return 2;
  }
  const options: CleanupOptions = {
    execute: flags.includes('--execute'),
    limit: num('limit', CLEANUP_DEFAULTS.limit),
    marginMinutes: num('margin-minutes', CLEANUP_DEFAULTS.marginMinutes),
    requestIpDays: num('request-ip-days', CLEANUP_DEFAULTS.requestIpDays),
    sessionIpDays: num('session-ip-days', CLEANUP_DEFAULTS.sessionIpDays),
  };

  const env = readEnvFile('.env.migrator');
  if (!env) {
    console.error('No existe apps/api/.env.migrator');
    return 1;
  }
  if (
    (env.DB_HOST ?? '127.0.0.1') !== '127.0.0.1' ||
    Number(env.DB_PORT ?? 5432) !== 5432 ||
    (env.DB_NAME ?? 'eta15_dev') !== 'eta15_dev'
  ) {
    console.error('Destino no permitido: solo 127.0.0.1:5432 / eta15_dev');
    return 1;
  }
  try {
    await checkOwnerConnection(env);
  } catch (error) {
    console.error(`Identidad no valida: ${safeError(error)}`);
    return 1;
  }
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 5432,
    database: 'eta15_dev',
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
    application_name: 'eta15-mobile-cleanup',
  });
  await client.connect();
  try {
    const report = await runMobileCleanup(client, options);
    console.log(JSON.stringify(report, null, 2));
    if (report.skipped)
      console.log(
        'Las tablas moviles no existen (migraciones 0011/0012 sin aplicar): nada que limpiar.',
      );
    else if (!options.execute)
      console.log(
        'ENSAYO: se hizo ROLLBACK; no cambio nada. Use --execute con autorizacion para confirmar.',
      );
    return 0;
  } catch (error) {
    if (error instanceof CleanupBusyError) {
      console.error('Otra limpieza movil esta en curso; reintente despues.');
      return 3;
    }
    console.error(`FALLO: ${safeError(error)}`);
    return 1;
  } finally {
    await client.end();
  }
}

process.exit(await main());
