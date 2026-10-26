import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { applyMigrations, startTempPostgres, type TempPostgres } from './pg-temp.js';

/**
 * Clúster PostgreSQL 18 DESECHABLE con la disposicion real de roles: base `eta15_dev` de `eta15_app` y la API conectada
 * como `eta15_api` con EXACTAMENTE los privilegios de tools/db/proposals/eta15_api-roles.proposal.sql (pasos 1-3). No toca
 * el servicio ni eta15_dev. `stop()` cierra el pool y destruye el clúster.
 */
export interface ApiCluster {
  pgt: TempPostgres;
  /** Conexion como eta15_app (propietario). */
  owner: pg.Client;
  /** Pool como eta15_api (rol de ejecucion). */
  pool: pg.Pool;
  stop(): Promise<void>;
}

const proposal = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'tools',
    'db',
    'proposals',
    'eta15_api-roles.proposal.sql',
  ),
  'utf8',
);

function step(name: 'PASO 1' | 'PASO 2' | 'PASO 3'): string[] {
  return proposal
    .split(/^-- ===== /m)
    .find((s) => s.startsWith(name))!
    .split('\n')
    .slice(1)
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\'))
    .join('\n')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function startApiCluster(poolMax = 20): Promise<ApiCluster> {
  const pgt = await startTempPostgres();
  const superuser = await pgt.connect();
  await superuser.query(`create role eta15_app login`);
  await superuser.query(`create database eta15_dev owner eta15_app`);
  const owner = await pgt.connect('eta15_app', 'eta15_dev');
  await applyMigrations(owner);
  for (const stmt of step('PASO 1')) await superuser.query(stmt);
  for (const stmt of step('PASO 2')) await owner.query(stmt);
  for (const stmt of step('PASO 3')) await superuser.query(stmt);
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: pgt.port,
    user: 'eta15_api',
    database: 'eta15_dev',
    max: poolMax,
  });
  return {
    pgt,
    owner,
    pool,
    async stop() {
      await pool.end().catch(() => undefined);
      await pgt.stop();
    },
  };
}
