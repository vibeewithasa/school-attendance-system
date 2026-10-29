import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineFollowupTests } from './helpers/attendance-followup-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * Seguimiento de ausencias registradas: lo que la pantalla necesita del reporte por grupo existente, sobre PGlite (PostgreSQL 18 en
 * memoria) con un rol de ejecucion NO propietario y todas las migraciones. Datos ficticios y reloj escolar simulado.
 */
defineAdminHttpSuite(
  'PGlite seguimiento de ausencias',
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
  { onlyExtra: true, extra: (kit) => defineFollowupTests(kit) },
);
