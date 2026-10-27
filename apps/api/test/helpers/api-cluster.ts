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

/** Texto completo de un archivo de tools/db/privileges. */
export function privilegeFile(file: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'tools', 'db', 'privileges', file),
    'utf8',
  );
}

/** Sentencias de un archivo de privilegios de tools/db/privileges (sin comentarios ni metacomandos de psql). */
export function privilegeStatements(file: string): string[] {
  const text = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'tools', 'db', 'privileges', file),
    'utf8',
  );
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Indice (base 0) de la migracion 0007_students_enrollments en el journal. */
const FIRST_STUDENTS_MIGRATION = 7;

export interface ApiClusterOptions {
  /** Aplica la PROPUESTA 0002 (escritura del catalogo escolar). Por defecto NO, como en eta15_dev real. */
  catalogWrite?: boolean;
  /** Aplica la PROPUESTA 0003 (acceso por columna a alumnos, matriculas e historial de grupo). Por defecto NO. */
  studentsWrite?: boolean;
  /** Aplica la PROPUESTA 0004 (acceso por columna a las asignaciones de grupos a prefectura). Por defecto NO. */
  prefectWrite?: boolean;
  /** Aplica la PROPUESTA 0005 (acceso por columna a la asistencia diaria). Por defecto NO. */
  attendanceWrite?: boolean;
}

export async function startApiCluster(
  poolMax = 20,
  options: ApiClusterOptions = {},
): Promise<ApiCluster> {
  const pgt = await startTempPostgres();
  const superuser = await pgt.connect();
  await superuser.query(`create role eta15_app login`);
  await superuser.query(`create database eta15_dev owner eta15_app`);
  const owner = await pgt.connect('eta15_app', 'eta15_dev');
  // Misma historia que eta15_dev: los roles y sus privilegios (PASO 1-3, 2026-10-26) se aplicaron con 0000-0006; las tablas de la
  // migracion 0007 nacen DESPUES y NO heredan ningun privilegio de eta15_api (los concede la propuesta 0003, aparte).
  await applyMigrations(owner, { until: FIRST_STUDENTS_MIGRATION });
  for (const stmt of step('PASO 1')) await superuser.query(stmt);
  for (const stmt of step('PASO 2')) await owner.query(stmt);
  for (const stmt of step('PASO 3')) await superuser.query(stmt);
  await applyMigrations(owner, { from: FIRST_STUDENTS_MIGRATION });
  if (options.catalogWrite) {
    for (const stmt of privilegeStatements('0002-school-catalog-write.proposal.sql'))
      await owner.query(stmt);
    // Verificacion oficial de solo lectura: falla si los privilegios efectivos difieren de lo esperado.
    await owner.query(privilegeFile('0002-school-catalog-write.verify.sql'));
  }
  if (options.studentsWrite) {
    for (const stmt of privilegeStatements('0003-students-write.proposal.sql'))
      await owner.query(stmt);
    await owner.query(privilegeFile('0003-students-write.verify.sql'));
  }
  if (options.prefectWrite) {
    for (const stmt of privilegeStatements('0004-prefect-assignments-write.proposal.sql'))
      await owner.query(stmt);
    await owner.query(privilegeFile('0004-prefect-assignments-write.verify.sql'));
  }
  if (options.attendanceWrite) {
    for (const stmt of privilegeStatements('0005-attendance-write.proposal.sql'))
      await owner.query(stmt);
    await owner.query(privilegeFile('0005-attendance-write.verify.sql'));
  }
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
