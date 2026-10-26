import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

/** Lo minimo que el resto de la API necesita saber de la base de datos. */
export interface Database {
  /** Ejecuta una consulta ligera (SELECT 1). Rechaza si PostgreSQL no responde. */
  ping(): Promise<void>;
  /** Cierra el pool. Seguro de llamar mas de una vez. */
  close(): Promise<void>;
  /** Suscribe un oyente a errores del pool (solo el codigo, nunca el mensaje). */
  onError?(listener: (code: string) => void): void;
}

export interface DatabaseHandle extends Database {
  pool: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
}

/**
 * Crea el pool y el cliente Drizzle. pg.Pool conecta de forma perezosa:
 * crear el cliente NO verifica que PostgreSQL este disponible (usar ping()).
 * Las credenciales solo viven en el objeto de configuracion del pool; nunca se registran.
 */
export function createDatabase(env: Env): DatabaseHandle {
  const pool = new pg.Pool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'eta15-api',
  });

  // Un error en un cliente inactivo no debe tumbar el proceso; solo se informa el codigo.
  const listeners: Array<(code: string) => void> = [];
  pool.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    for (const listener of listeners) listener(code);
  });

  const db = drizzle(pool, { schema });
  let closing: Promise<void> | undefined;

  return {
    pool,
    db,
    async ping() {
      await db.execute(sql`select 1`);
    },
    close() {
      closing ??= pool.end();
      return closing;
    },
    onError(listener) {
      listeners.push(listener);
    },
  };
}
