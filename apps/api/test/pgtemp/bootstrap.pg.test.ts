import { afterAll, beforeAll } from 'vitest';
import { defineBootstrapSuite } from '../helpers/bootstrap-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';

/**
 * Bootstrap contra PostgreSQL 18 REAL desechable: el propietario es `eta15_app` y la API (`eta15_api`) no puede ejecutarlo.
 * La carrera usa dos conexiones reales independientes del propietario. Nunca se ejecuta contra eta15_dev.
 */
let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster();
}, 240_000);
afterAll(async () => {
  await cluster?.stop();
}, 60_000);

defineBootstrapSuite('PostgreSQL desechable, eta15_app', async () => ({
  h: {
    concurrent: true,
    owner: async () => {
      const c = await cluster.pgt.connect('eta15_app', 'eta15_dev'); // conexion nueva e independiente
      return { query: async (text, params) => (await c.query(text, params)) as { rows: never[] } };
    },
    api: async () => ({
      query: async (text, params) => (await cluster.pool.query(text, params)) as { rows: never[] },
    }),
    q: async (sql, params) =>
      (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
  },
  teardown: async () => undefined,
}));
