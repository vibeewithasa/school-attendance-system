import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { lastDow } from '../helpers/attendance-suite.js';
import { defineJustificationTests } from '../helpers/justifications-suite.js';
import { addDays, todayIso } from '../helpers/students-suite.js';

/**
 * Recepcion de justificantes contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria):
 *  - CON la propuesta 0007 (acceso por columna): suite HTTP completa, matriz de privilegios y concurrencia REAL (varias conexiones).
 *  - SIN ella (estado de eta15_dev tras 0013 y antes de 0007): 503 controlado y nada cambia.
 * Siempre con 0002 a 0005 aplicadas (como eta15_dev). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

function suite(label: string, withGrants: boolean) {
  let cluster: ApiCluster;
  beforeAll(async () => {
    cluster = await startApiCluster(20, {
      catalogWrite: true,
      studentsWrite: true,
      prefectWrite: true,
      attendanceWrite: true,
      justificationsWrite: withGrants,
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

        if (!withGrants) {
          describe(`${label}: modulo no habilitado (sin propuesta 0007)`, () => {
            it('estado de eta15_dev antes de 0007: la API no ve la tabla y el modulo responde 503 sin cambiar nada', async () => {
              await expect(api('select id from justification_receipts')).rejects.toMatchObject({
                code: '42501',
              });
              const app = await kit.build({}, { schoolToday: () => addDays(lastDow(3, 10), 0) });
              const ts = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
              const list = await kit.call(ts, 'GET', '/school/justifications/receipts', {
                target: app,
              });
              expect([list.statusCode, list.json().error.code]).toEqual([
                503,
                'JUSTIFICATIONS_UNAVAILABLE',
              ]);
              const r = await kit.call(ts, 'POST', '/school/justifications/receipts', {
                body: {
                  requestId: '00000000-0000-4000-8000-000000000abc',
                  studentId: '00000000-0000-4000-8000-000000000001',
                  schoolDate: lastDow(3, 10),
                },
                target: app,
              });
              expect([r.statusCode, r.json().error.code]).toEqual([
                503,
                'JUSTIFICATIONS_UNAVAILABLE',
              ]);
              expect(r.body).not.toMatch(/permission denied|justification_receipts/);
              expect(
                Number((await owner('select count(*)::int n from justification_receipts'))[0]!.n),
              ).toBe(0);
            });
          });
          return;
        }

        defineJustificationTests(kit);

        describe(`${label}: privilegios y concurrencia reales de eta15_api`, () => {
          const denied = (sql: string) => expect(api(sql)).rejects.toMatchObject({ code: '42501' });

          it('eta15_api solo lee e inserta las columnas aprobadas: no actualiza, borra, vacia ni fija folio, hora o estado', async () => {
            for (const sql of [
              `update justification_receipts set school_date = school_date where false`,
              `delete from justification_receipts where false`,
              `truncate justification_receipts`,
              `insert into justification_receipts (received_at, student_id, school_year_id, school_date, received_by, request_id, payload_hash) values (now(), gen_random_uuid(), gen_random_uuid(), '2026-01-05', gen_random_uuid(), gen_random_uuid(), '${'a'.repeat(64)}')`,
              `insert into justification_receipts (folio, student_id, school_year_id, school_date, received_by, request_id, payload_hash) values ('JR-000001', gen_random_uuid(), gen_random_uuid(), '2026-01-05', gen_random_uuid(), gen_random_uuid(), '${'a'.repeat(64)}')`,
              `insert into justification_receipts (status, student_id, school_year_id, school_date, received_by, request_id, payload_hash) values ('received', gen_random_uuid(), gen_random_uuid(), '2026-01-05', gen_random_uuid(), gen_random_uuid(), '${'a'.repeat(64)}')`,
              `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope) select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = 'prefectura' and p.key = 'justifications:create'`,
            ])
              await denied(sql);
            const n = await api(`select count(*)::int n from justification_receipts`);
            expect(typeof n.rows[0].n).toBe('number');
          });

          it('el permiso justifications:create esta asignado SOLO a trabajo social y la prefectura no lo recibe', async () => {
            const rows = await owner(
              `select r.key role, rp.scope from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'justifications:create'`,
            );
            expect(rows).toEqual([{ role: 'trabajo_social', scope: 'all' }]);
          });

          it('concurrencia REAL: veinte envios simultaneos con la misma clave crean un solo registro; con claves distintas, folios unicos', async () => {
            const year = (
              await owner(
                `insert into school_years (name, starts_on, ends_on) values ('Ciclo carrera recepcion', $1, $2) returning id`,
                [addDays(lastDow(3, 3000), -100), addDays(lastDow(3, 3000), 100)],
              )
            )[0]!.id as string;
            const students: string[] = [];
            for (let i = 0; i < 5; i += 1) {
              const st = (
                await owner(
                  `insert into students (given_names, family_name) values ($1, 'Ficticia') returning id`,
                  [`Carrera${'abcde'[i]}`],
                )
              )[0]!.id as string;
              await owner(
                `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3)`,
                [st, year, addDays(lastDow(3, 3000), -60)],
              );
              students.push(st);
            }
            const day = lastDow(3, 3000);
            const app = await kit.build({}, { schoolToday: () => todayIso() });
            const ts = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
            const send = (rid: string, st: string) =>
              kit.call(ts, 'POST', '/school/justifications/receipts', {
                body: { requestId: rid, studentId: st, schoolDate: day },
                target: app,
              });
            const same = await Promise.all(
              Array.from({ length: 20 }, () =>
                send('00000000-0000-4000-8000-0000000000c1', students[0]!),
              ),
            );
            expect(same.filter((r) => r.statusCode === 201)).toHaveLength(1);
            expect(same.filter((r) => r.statusCode === 200)).toHaveLength(19);
            expect(new Set(same.map((r) => r.json().receipt.id)).size).toBe(1);
            const many = await Promise.all(
              Array.from({ length: 20 }, (_v, i) =>
                send(
                  `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
                  students[i % 5]!,
                ),
              ),
            );
            expect(many.every((r) => r.statusCode === 201)).toBe(true);
            const folios = many.map((r) => r.json().receipt.folio as string);
            expect(new Set(folios).size).toBe(20);
            const total = Number(
              (
                await owner(
                  `select count(*)::int n from justification_receipts where school_date = $1`,
                  [day],
                )
              )[0]!.n,
            );
            expect(total).toBe(21);
          });
        });
      },
    },
  );
}

suite('PG desechable justificantes (con 0007)', true);
suite('PG desechable justificantes (sin 0007)', false);
