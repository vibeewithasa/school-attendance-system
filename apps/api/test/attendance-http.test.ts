import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineAttendanceTests } from './helpers/attendance-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP de la asistencia diaria sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion NO propietario y todas las
 * migraciones (0010 incluida). Datos ficticios y reloj escolar simulado. La concurrencia REAL (varias conexiones) y los privilegios
 * por columna se prueban en el clúster desechable (test/pgtemp/attendance.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite asistencia',
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
  { onlyExtra: true, extra: (kit) => defineAttendanceTests(kit, { mode: 'full' }) },
);
