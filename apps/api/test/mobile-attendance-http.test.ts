import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineMobileAttendanceTests } from './helpers/mobile-attendance-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP de la LECTURA movil de asistencia (ADR 0006, propuesto) sobre PGlite con un rol de ejecucion NO propietario y todas las
 * migraciones. Cuentas, dispositivos, alumnos y listas FICTICIOS. La concurrencia REAL (varias conexiones) se prueba en el cluster
 * desechable (test/pgtemp/mobile-attendance.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite lectura movil de asistencia',
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
  { onlyExtra: true, extra: (kit) => defineMobileAttendanceTests(kit) },
);
