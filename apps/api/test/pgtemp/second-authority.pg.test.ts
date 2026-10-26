import { defineSecondAuthoritySuite } from '../helpers/second-authority-suite.js';
import { startApiCluster } from '../helpers/api-cluster.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';

/** Dispensa de segunda autoridad contra PostgreSQL desechable: propietario `eta15_app`, API `eta15_api` con sus privilegios reales. */
defineSecondAuthoritySuite('PostgreSQL desechable', async () => {
  const cluster = await startApiCluster();
  return {
    store: createPgSessionStore(cluster.pool),
    owner: {
      query: async (text: string, params?: unknown[]) =>
        (await cluster.owner.query(text, params)) as { rows: never[] },
    },
    q: async (sql, params) =>
      (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    teardown: () => cluster.stop(),
  };
});
