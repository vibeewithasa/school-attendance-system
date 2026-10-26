import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/** Suite HTTP de /admin sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion NO propietario. */
defineAdminHttpSuite('PGlite', async () => {
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
});
