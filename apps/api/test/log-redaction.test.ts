import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, redactQueryValues } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('registros: los valores de la consulta no se guardan', () => {
  it('conserva la ruta y los nombres de los parametros, y omite sus valores', () => {
    expect(redactQueryValues('/mobile/school/attendance/today')).toBe(
      '/mobile/school/attendance/today',
    );
    expect(redactQueryValues('/x?access_token=ABC123&groupId=g1')).toBe(
      '/x?access_token=[redacted]&groupId=[redacted]',
    );
    expect(redactQueryValues('/x?flag&k=v#frag')).toBe('/x?flag&k=[redacted]#frag');
    expect(redactQueryValues('/x?a=b=c')).toBe('/x?a=[redacted]');
  });
});

describe('registros HTTP reales: ningun valor sensible de la consulta llega al registro', () => {
  const lines: string[] = [];
  let app: FastifyInstance;
  const SECRETS = {
    access_token: 'MARCA-ficticia-a1',
    refresh_token: 'MARCA-ficticia-r2',
    code: 'MARCA-ficticia-c3',
    token: 'MARCA-ficticia-t4',
    password: 'MARCA-ficticia-p5',
  };
  const query = Object.entries(SECRETS)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  beforeAll(async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info' }), {
      logStream: { write: (c: string) => void lines.push(c) },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('una ruta existente (200), una inexistente (404) y una con metodo no permitido siguen respondiendo igual', async () => {
    const ok = await app.inject({ method: 'GET', url: `/health?${query}` });
    expect(ok.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: `/no-existe?${query}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    const post = await app.inject({ method: 'POST', url: `/health?${query}`, payload: {} });
    expect([403, 404, 405]).toContain(post.statusCode);
  });

  it('en los registros no aparece ninguno de los valores; si se conservan los nombres de los parametros y la ruta', () => {
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const value of Object.values(SECRETS)) expect(log.includes(value)).toBe(false);
    expect(log.includes('MARCA-ficticia')).toBe(false);
    for (const name of Object.keys(SECRETS)) expect(log.includes(`${name}=[redacted]`)).toBe(true);
    expect(log.includes('/health')).toBe(true);
    // el registro sigue siendo JSON por linea con el metodo y la IP de la conexion
    const first = JSON.parse(lines.find((l) => l.includes('"req"'))!) as {
      req: { method: string; url: string; remoteAddress: string };
    };
    expect(first.req.method).toBe('GET');
    expect(first.req.remoteAddress).toBeTruthy();
  });
});
