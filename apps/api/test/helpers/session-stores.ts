import type { PGlite } from '@electric-sql/pglite';
import type { SessionStore, SqlClient } from '../../src/modules/auth/session-service.js';

/**
 * Puerto de transacciones sobre PGlite. Con `role`, cada transaccion corre con ese rol (`SET LOCAL ROLE`):
 * el servicio se prueba como la API (no propietaria), nunca como el propietario del esquema.
 */
export function pgliteStore(db: PGlite, role?: string): SessionStore {
  return {
    transaction: (fn) =>
      db.transaction(async (tx) => {
        if (role) await tx.exec(`set local role ${role}`);
        return fn(tx as unknown as SqlClient);
      }),
  };
}
