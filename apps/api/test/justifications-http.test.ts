import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineJustificationTests } from './helpers/justifications-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP del registro de RECEPCION de justificantes (Trabajo Social) sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion
 * NO propietario y todas las migraciones (0013 incluida). Datos ficticios y reloj escolar simulado. Los privilegios por columna y la
 * concurrencia REAL se prueban en el clúster desechable (test/pgtemp/justifications.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite justificantes',
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
  { onlyExtra: true, extra: (kit) => defineJustificationTests(kit) },
);
