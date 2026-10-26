import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import {
  API_ROLE_NAME,
  IDENTITY_SQL,
  ownerIdentityProblems,
  runtimeIdentityProblems,
  type IdentityRow,
} from '../src/db/identity.js';
import { API_DIR } from './drizzle-guard.js';

/**
 * Identidad de las conexiones configuradas. Nunca imprime contrasenas ni cadenas de conexion.
 *   pnpm db:whoami   comprueba .env (rol de ejecucion de la API) y .env.migrator (propietario/migrador).
 * Las herramientas que modifican la base (db:migrate, futuras de bootstrap) usan checkOwnerConnection() antes de actuar.
 */

export type EnvFileName = '.env' | '.env.migrator';

export function readEnvFile(name: EnvFileName): Record<string, string> | null {
  const path = join(API_DIR, name);
  return existsSync(path) ? (parseEnv(readFileSync(path, 'utf8')) as Record<string, string>) : null;
}

export async function fetchIdentity(env: Record<string, string>): Promise<IdentityRow> {
  const client = new pg.Client({
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME ?? 'eta15_dev',
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
    application_name: 'eta15-db-whoami',
  });
  await client.connect();
  try {
    const result = await client.query<IdentityRow>(IDENTITY_SQL);
    const row = result.rows[0];
    if (!row) throw new Error('no se pudo determinar la identidad');
    return row;
  } finally {
    await client.end();
  }
}

/** Mensaje de error sin datos sensibles (solo el codigo de PostgreSQL / de red). */
export function safeError(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return e.code
    ? `codigo ${e.code}`
    : (e.message ?? 'error').split('\n')[0]!.replace(/password=\S+/gi, 'password=***');
}

/** Garantiza que las credenciales del migrador son las del PROPIETARIO y no las de la API. Lanza si no. */
export async function checkOwnerConnection(env: Record<string, string>): Promise<IdentityRow> {
  if (!env.DB_USER || !env.DB_PASSWORD)
    throw new Error('.env.migrator no define DB_USER y DB_PASSWORD');
  if (env.DB_USER === API_ROLE_NAME)
    throw new Error(`.env.migrator no puede usar ${API_ROLE_NAME}`);
  let row: IdentityRow;
  try {
    row = await fetchIdentity(env);
  } catch (error) {
    throw new Error(`no se pudo conectar como migrador (${safeError(error)})`, { cause: error });
  }
  const problems = ownerIdentityProblems(row);
  if (problems.length > 0)
    throw new Error(`identidad del migrador invalida: ${problems.join('; ')}`);
  return row;
}

async function main(): Promise<number> {
  let failed = false;
  const api = readEnvFile('.env');
  const migrator = readEnvFile('.env.migrator');
  console.log('Comprobacion de identidades de PostgreSQL (sin mostrar contrasenas)');

  for (const [label, file, env, check] of [
    ['API (ejecucion)', '.env', api, runtimeIdentityProblems],
    ['Migrador (propietario)', '.env.migrator', migrator, ownerIdentityProblems],
  ] as const) {
    if (!env) {
      console.log(`- ${label}: falta apps/api/${file}`);
      failed = true;
      continue;
    }
    if (!env.DB_PASSWORD) {
      console.log(
        `- ${label}: DB_USER=${env.DB_USER ?? '(sin definir)'} pero sin DB_PASSWORD (use tools\\set-db-password.ps1)`,
      );
      failed = true;
      continue;
    }
    try {
      const row = await fetchIdentity(env);
      const problems = check(row);
      console.log(
        `- ${label}: conecta como ${row.usuario} | superusuario=${row.rolsuper} propietario_bd=${row.es_dueno_bd} crea_en_public=${row.crea_en_public} temporales=${row.crea_temporales} -> ${problems.length === 0 ? 'OK' : 'PROBLEMAS: ' + problems.join('; ')}`,
      );
      if (problems.length > 0) failed = true;
    } catch (error) {
      console.log(`- ${label}: no conecta (${safeError(error)})`);
      failed = true;
    }
  }
  if (api && migrator && api.DB_USER && api.DB_USER === migrator.DB_USER) {
    console.log(
      '- Las dos configuraciones usan el MISMO rol: la API no esta separada del migrador.',
    );
    failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
