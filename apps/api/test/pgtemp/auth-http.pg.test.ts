import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineAuthHttpSuite } from '../helpers/auth-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';

/**
 * Suite HTTP de /auth contra PostgreSQL 18 REAL desechable, con la API conectada como `eta15_api` y SOLO los privilegios
 * efectivos de la propuesta de roles (incluida la lectura exclusiva de role_permissions). Las pruebas de concurrencia
 * (inicios simultaneos, re-hash concurrente) usan varias conexiones reales del pool.
 * No toca el eta15_dev real ni crea usuarios fuera del clúster temporal. Ejecutar con:  pnpm test:pg-temp
 */
let cluster: ApiCluster;

// El clúster vive durante TODO el archivo (la suite HTTP y las pruebas de escalamiento posteriores lo comparten).
beforeAll(async () => {
  cluster = await startApiCluster();
}, 240_000);
afterAll(async () => {
  await cluster?.stop();
}, 60_000);

defineAuthHttpSuite('PostgreSQL desechable, eta15_api', async () => ({
  harness: {
    store: createPgSessionStore(cluster.pool),
    owner: async (sql, params) =>
      (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
  },
  teardown: async () => undefined,
}));
/**
 * Con MFA diferido, la excepcion es de la APLICACION (configuracion), no de los datos: la propia API, aunque estuviera
 * comprometida, no puede apagar el MFA de un rol ni concederse roles privilegiados en la base.
 */
describe('la API (eta15_api) no puede reconfigurar MFA ni autoescalarse en PostgreSQL', () => {
  const denied = async (sql: string, params: unknown[] = []) => {
    const c = await cluster.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql, params);
      return 'PERMITIDO';
    } catch (e) {
      return (e as { code?: string }).code;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };

  it('no puede cambiar roles.requires_mfa ni la politica de sesion de los roles (42501)', async () => {
    expect(await denied(`update roles set requires_mfa = false where key = 'direccion'`)).toBe(
      '42501',
    );
    expect(
      await denied(`update roles set session_idle_minutes = 600 where key = 'admin_tecnico'`),
    ).toBe('42501');
    expect(
      await denied(`insert into roles (key, name, domain) values ('rol_nuevo', 'x', 'school')`),
    ).toBe('42501');
  });

  it('el valor sembrado de requires_mfa sigue en true para direccion y admin_tecnico (la excepcion no toca los datos)', async () => {
    const r = await cluster.owner.query<{ key: string; requires_mfa: boolean }>(
      `select key, requires_mfa from roles where key in ('direccion','admin_tecnico') order by key`,
    );
    expect(r.rows).toEqual([
      { key: 'admin_tecnico', requires_mfa: true },
      { key: 'direccion', requires_mfa: true },
    ]);
  });

  it('no puede concederse roles privilegiados ni usar bootstrap/recovery (los rechaza la base)', async () => {
    const u = await cluster.owner.query<{ id: string }>(
      `insert into users (email, display_name, account_domain, status, password_hash)
       values ('autoescala@escuela.mx','Persona de prueba','school','active','hash-ficticio') returning id`,
    );
    const id = u.rows[0]!.id;
    for (const [source, ref] of [
      ['grant', null],
      ['bootstrap', 'ACTA-X'],
      ['recovery', 'ACTA-X'],
    ] as const) {
      const code = await denied(
        `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
         select $1, r.id, r.domain, $1, $2, $3 from roles r where r.key = 'direccion'`,
        [id, source, ref],
      );
      expect(code, source).not.toBe('PERMITIDO');
    }
    const n = await cluster.owner.query<{ n: number }>(
      `select count(*)::int n from user_roles where user_id = $1`,
      [id],
    );
    expect(n.rows[0]!.n).toBe(0);
  });
});
