import { describe } from 'vitest';
import { defineAuthHttpSuite } from './helpers/auth-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/** Suite HTTP de /auth sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion NO propietario. */
void describe;
defineAuthHttpSuite('PGlite', async () => {
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
