import { afterAll, beforeAll } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineFollowupTests } from '../helpers/attendance-followup-suite.js';

/**
 * Seguimiento de ausencias registradas contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria, con las propuestas
 * 0002 a 0005 y 0007 como en un eta15_dev futuro): ausencias repetidas, baja y traslado, consistencia de los cortes, acceso de Trabajo
 * Social y que registrar justificantes no cambia ningun conteo. La consistencia de lectura con conexiones simultaneas ya la prueban
 * `attendance-reports.pg.test.ts` (misma consulta). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster(10, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
    justificationsWrite: true,
  });
}, 240_000);
afterAll(async () => {
  await cluster?.stop();
}, 60_000);

defineAdminHttpSuite(
  'PG desechable seguimiento de ausencias',
  async () => ({
    harness: {
      store: createPgSessionStore(cluster.pool),
      owner: async (sql, params) =>
        (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    },
    teardown: async () => undefined,
  }),
  { onlyExtra: true, extra: (kit) => defineFollowupTests(kit) },
);
