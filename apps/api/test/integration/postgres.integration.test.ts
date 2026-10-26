import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';

/**
 * Integracion REAL con PostgreSQL local (eta15_dev). Solo lectura: no crea tablas ni migra.
 * Requiere apps/api/.env con DB_PASSWORD. Si falta, la prueba FALLA (no se omite en silencio).
 * Ejecutar con:  pnpm test:integration
 */
describe('PostgreSQL local (integracion)', () => {
  const env = loadEnv();
  let handle: DatabaseHandle;

  beforeAll(() => {
    if (!env.DB_PASSWORD) {
      throw new Error(
        'Falta DB_PASSWORD. Define la contrasena de eta15_app en apps/api/.env (ignorado por Git) antes de ejecutar las pruebas de integracion.',
      );
    }
    handle = createDatabase(env);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('ping() ejecuta SELECT 1 en el servidor real', async () => {
    await expect(handle.ping()).resolves.toBeUndefined();
  });

  it('se conecta como eta15_app a eta15_dev, sin privilegios administrativos', async () => {
    const result = await handle.db.execute<{
      usuario: string;
      base: string;
      superuser: boolean;
    }>(sql`
      select current_user as usuario, current_database() as base,
             (select rolsuper from pg_roles where rolname = current_user) as superuser
    `);
    const row = result.rows[0];
    expect(row).toEqual({ usuario: 'eta15_app', base: 'eta15_dev', superuser: false });
  });

  it('GET /ready responde 200 con la base de datos real', async () => {
    const app = await buildApp(env, { database: createDatabase(env) });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close(); // cierra el pool de este app
  });

  it('close() termina el pool real', async () => {
    const own = createDatabase(env);
    await own.ping();
    await own.close();
    expect(own.pool.ended).toBe(true);
  });
});
