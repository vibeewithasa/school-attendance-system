import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { FakeDevice } from '../helpers/fake-device.js';
import { defineMobileTests } from '../helpers/mobile-suite.js';

/**
 * Autenticacion movil AISLADA contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria):
 *  - CON la propuesta 0006 (acceso por columna): suite HTTP completa, matriz de privilegios y carreras REALES (varias conexiones).
 *  - SIN ella (estado de eta15_dev si se aplicara 0011 y no 0006): 503 controlado y nada cambia.
 * Siempre con 0002 a 0005 aplicadas (como eta15_dev). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

function suite(label: string, mode: 'full' | 'unavailable') {
  let cluster: ApiCluster;
  beforeAll(async () => {
    cluster = await startApiCluster(20, {
      catalogWrite: true,
      studentsWrite: true,
      prefectWrite: true,
      attendanceWrite: true,
      mobileWrite: mode === 'full',
    });
    clusters.push(cluster);
  }, 240_000);

  defineAdminHttpSuite(
    label,
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
      extra: (kit) => {
        const api = (sql: string, params: unknown[] = []) => cluster.pool.query(sql, params);
        const owner = async (sql: string, params: unknown[] = []) =>
          (await cluster.owner.query(sql, params)).rows;
        const verify = () =>
          cluster.owner.query(privilegeFile('0006-mobile-auth-write.verify.sql'));

        if (mode === 'unavailable') {
          describe(`${label}: 0011 aplicada y 0006 todavia no`, () => {
            it('la API no ve ni escribe las tablas moviles y el verificador lo senala', async () => {
              for (const sql of [
                'select count(*) from mobile_device_requests',
                'select id from mobile_devices',
                'select access_hash from mobile_sessions',
                "update mobile_sessions set revoked_reason = 'logout' where false",
                "select mobile_user_eligible('00000000-0000-0000-0000-000000000000')",
              ])
                await expect(api(sql)).rejects.toMatchObject({ code: '42501' });
              await expect(verify()).rejects.toThrow(
                /Privilegios efectivos de eta15_api inesperados/,
              );
            });

            it('el modulo responde 503 controlado y no escribe nada', async () => {
              const app = await kit.build({}, { mobile: { publicBaseUrl: 'http://mobile.test' } });
              await app.ready();
              const dev = new FakeDevice();
              const r = await app.inject({
                method: 'POST',
                url: '/mobile/enroll/requests',
                payload: { publicKey: dev.jwk, label: 'Sin privilegios', platform: 'android' },
              });
              expect(r.statusCode).toBe(503);
              expect(r.json().error.code).toBe('MOBILE_AUTH_UNAVAILABLE');
              expect(r.body).not.toMatch(/permission denied|mobile_device_requests/i);
              expect(
                (await owner('select count(*)::int as n from mobile_device_requests'))[0]!.n,
              ).toBe(0);
              await app.close();
            });
          });
          return;
        }

        defineMobileTests(kit);

        describe(`${label}: privilegios y carreras reales de eta15_api`, () => {
          const denied = (sql: string) => expect(api(sql)).rejects.toMatchObject({ code: '42501' });

          it('el verificador oficial aprueba el estado con 0006 y la API NO puede borrar, truncar ni tocar RBAC', async () => {
            await verify();
            for (const sql of [
              'delete from mobile_sessions',
              'delete from mobile_devices',
              'delete from mobile_device_requests',
              'truncate mobile_sessions',
              'truncate mobile_device_requests cascade',
              'delete from mobile_proof_jtis',
              'delete from mobile_nonces',
              'truncate mobile_proof_jtis',
              'truncate mobile_nonces',
              "update role_permissions set scope = 'all' where false",
              "insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where p.key = 'mobile_devices:manage' and r.key = 'prefectura'",
            ])
              await denied(sql);
          });

          it('la API no puede cambiar la identidad ni las horas (columnas sin UPDATE) aunque la fila exista', async () => {
            for (const sql of [
              "update mobile_device_requests set key_thumbprint = 'x' where false",
              "update mobile_device_requests set public_key_jwk = '{}' where false",
              "update mobile_device_requests set pairing_code_hash = decode(repeat('00', 32), 'hex') where false",
              'update mobile_device_requests set expires_at = now() where false',
              'update mobile_device_requests set approved_at = now() where false',
              "update mobile_devices set public_key_jwk = '{}' where false",
              "update mobile_devices set label = 'otra' where false",
              'update mobile_devices set registered_at = now() where false',
              'update mobile_devices set revoked_at = null where false',
              'update mobile_sessions set absolute_expires_at = now() where false',
              'update mobile_sessions set revoked_at = null where false',
              'update mobile_sessions set device_id = device_id where false',
              // estado efimero: las pruebas aceptadas son solo-agregar y de los nonces solo se puede gastar consumed_at
              'update mobile_proof_jtis set expires_at = now() where false',
              'update mobile_proof_jtis set jti_hash = jti_hash where false',
              'update mobile_nonces set expires_at = now() where false',
              'update mobile_nonces set key_thumbprint = key_thumbprint where false',
              'update mobile_nonces set nonce_hash = nonce_hash where false',
              // y solo lee lo necesario: ni el hash del jti ni la hora de emision
              'select jti_hash from mobile_proof_jtis',
              'select seen_at from mobile_proof_jtis',
              'select issued_at from mobile_nonces',
            ])
              await denied(sql);
          });

          it('estado efimero: la API inserta y gasta, el propietario limpia SOLO lo vencido hace mas de una hora, y la API no puede', async () => {
            const k = new FakeDevice().thumbprint;
            const h = (c: string) => `decode(repeat('${c}', 32), 'hex')`;
            await api(
              `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at) values ($1, ${h('01')}, now(), now() + interval '2 minutes')`,
              [k],
            );
            await expect(
              api(
                `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at) values ($1, ${h('01')}, now(), now() + interval '2 minutes')`,
                [k],
              ),
            ).rejects.toMatchObject({ code: '23505' }); // la repeticion la rechaza la base
            await api(
              `insert into mobile_nonces (nonce_hash, key_thumbprint, issued_at, expires_at) values (${h('02')}, $1, now(), now() + interval '2 minutes')`,
              [k],
            );
            const spend = () =>
              api(
                `update mobile_nonces set consumed_at = now() where nonce_hash = ${h('02')} and key_thumbprint = $1 and consumed_at is null and expires_at > now() returning 1`,
                [k],
              );
            expect((await spend()).rows).toHaveLength(1);
            expect((await spend()).rows).toHaveLength(0); // un solo uso
            // limpieza del PROPIETARIO: solo vencido hace mas de una hora; lo vigente sobrevive
            await owner(
              `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at) values ($1, ${h('03')}, now() - interval '3 hours', now() - interval '178 minutes')`,
              [k],
            );
            await owner(
              `delete from mobile_proof_jtis where expires_at < now() - interval '1 hour'`,
            );
            const left = await owner(
              `select count(*)::int as n from mobile_proof_jtis where key_thumbprint = $1`,
              [k],
            );
            expect(left[0]!.n).toBe(1);
            await expect(
              owner(`delete from mobile_proof_jtis where key_thumbprint = $1`, [k]),
            ).rejects.toMatchObject({ code: '42501' });
          });

          it('FALLA REAL de PostgreSQL durante la admision anti-replay: la peticion se rechaza (503) y se recupera al restablecer el privilegio', async () => {
            const target = await kit.build({}, { mobile: { publicBaseUrl: 'http://mobile.test' } });
            await target.ready();
            const dev = new FakeDevice();
            const enrollRes = await target.inject({
              method: 'POST',
              url: '/mobile/enroll/requests',
              payload: { publicKey: dev.jwk, label: 'Falla real', platform: 'android' },
            });
            expect(enrollRes.statusCode, enrollRes.body).toBe(201);
            const challenge = () =>
              target.inject({
                method: 'POST',
                url: '/mobile/auth/challenge',
                payload: { keyThumbprint: dev.thumbprint },
                headers: {
                  dpop: dev.proof({
                    method: 'POST',
                    url: 'http://mobile.test/mobile/auth/challenge',
                  }),
                },
              });
            expect((await challenge()).statusCode).toBe(200);
            const jtiGrant =
              'grant insert (key_thumbprint, jti_hash, seen_at, expires_at) on mobile_proof_jtis to eta15_api';
            await owner(
              'revoke insert (key_thumbprint, jti_hash, seen_at, expires_at) on mobile_proof_jtis from eta15_api',
            );
            try {
              const down = await challenge();
              expect([down.statusCode, down.json().error.code]).toEqual([
                503,
                'MOBILE_AUTH_UNAVAILABLE',
              ]);
              expect(down.body).not.toMatch(/permission denied|mobile_proof_jtis|42501/i);
            } finally {
              await owner(jtiGrant);
            }
            await verify(); // el estado de privilegios vuelve a ser EXACTAMENTE el aprobado
            expect((await challenge()).statusCode).toBe(200);
            await target.close();
          });

          it('la API no ejecuta las funciones de trigger y PUBLIC no tiene EXECUTE', async () => {
            for (const fn of [
              'mdr_guard_update()',
              'md_guard_update()',
              'ms_guard_update()',
              'mobile_auth_no_delete()',
              'mobile_ephemeral_guard_delete()',
              'mobile_proof_guard_update()',
              'mn_guard_update()',
            ]) {
              const [r] = await owner(
                `select has_function_privilege('eta15_api', 'public.${fn}'::regprocedure, 'EXECUTE') as a,
                        has_function_privilege('public', 'public.${fn}'::regprocedure, 'EXECUTE') as p`,
              );
              expect(r, fn).toEqual({ a: false, p: false });
            }
          });

          it('CARRERA: revocar el dispositivo y abrir una sesion a la vez nunca deja una sesion activa en un dispositivo revocado', async () => {
            const pref = await kit.seed({ role: 'prefectura' });
            const outcomes: string[] = [];
            for (let i = 0; i < 16; i += 1) {
              const dev = new FakeDevice();
              const req = (
                await owner(
                  `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
                   values ($1, $2::jsonb, 'Carrera', decode(repeat('ab', 32), 'hex'), now() + interval '10 minutes') returning id`,
                  [dev.thumbprint, JSON.stringify(dev.jwk)],
                )
              )[0]!.id as string;
              await owner(
                `update mobile_device_requests set status = 'claimed', user_id = $2 where id = $1`,
                [req, pref.id],
              );
              await owner(
                `update mobile_device_requests set status = 'approved', approved_by = $2 where id = $1`,
                [req, kit.boss.id],
              );
              const deviceId = (
                await owner(
                  `insert into mobile_devices (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by)
                   values ($1, $2, $3::jsonb, 'Carrera', $4, $5) returning id`,
                  [pref.id, dev.thumbprint, JSON.stringify(dev.jwk), req, kit.boss.id],
                )
              )[0]!.id as string;
              await owner(`update mobile_device_requests set status = 'activated' where id = $1`, [
                req,
              ]);

              const openSession = () =>
                api(
                  `insert into mobile_sessions (device_id, user_id, access_hash, refresh_hash, created_at, access_expires_at, idle_expires_at, absolute_expires_at)
                   values ($1, $2, decode(md5(random()::text) || md5(random()::text), 'hex'), decode(md5(random()::text) || md5(random()::text), 'hex'),
                           now(), now() + interval '5 minutes', now() + interval '1 hour', now() + interval '8 hours')`,
                  [deviceId, pref.id],
                ).then(
                  () => 'sesion',
                  (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`,
                );
              const revoke = async () => {
                const c = await cluster.pool.connect();
                try {
                  await c.query('begin');
                  await c.query(
                    `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where id = $1`,
                    [deviceId, kit.boss.id],
                  );
                  await c.query(
                    `update mobile_sessions set revoked_reason = 'device_revoked', revoked_by = $2 where device_id = $1 and revoked_at is null`,
                    [deviceId, kit.boss.id],
                  );
                  await c.query('commit');
                  return 'revocado';
                } catch (e) {
                  await c.query('rollback').catch(() => undefined);
                  return `error:${(e as { code?: string }).code}`;
                } finally {
                  c.release();
                }
              };
              const jitter = (ms: number) => new Promise((r) => setTimeout(r, ms));
              const [a, b] = await Promise.all([
                jitter(i % 4).then(openSession),
                jitter((i + 2) % 4).then(revoke),
              ]);
              outcomes.push(`${a}/${b}`);
              expect(b, `iteracion ${i}`).toBe('revocado');
              expect(['sesion', '23514:ms_device_active'], `iteracion ${i}: ${a}`).toContain(a);
              const active = await owner(
                `select count(*)::int as n from mobile_sessions where device_id = $1 and revoked_at is null`,
                [deviceId],
              );
              expect(
                active[0]!.n,
                `iteracion ${i}: sesion activa en dispositivo revocado (${a}/${b})`,
              ).toBe(0);
            }
            expect(outcomes.length).toBe(16);
          });

          it('CARRERA: aprobar y cancelar la misma solicitud a la vez deja un estado coherente y nunca permite registrar un dispositivo despues', async () => {
            const pref = await kit.seed({ role: 'prefectura' });
            for (let i = 0; i < 12; i += 1) {
              const dev = new FakeDevice();
              const req = (
                await owner(
                  `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
                   values ($1, $2::jsonb, 'Carrera', decode(repeat('cd', 32), 'hex'), now() + interval '10 minutes') returning id`,
                  [dev.thumbprint, JSON.stringify(dev.jwk)],
                )
              )[0]!.id as string;
              await owner(
                `update mobile_device_requests set status = 'claimed', user_id = $2 where id = $1`,
                [req, pref.id],
              );
              const settle = (p: Promise<unknown>) =>
                p.then(
                  () => 'ok',
                  (e: { code?: string }) => `err:${e.code}`,
                );
              const [approve, cancel] = await Promise.all([
                settle(
                  api(
                    `update mobile_device_requests set status = 'approved', approved_by = $2 where id = $1`,
                    [req, kit.boss.id],
                  ),
                ),
                settle(
                  api(
                    `update mobile_device_requests set status = 'cancelled', closed_by = $2 where id = $1`,
                    [req, pref.id],
                  ),
                ),
              ]);
              const final = (
                await owner(`select status from mobile_device_requests where id = $1`, [req])
              )[0]!.status;
              // Siempre termina cancelada: o se cancelo desde 'claimed', o desde 'approved'; una aprobacion tardia sobre una cancelada es 42501.
              expect(final, `${approve}/${cancel}`).toBe('cancelled');
              expect(cancel).toBe('ok');
              expect(['ok', 'err:42501']).toContain(approve);
              await expect(
                api(
                  `insert into mobile_devices (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by)
                   values ($1, $2, $3::jsonb, 'Carrera', $4, $5)`,
                  [pref.id, dev.thumbprint, JSON.stringify(dev.jwk), req, kit.boss.id],
                ),
              ).rejects.toMatchObject({ code: '23514', constraint: 'md_from_approved_request' });
            }
          });
        });
      },
    },
  );
}

suite('PG real autenticacion movil (con 0006)', 'full');
suite('PG real autenticacion movil (0011 sin 0006)', 'unavailable');
