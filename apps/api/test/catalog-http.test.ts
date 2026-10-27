import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineCatalogTests } from './helpers/catalog-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/** HTTP del catalogo escolar sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion NO propietario. */
defineAdminHttpSuite(
  'PGlite catalogo',
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
  { onlyExtra: true, extra: (kit) => defineCatalogTests(kit, { privileges: 'full' }) },
);
