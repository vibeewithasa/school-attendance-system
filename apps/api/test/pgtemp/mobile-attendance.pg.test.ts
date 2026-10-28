import { afterAll, beforeAll } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineMobileAttendanceTests } from '../helpers/mobile-attendance-suite.js';

/**
 * LECTURA movil de asistencia (ADR 0006, propuesto) contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria),
 * con las propuestas de privilegios 0002 a 0006 (como el sandbox): suite HTTP completa y lecturas consistentes con conexiones
 * REALES mientras otra prefecta guarda o finaliza. No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster(30, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
    mobileWrite: true,
  });
  clusters.push(cluster);
}, 240_000);

defineAdminHttpSuite(
  'PG desechable lectura movil de asistencia',
  async () => ({
    harness: {
      store: createPgSessionStore(cluster.pool),
      owner: async (sql, params) =>
        (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    },
    teardown: async () => undefined,
  }),
  { onlyExtra: true, extra: (kit) => defineMobileAttendanceTests(kit, { realConcurrency: true }) },
);
