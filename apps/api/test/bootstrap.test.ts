import { defineBootstrapSuite } from './helpers/bootstrap-suite.js';
import { freshDb } from './helpers/pglite.js';

/** Bootstrap sobre PGlite (PostgreSQL 18 en memoria): el propietario es el rol de la conexion. */
defineBootstrapSuite('PGlite', async () => {
  const db = await freshDb();
  const client = {
    query: async (text: string, params?: unknown[]) =>
      (await db.query(text, params)) as { rows: never[] },
  };
  return {
    h: {
      owner: async () => client,
      q: async (sql, params) =>
        (await db.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    },
    teardown: () => db.close(),
  };
});
