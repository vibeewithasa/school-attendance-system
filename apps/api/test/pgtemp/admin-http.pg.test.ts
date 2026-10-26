import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineActivationTests } from '../helpers/activation-suite.js';
import { defineAdminHttpSuite, type AdminKit } from '../helpers/admin-http-suite.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';

/**
 * Suite HTTP de /admin contra PostgreSQL 18 REAL desechable con la API como `eta15_api` y SOLO sus privilegios efectivos
 * (incluida la lectura exclusiva de role_permissions), mas pruebas de concurrencia con varias conexiones del pool.
 * No toca eta15_dev ni crea usuarios fuera del clúster temporal. Ejecutar con:  pnpm test:pg-temp
 */
let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster();
}, 240_000);
afterAll(async () => {
  await cluster?.stop();
}, 60_000);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

defineAdminHttpSuite(
  'PostgreSQL desechable, eta15_api',
  async () => ({
    harness: {
      store: createPgSessionStore(cluster.pool),
      owner: async (sql, params) =>
        (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
    },
    teardown: async () => undefined,
  }),
  {
    // Estas pruebas son destructivas para el estado de titulares: se ejecutan al FINAL de la suite.
    extra: (kit: AdminKit) => {
      // Primero la activacion (no destructiva para los titulares); despues la concurrencia que si lo es.
      defineActivationTests(kit);
      describe('concurrencia real de la administracion', () => {
        const holders = async (domain: string) =>
          Number(
            (
              await kit.harness.owner(
                `select count(*)::int n from user_roles ur join users u on u.id = ur.user_id and u.status = 'active'
                  where ur.domain = $1 and ur.revoked_at is null`,
                [domain],
              )
            ).rows[0]!.n,
          );

        it('10 asignaciones simultaneas del mismo rol: exactamente una se concreta (201) y el resto es 409', async () => {
          const me = await kit.login(kit.boss);
          const target = (
            await kit.call(me, 'POST', '/admin/users', {
              body: {
                email: 'carrera@escuela.mx',
                displayName: 'Carrera',
                accountDomain: 'school',
              },
            })
          ).json() as Json;
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              kit.call(me, 'POST', `/admin/users/${target.id}/roles`, {
                body: { roleKey: 'prefectura' },
              }),
            ),
          );
          const codes = results.map((r) => r.statusCode).sort();
          expect(codes.filter((c) => c === 201)).toHaveLength(1);
          expect(codes.filter((c) => c === 409)).toHaveLength(9);
          const n = await kit.harness.owner(
            `select count(*)::int n from user_roles where user_id = $1 and revoked_at is null`,
            [target.id],
          );
          expect(Number(n.rows[0]!.n)).toBe(1);
        });

        it('creaciones simultaneas con el mismo correo: una cuenta y 409 para las demas', async () => {
          const me = await kit.login(kit.boss);
          const body = { email: 'mismo@escuela.mx', displayName: 'Mismo', accountDomain: 'school' };
          const results = await Promise.all(
            Array.from({ length: 8 }, () => kit.call(me, 'POST', '/admin/users', { body })),
          );
          expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
          expect(results.filter((r) => r.statusCode === 409)).toHaveLength(7);
        });

        it('dos titulares que se revocan el rol mutuamente a la vez, y luego se deshabilitan mutuamente: nunca quedan 0', async () => {
          // Dominio tecnico normalizado: solo X e Y (el propietario revoca el resto, como una migracion/consola)
          const x = await kit.seed({ domain: 'technical', role: 'admin_tecnico' });
          const y = await kit.seed({ domain: 'technical', role: 'admin_tecnico' });
          await kit.harness.owner(
            `update user_roles set revoked_at = now(), revoked_by = $1
              where domain = 'technical' and revoked_at is null and user_id not in ($1, $2)`,
            [x.id, y.id],
          );
          expect(await holders('technical')).toBe(2);

          // 1) revocacion mutua simultanea
          const sx = await kit.login(x);
          const sy = await kit.login(y);
          const [rx, ry] = await Promise.all([
            kit.call(sx, 'DELETE', `/admin/users/${y.id}/roles/admin_tecnico`),
            kit.call(sy, 'DELETE', `/admin/users/${x.id}/roles/admin_tecnico`),
          ]);
          const codes = [rx.statusCode, ry.statusCode];
          expect(codes.filter((c) => c === 200)).toHaveLength(1);
          expect([401, 409]).toContain(codes.find((c) => c !== 200));
          expect(await holders('technical')).toBe(1);

          // 2) con un nuevo segundo titular concedido por el superviviente, deshabilitacion mutua simultanea
          const survivor = rx.statusCode === 200 ? x : y;
          const z = await kit.seed({ domain: 'technical', role: null });
          await kit.harness.owner(
            `insert into user_roles (user_id, role_id, domain, granted_by, grant_source)
             select $1, r.id, r.domain, $2, 'grant' from roles r where r.key = 'admin_tecnico'`,
            [z.id, survivor.id],
          );
          expect(await holders('technical')).toBe(2);
          const ss = await kit.login(survivor);
          const sz = await kit.login(z);
          const [r1, r2] = await Promise.all([
            kit.call(ss, 'POST', `/admin/users/${z.id}/disable`),
            kit.call(sz, 'POST', `/admin/users/${survivor.id}/disable`),
          ]);
          const codes2 = [r1.statusCode, r2.statusCode];
          expect(codes2.filter((c) => c === 200)).toHaveLength(1);
          expect([401, 409]).toContain(codes2.find((c) => c !== 200));
          expect(await holders('technical')).toBe(1);
        });
      });
    },
  },
);
