import type { Pool } from 'pg';
import type { SessionStore, SqlClient } from './session-service.js';

/** Adaptador de `pg.Pool` al puerto de transacciones del servicio de sesiones. */
export function createPgSessionStore(pool: Pool): SessionStore {
  return {
    async transaction(fn) {
      const client = await pool.connect();
      const tx: SqlClient = {
        query: (text, params) => client.query(text, params as unknown[]) as never,
      };
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // Si ni siquiera el ROLLBACK funciona, la conexion se descarta en lugar de volver al pool en mal estado.
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
}
