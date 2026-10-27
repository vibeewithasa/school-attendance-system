import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { definePrefectTests } from './helpers/prefect-suite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP de asignaciones de grupos a prefectura y del alcance assigned_groups sobre PGlite (PostgreSQL 18 en memoria) con un rol de
 * ejecucion NO propietario y todas las migraciones (0009 incluida). Datos ficticios. La concurrencia REAL y los privilegios por
 * columna se prueban en el clúster desechable (test/pgtemp/prefect.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite prefectura',
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
  { onlyExtra: true, extra: (kit) => definePrefectTests(kit, { mode: 'full' }) },
);
