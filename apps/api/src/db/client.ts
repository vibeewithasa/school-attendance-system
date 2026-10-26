import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * Crea el pool y el cliente Drizzle. pg.Pool conecta de forma perezosa:
 * crear el cliente NO verifica que PostgreSQL este disponible.
 * Aun no se usa desde buildApp; se cablea cuando exista el primer modulo con datos.
 */
export function createDb(env: Env) {
  const pool = new pg.Pool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: 10,
  });
  return { pool, db: drizzle(pool, { schema }) };
}
