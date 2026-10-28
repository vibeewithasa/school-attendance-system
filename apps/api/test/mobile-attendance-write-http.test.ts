import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { defineMobileAttendanceWriteTests } from './helpers/mobile-attendance-write-suite.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * HTTP de la ESCRITURA movil de asistencia en sandbox (ADR 0006, fase 2; propuesto) sobre PGlite con un rol de ejecucion NO
 * propietario y todas las migraciones. Cuentas, dispositivos, alumnos y listas FICTICIOS. La concurrencia REAL (varias conexiones,
 * caida de la base, rollback, reinicio) se prueba en el cluster desechable (test/pgtemp/mobile-attendance-write.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite escritura movil de asistencia',
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
  { onlyExtra: true, extra: (kit) => defineMobileAttendanceWriteTests(kit) },
);
