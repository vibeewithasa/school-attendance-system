import { defineAuthHttpSuite } from '../helpers/auth-http-suite.js';
import { startApiCluster } from '../helpers/api-cluster.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';

/**
 * Suite HTTP de /auth contra PostgreSQL 18 REAL desechable, con la API conectada como `eta15_api` y SOLO los privilegios
 * efectivos de la propuesta de roles (incluida la lectura exclusiva de role_permissions). Las pruebas de concurrencia
 * (inicios simultaneos, re-hash concurrente) usan varias conexiones reales del pool.
 * No toca el eta15_dev real ni crea usuarios fuera del clúster temporal. Ejecutar con:  pnpm test:pg-temp
 */
defineAuthHttpSuite('PostgreSQL desechable, eta15_api', async () => {
  const cluster = await startApiCluster();
  return {
    harness: {
      store: createPgSessionStore(cluster.pool),
      owner: async (sql, params) =>
        (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    },
    teardown: () => cluster.stop(),
  };
});
