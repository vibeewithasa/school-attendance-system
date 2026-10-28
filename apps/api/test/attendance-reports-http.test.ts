import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineAttendanceReportTests } from './helpers/attendance-reports-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP de los reportes basicos de asistencia (solo lectura) sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion NO
 * propietario y todas las migraciones. Datos ficticios y reloj escolar simulado. La consistencia de la foto con conexiones reales
 * se prueba en el clúster desechable (test/pgtemp/attendance-reports.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite reportes de asistencia',
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
  { onlyExtra: true, extra: (kit) => defineAttendanceReportTests(kit) },
);
