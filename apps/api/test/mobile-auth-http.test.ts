import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineMobileTests } from './helpers/mobile-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP de la autenticacion movil aislada (prototipo de sandbox) sobre PGlite con un rol de ejecucion NO propietario y todas las
 * migraciones (0011 incluida). Cuentas, dispositivos y datos FICTICIOS. La concurrencia REAL (varias conexiones) y los privilegios
 * por columna se prueban en el clúster desechable (test/pgtemp/mobile-auth.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite autenticacion movil',
  async () => {
    const db = await freshDb();
    await createApiRole(db);
    return {
      harness: {
        store: pgliteStore(db, 'api_runtime'),
        owner: async (sql, params) =>
          (await db.query(sql, params)) as { rows: Array<Record<string, unknown>> },
      },
      teardown: () => db.close(),
    };
  },
  { onlyExtra: true, extra: (kit) => defineMobileTests(kit) },
);
