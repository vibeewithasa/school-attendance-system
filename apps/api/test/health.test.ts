import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('API base', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /health responde ok sin tocar la base de datos', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('eta15-api');
    expect(body).not.toHaveProperty('database');
  });

  it('ruta inexistente devuelve el formato de error comun', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('loadEnv', () => {
  it('aplica valores por defecto', () => {
    expect(loadEnv({}).PORT).toBe(3000);
  });
  it('rechaza un puerto invalido', () => {
    expect(() => loadEnv({ PORT: '99999' })).toThrow(/Configuracion invalida/);
  });
});
