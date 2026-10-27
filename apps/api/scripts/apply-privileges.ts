import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { applyPrivileges, sha256 } from '../src/db/privilege-apply.js';
import { API_DIR } from './drizzle-guard.js';
import { checkOwnerConnection, readEnvFile, safeError } from './db-identity.js';

/**
 * Aplica una propuesta de privilegios REVISADA (tools/db/privileges) con el propietario de migraciones.
 *   pnpm db:apply-privileges 0002-school-catalog-write --sha256=<hash del .apply.sql revisado>            (ensayo: ROLLBACK)
 *   pnpm db:apply-privileges 0002-school-catalog-write --sha256=<hash> --execute                          (COMMIT)
 * Solo admite la lista blanca de abajo; exige 127.0.0.1:5432 / eta15_dev / eta15_app; ejecuta preflight + GRANT + verificador en
 * una sola transaccion. Nunca imprime contrasenas ni cadenas de conexion.
 */
const ALLOWED = ['0002-school-catalog-write'] as const;
const DIR = join(API_DIR, '..', '..', 'tools', 'db', 'privileges');

async function main(): Promise<number> {
  const [name, ...flags] = process.argv.slice(2).filter((a) => a !== '--');
  if (!name || !(ALLOWED as readonly string[]).includes(name)) {
    console.error(`Uso: db:apply-privileges <${ALLOWED.join('|')}> --sha256=<hash> [--execute]`);
    return 2;
  }
  const execute = flags.includes('--execute');
  const expected = flags.find((f) => f.startsWith('--sha256='))?.slice('--sha256='.length);
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    console.error('Falta --sha256=<64 hex> del archivo .apply.sql revisado');
    return 2;
  }
  const read = (file: string) => readFileSync(join(DIR, file), 'utf8');
  const applySql = read(`${name}.apply.sql`);
  const verifySql = read(`${name}.verify.sql`);
  const proposalSql = read(`${name}.proposal.sql`);
  console.log(
    `Archivos (SHA-256): apply=${sha256(applySql)} verify=${sha256(verifySql)} proposal=${sha256(proposalSql)}`,
  );

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
    application_name: 'eta15-apply-privileges',
  });
  await client.connect();
  try {
    const report = await applyPrivileges(client, {
      applySql,
      verifySql,
      proposalSql,
      expectedApplySha256: expected,
      commit: execute,
    });
    console.log(`GRANT ejecutados (${report.grants.length}):`);
    for (const g of report.grants) console.log(`  ${g.replace(/\s+/g, ' ')};`);
    console.log(
      execute
        ? 'COMMIT realizado: privilegios aplicados y verificados en la misma transaccion.'
        : 'ENSAYO correcto: preflight, GRANT y verificador pasaron; se hizo ROLLBACK (nada cambio).',
    );
    return 0;
  } catch (error) {
    console.error(`FALLO sin cambios (ROLLBACK): ${safeError(error)}`);
    const msg = (error as { message?: string }).message ?? '';
    if (/Preflight|Privilegios efectivos|archivo de ejecucion|SHA-256/.test(msg))
      console.error(msg);
    return 1;
  } finally {
    await client.end();
  }
}

process.exit(await main());
