import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/**
 * Crea una base PostgreSQL EN MEMORIA (PGlite, motor PG 18) con TODAS las migraciones de apps/api/drizzle
 * aplicadas por el mismo lector que usa el migrador de Drizzle. Nunca toca eta15_dev.
 */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  const dir = join(import.meta.dirname, '..', '..', 'drizzle');
  for (const migration of readMigrationFiles({ migrationsFolder: dir })) {
    for (const stmt of migration.sql) await db.exec(stmt);
  }
  return db;
}

/** SQLSTATE o mensaje del error de una promesa que se espera que falle. */
export async function failure(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: err.message ?? String(e) };
  }
  throw new Error('Se esperaba un error y la operacion tuvo exito');
}
