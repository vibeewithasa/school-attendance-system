import { afterAll, beforeAll } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineMobileAttendanceWriteTests } from '../helpers/mobile-attendance-write-suite.js';

/**
 * ESCRITURA movil de asistencia en sandbox (ADR 0006, fase 2; propuesto) contra PostgreSQL 18 DESECHABLE con la API como
 * `eta15_api` (no propietaria) y las propuestas 0002 a 0006 aplicadas SOLO en ese cluster: suite HTTP completa y concurrencia REAL
 * (varias conexiones, caida de la base, rollback, reinicio de la API). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster(40, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
    mobileWrite: true,
  });
  clusters.push(cluster);
}, 240_000);

defineAdminHttpSuite(
  'PG desechable escritura movil de asistencia',
  async () => ({
    harness: {
      store: createPgSessionStore(cluster.pool),
      owner: async (sql, params) =>
        (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    },
    teardown: async () => undefined,
  }),
  {
    onlyExtra: true,
    extra: (kit) => defineMobileAttendanceWriteTests(kit, { realConcurrency: true }),
  },
);
