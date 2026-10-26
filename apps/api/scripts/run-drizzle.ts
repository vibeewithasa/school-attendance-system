import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_DIR, DRIZZLE_DIR, destructiveStatements, preflight } from './drizzle-guard.js';

/**
 * Ejecuta drizzle-kit SIEMPRE desde apps/api y solo despues de las verificaciones.
 *   pnpm db:generate [-- --name=x | --custom --name=x]   genera; revierte si el SQL es destructivo
 *   pnpm db:check                                        consistencia del historial
 *   pnpm db:migrate                                      aplica (solo migraciones confirmadas en Git)
 * No expone --force ni omite verificaciones de Drizzle.
 */
const [command, ...rest] = process.argv.slice(2);
if (!command || !['generate', 'check', 'migrate'].includes(command)) {
  console.error(
    'Uso: tsx scripts/run-drizzle.ts <generate|check|migrate> [opciones de drizzle-kit]',
  );
  process.exit(2);
}
if (rest.some((a) => /^--(force|ignore-conflicts)\b/.test(a))) {
  console.error('Opcion no permitida: este envoltorio no desactiva verificaciones de Drizzle.');
  process.exit(2);
}

const problems = preflight(command === 'migrate' ? 'migrate' : 'generate');
if (problems.length > 0) {
  console.error('Verificaciones previas fallidas; no se ejecuta Drizzle:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (command === 'migrate' && existsSync(join(API_DIR, '.env')))
  process.loadEnvFile(join(API_DIR, '.env'));

const sqlFiles = () => new Set(readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')));
const metaFiles = () => new Set(readdirSync(join(DRIZZLE_DIR, 'meta')));
const journalPath = join(DRIZZLE_DIR, 'meta', '_journal.json');
const journalBefore = readFileSync(journalPath, 'utf8');
const sqlBefore = sqlFiles();
const metaBefore = metaFiles();

const bin = join(API_DIR, 'node_modules', 'drizzle-kit', 'bin.cjs');
const result = spawnSync(process.execPath, [bin, command, ...rest], {
  cwd: API_DIR,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (command === 'generate') {
  const created = [...sqlFiles()].filter((f) => !sqlBefore.has(f));
  const bad = created.flatMap((f) =>
    destructiveStatements(readFileSync(join(DRIZZLE_DIR, f), 'utf8')).map((s) => `${f}: ${s}`),
  );
  if (bad.length > 0) {
    // Se revierte solo lo recien generado por esta ejecucion.
    for (const f of created) rmSync(join(DRIZZLE_DIR, f));
    for (const f of [...metaFiles()].filter((f) => !metaBefore.has(f)))
      rmSync(join(DRIZZLE_DIR, 'meta', f));
    writeFileSync(journalPath, journalBefore);
    console.error('SQL generado con operaciones destructivas; se descarto lo generado:');
    for (const b of bad) console.error(`  - ${b}`);
    console.error(
      'Revisa el esquema. Si el cambio es intencional, escribe la migracion a mano (--custom).',
    );
    process.exit(1);
  }
}
