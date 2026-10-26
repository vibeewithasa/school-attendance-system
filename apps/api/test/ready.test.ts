import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDatabase, type Database } from '../src/db/client.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', READY_TIMEOUT_MS: '100' });

function fakeDb(ping: () => Promise<void>): Database & { close: ReturnType<typeof vi.fn> } {
  return { ping, close: vi.fn(async () => undefined) };
}

describe('GET /ready', () => {
  it('responde 200 ready cuando la base de datos responde', async () => {
    const app = await buildApp(env, { database: fakeDb(async () => undefined) });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('responde 503 not_ready sin filtrar detalles cuando falla la conexion', async () => {
    const leaky = new Error(
      'password authentication failed for user "eta15_app" host=127.0.0.1 SELECT secret_column',
    );
    const app = await buildApp(env, {
      database: fakeDb(async () => {
        throw leaky;
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
    for (const fragment of ['password', 'eta15_app', '127.0.0.1', 'SELECT', 'secret', 'stack']) {
      expect(res.body).not.toContain(fragment);
    }
    await app.close();
  });

  it('responde 503 si la consulta excede el timeout', async () => {
    const app = await buildApp(env, { database: fakeDb(() => new Promise(() => undefined)) });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(2000);
    await app.close();
  });

  it('responde 503 si no hay base de datos configurada', async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('/health sigue respondiendo ok aunque la base de datos falle', async () => {
    const app = await buildApp(env, {
      database: fakeDb(async () => {
        throw new Error('caida');
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    await app.close();
  });
});

describe('ciclo de vida de la base de datos', () => {
  it('app.close() cierra la base de datos una vez', async () => {
    const database = fakeDb(async () => undefined);
    const app = await buildApp(env, { database });
    await app.close();
    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it('createDatabase: close() cierra el pool y es idempotente', async () => {
    const handle = createDatabase(env);
    expect(handle.pool.ended).toBe(false);
    await handle.close();
    await handle.close();
    expect(handle.pool.ended).toBe(true);
  });

  it('createDatabase: ping rechaza rapido si el servidor no esta disponible (puerto 1, sin tocar PostgreSQL)', async () => {
    const handle = createDatabase(loadEnv({ DB_PORT: '1', DB_CONNECT_TIMEOUT_MS: '500' }));
    await expect(handle.ping()).rejects.toThrow();
    await handle.close();
  });
});

describe('configuracion', () => {
  it.each([
    ['DB_POOL_MAX', '0'],
    ['DB_PORT', '70000'],
    ['DB_CONNECT_TIMEOUT_MS', '5'],
    ['READY_TIMEOUT_MS', 'abc'],
  ])('rechaza %s=%s', (key, value) => {
    expect(() => loadEnv({ [key]: value })).toThrow(/Configuracion invalida/);
  });

  it('el mensaje de error no incluye el valor de la contrasena', () => {
    expect(() => loadEnv({ DB_PASSWORD: 'valor-secreto-123', DB_POOL_MAX: '0' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('valor-secreto-123') }),
    );
  });
});
