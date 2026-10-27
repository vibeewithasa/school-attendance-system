import { defineAdminHttpSuite } from './helpers/admin-http-suite.js';
import { createApiRole } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';
import { defineStudentsTests } from './helpers/students-suite.js';

/**
 * HTTP de alumnos, matriculas e historial de grupo sobre PGlite (PostgreSQL 18 en memoria) con un rol de ejecucion NO propietario
 * y con la migracion RBAC 0008 aplicada (politica cerrada por defecto). Datos ficticios. La concurrencia REAL (varias
 * conexiones) y los privilegios por columna se prueban en el clúster desechable (test/pgtemp/students.pg.test.ts).
 */
defineAdminHttpSuite(
  'PGlite alumnos',
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
  { onlyExtra: true, extra: (kit) => defineStudentsTests(kit, { mode: 'full' }) },
);
