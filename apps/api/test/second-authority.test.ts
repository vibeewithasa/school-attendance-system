import { defineSecondAuthoritySuite } from './helpers/second-authority-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/** Dispensa de segunda autoridad sobre PGlite: el propietario es la conexion; la API es el rol `api_runtime`. */
defineSecondAuthoritySuite('PGlite', async () => {
  const db = await freshDb();
  await createApiRole(db);
  const owner = {
    query: async (text: string, params?: unknown[]) =>
      (await db.query(text, params)) as { rows: never[] },
  };
  return {
    store: pgliteStore(db, 'api_runtime'),
    owner,
    q: async (sql, params) =>
      (await db.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    teardown: () => db.close(),
  };
});
