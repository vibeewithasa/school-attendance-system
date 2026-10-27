import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineAttendanceTests, lastDow } from '../helpers/attendance-suite.js';
import { addDays, todayIso } from '../helpers/students-suite.js';

/**
 * Asistencia diaria contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria):
 *  - CON la propuesta 0005 (acceso por columna): suite HTTP completa, matriz de privilegios y concurrencia REAL (varias conexiones).
 *  - SIN ella (estado de eta15_dev tras 0010 y antes de 0005): 503 controlado y nada cambia.
 * Siempre con 0002, 0003 y 0004 aplicadas (como eta15_dev). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
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
      attendanceWrite: mode === 'full',
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
        defineAttendanceTests(kit, { mode });

        describe(`${label}: privilegios y concurrencia reales de eta15_api`, () => {
          const api = (sql: string, params: unknown[] = []) => cluster.pool.query(sql, params);
          const denied = (sql: string) => expect(api(sql)).rejects.toMatchObject({ code: '42501' });
          const owner = async (sql: string, params: unknown[] = []) =>
            (await cluster.owner.query(sql, params)).rows;
          const verify = () =>
            cluster.owner.query(privilegeFile('0005-attendance-write.verify.sql'));

          if (mode === 'unavailable') {
            it('estado de eta15_dev antes de 0005: sin acceso a las tablas y el verificador lo senala', async () => {
              for (const sql of [
                'select count(*) from attendance_days',
                'select id from attendance_records',
                'select id from attendance_events',
                'update attendance_days set revision = revision where false',
              ])
                await denied(sql);
              await expect(verify()).rejects.toThrow(
                /Privilegios efectivos de eta15_api inesperados/,
              );
            });
            return;
          }

          // ---------------------------------------------------------------- fixtures propias (ciclo lejano en el pasado)
          const today = todayIso();
          const ids: Record<string, string> = {};
          const D = lastDow(3, 2900); // miercoles dentro del ciclo de fixtures
          const wait = () => new Promise((r) => setTimeout(r, 400));
          const settle = (p: Promise<unknown>) =>
            p.then(
              () => 'ok',
              (x: { code: string; constraint: string }) => `${x.code}:${x.constraint}`,
            );
          let seq = 0;
          const alpha = (k: number) =>
            [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
          async function newGroup(code: string) {
            return (
              await owner(
                `insert into groups (school_year_id, grade, code) values ($1, 3, $2) returning id`,
                [ids.year, code],
              )
            )[0]!.id as string;
          }
          async function newPupil(group: string) {
            seq += 1;
            const st = (
              await owner(
                `insert into students (given_names, family_name) values ($1, 'Pg') returning id`,
                [`Pupil${alpha(seq)}`],
              )
            )[0]!.id as string;
            const en = (
              await owner(
                `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
                [st, ids.year, ids.start],
              )
            )[0]!.id as string;
            const asg = (
              await owner(
                `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
                [en, ids.year, group, ids.start],
              )
            )[0]!.id as string;
            return { student: st, enrollment: en, assignment: asg };
          }
          type Pupil = Awaited<ReturnType<typeof newPupil>>;
          /** Abre una lista como eta15_api (lista y padron en UNA transaccion). */
          async function openRaw(group: string, pupils: Pupil[], date = D) {
            const c = await cluster.pool.connect();
            try {
              await c.query('begin');
              const day = (
                await c.query(
                  `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4) returning id`,
                  [ids.year, group, date, ids.boss],
                )
              ).rows[0].id as string;
              for (const p of pupils)
                await c.query(
                  `insert into attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id) values ($1, $2, $3, $4)`,
                  [day, ids.year, p.enrollment, p.assignment],
                );
              await c.query('commit');
              return day;
            } catch (e) {
              await c.query('rollback').catch(() => undefined);
              throw e;
            } finally {
              c.release();
            }
          }
          async function twoConnections(
            run: (c1: pg.PoolClient, c2: pg.PoolClient) => Promise<void>,
          ) {
            const c1 = await cluster.pool.connect();
            const c2 = await cluster.pool.connect();
            try {
              await run(c1, c2);
            } finally {
              for (const c of [c1, c2]) {
                await c.query('rollback').catch(() => undefined);
                c.release();
              }
            }
          }
          const recordsOf = async (day: string) =>
            (await owner(
              `select id, status from attendance_records where attendance_day_id = $1 order by id`,
              [day],
            )) as Array<{ id: string; status: string | null }>;
          const markSql = `update attendance_records set status = 'present', marked_by = $2 where id = $1`;
          const finalizeSql = `update attendance_days set status = 'finalized', finalized_by = $2, revision = revision + 1 where id = $1`;

          beforeAll(async () => {
            ids.boss = (
              await owner(
                `select ur.user_id as id from user_roles ur join roles r on r.id = ur.role_id
                  where r.key = 'direccion' and ur.revoked_at is null order by ur.granted_at limit 1`,
              )
            )[0]!.id as string;
            ids.start = addDays(today, -3000);
            ids.year = (
              await owner(
                `insert into school_years (name, starts_on, ends_on) values ('Ciclo PG asistencia', $1, $2) returning id`,
                [ids.start, addDays(today, -2700)],
              )
            )[0]!.id as string;
          }, 60_000);

          it('matriz exacta por columna: el verificador oficial aprueba y las operaciones aprobadas funcionan', async () => {
            await verify();
            const g = await newGroup('M1');
            const ps = [await newPupil(g), await newPupil(g)];
            const day = await openRaw(g, ps);
            const [r1, r2] = await recordsOf(day);
            await api(markSql, [r1!.id, ids.boss]);
            await api(`update attendance_days set revision = revision + 1 where id = $1`, [day]);
            await api(markSql, [r2!.id, ids.boss]);
            await api(`update attendance_days set revision = revision + 1 where id = $1`, [day]);
            await api(finalizeSql, [day, ids.boss]);
            await api(
              `insert into attendance_events (attendance_day_id, event_type, actor_id, revision_after) values ($1, 'day_opened', $2, 1)`,
              [day, ids.boss],
            );
            const rows = await api(
              `select id, school_year_id, group_id, attendance_date, status, revision, created_by, finalized_by, finalized_at, created_at from attendance_days where id = $1`,
              [day],
            );
            expect(rows.rows[0].finalized_at).toBeTruthy(); // lo fijo el trigger, no el cliente
            const rr = await api(
              `select id, attendance_day_id, school_year_id, enrollment_id, group_assignment_id, status, marked_by, marked_at, created_at from attendance_records where attendance_day_id = $1`,
              [day],
            );
            expect(rr.rows.every((x) => x.marked_at)).toBe(true);
            await api(
              `select id, attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after, occurred_at from attendance_events limit 1`,
            );
          });

          it('columnas NO aprobadas: ni se leen (updated_at, *) ni se escriben (alta y cambio): 42501', async () => {
            for (const t of ['attendance_days', 'attendance_records'])
              await denied(`select updated_at from ${t}`);
            // (el historial no tiene updated_at: todas sus columnas son legibles, por eso `select *` solo se niega en las otras dos)
            for (const t of ['attendance_days', 'attendance_records'])
              await denied(`select * from ${t}`);
            const g = await newGroup('M2');
            const p = await newPupil(g);
            const day = await openRaw(g, [p]);
            const [rec] = await recordsOf(day);
            // alta con columnas fuera de la lista aprobada
            for (const extra of [
              `status`,
              `revision`,
              `id`,
              `finalized_at`,
              `finalized_by`,
              `created_at`,
              `updated_at`,
            ]) {
              const val =
                extra === 'status'
                  ? `'finalized'`
                  : extra === 'revision'
                    ? '1'
                    : extra === 'id'
                      ? 'gen_random_uuid()'
                      : extra === 'finalized_by'
                        ? `'${ids.boss}'`
                        : 'now()';
              await expect(
                api(
                  `insert into attendance_days (school_year_id, group_id, attendance_date, created_by, ${extra})
                   values ('${ids.year}', '${g}', '${lastDow(1, 2900)}', '${ids.boss}', ${val})`,
                ),
              ).rejects.toMatchObject({ code: '42501' });
            }
            for (const col of [
              'id',
              'school_year_id',
              'group_id',
              'attendance_date',
              'created_by',
              'finalized_at',
              'created_at',
              'updated_at',
            ])
              await denied(`update attendance_days set ${col} = ${col} where false`);
            for (const col of [
              'id',
              'attendance_day_id',
              'school_year_id',
              'enrollment_id',
              'group_assignment_id',
              'marked_at',
              'created_at',
              'updated_at',
            ])
              await denied(`update attendance_records set ${col} = ${col} where false`);
            await expect(
              api(
                `insert into attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id, status)
                 values ('${day}', '${ids.year}', '${p.enrollment}', '${p.assignment}', 'present')`,
              ),
            ).rejects.toMatchObject({ code: '42501' });
            // el historial: sin UPDATE de ninguna columna y sin elegir la hora
            for (const col of [
              'id',
              'attendance_day_id',
              'record_id',
              'event_type',
              'actor_id',
              'request_id',
              'payload_hash',
              'old_status',
              'new_status',
              'revision_after',
              'occurred_at',
            ])
              await denied(`update attendance_events set ${col} = ${col} where false`);
            await expect(
              api(
                `insert into attendance_events (attendance_day_id, event_type, actor_id, revision_after, occurred_at)
                 values ('${day}', 'day_opened', '${ids.boss}', 1, now())`,
              ),
            ).rejects.toMatchObject({ code: '42501' });
            expect(rec).toBeTruthy();
          });

          it('DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE, SET ROLE y autorizacion: denegados (42501)', async () => {
            for (const t of ['attendance_days', 'attendance_records', 'attendance_events']) {
              await denied(`delete from ${t}`);
              await denied(`truncate ${t}`);
              await denied(
                `create trigger t_x before insert on ${t} for each row execute function set_updated_at()`,
              );
              await denied(`create table public.tmp_fk (a uuid references ${t}(id))`);
            }
            await denied('create table tmp_x (id int)');
            await denied('set role eta15_app');
            await denied(
              `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
               select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p
                where r.key = 'trabajo_social' and p.key = 'attendance:read'`,
            );
            await denied('update role_permissions set scope = scope where false');
            await denied('delete from permissions');
            // aunque la API fuera el propietario, los triggers lo impedirian (se prueba como propietario)
            await expect(owner('delete from attendance_events')).rejects.toMatchObject({
              code: '42501',
            });
            await expect(owner('truncate attendance_days cascade')).rejects.toMatchObject({
              code: '42501',
            });
          });

          it('el verificador detecta un privilegio de mas (DELETE, UPDATE del historial, columna) y de menos', async () => {
            await owner('grant delete on attendance_days to eta15_api');
            await expect(verify()).rejects.toThrow(/DELETE sobre attendance_days/);
            await owner('revoke delete on attendance_days from eta15_api');
            await owner('grant update (revision_after) on attendance_events to eta15_api');
            await expect(verify()).rejects.toThrow(
              /UPDATE attendance_events\.revision_after efectivo=t/,
            );
            await owner('revoke update (revision_after) on attendance_events from eta15_api');
            await owner('grant update (attendance_date) on attendance_days to eta15_api');
            await expect(verify()).rejects.toThrow(
              /UPDATE attendance_days\.attendance_date efectivo=t/,
            );
            await owner('revoke update (attendance_date) on attendance_days from eta15_api');
            await owner('revoke select (created_at) on attendance_records from eta15_api');
            await expect(verify()).rejects.toThrow(
              /SELECT attendance_records\.created_at efectivo=f/,
            );
            await owner('grant select (created_at) on attendance_records to eta15_api');
            await verify();
          });

          it('carrera real: dos aperturas simultaneas del mismo grupo y fecha -> exactamente una; la otra espera y no crea', async () => {
            const g = await newGroup('R1');
            const p = await newPupil(g);
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await c1.query(
                `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)`,
                [ids.year, g, D, ids.boss],
              );
              await c2.query('begin');
              let done = false;
              const second = c2
                .query(
                  `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)
                   on conflict on constraint att_days_group_date_key do nothing returning id`,
                  [ids.year, g, D, ids.boss],
                )
                .then((r) => {
                  done = true;
                  return r;
                });
              await wait();
              expect(done).toBe(false); // espera al COMMIT de la primera
              await c1.query('commit');
              expect((await second).rows).toHaveLength(0);
              await c2.query('commit');
            });
            expect(
              (
                await owner(`select count(*)::int n from attendance_days where group_id = $1`, [g])
              )[0]!.n,
            ).toBe(1);
            expect(p.student).toBeTruthy();
          });

          it('carrera real: guardar vs finalizar a nivel de BD -> la finalizacion espera al guardado y ve el ultimo pendiente marcado', async () => {
            const g = await newGroup('R2');
            const ps = [await newPupil(g), await newPupil(g)];
            const day = await openRaw(g, ps);
            const [r1, r2] = await recordsOf(day);
            await api(markSql, [r1!.id, ids.boss]);
            await api(`update attendance_days set revision = revision + 1 where id = $1`, [day]);
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await c1.query(markSql, [r2!.id, ids.boss]); // guardado en curso: mantiene la lista en FOR SHARE
              await c2.query('begin');
              let done = false;
              const fin = settle(c2.query(finalizeSql, [day, ids.boss])).then((x) => {
                done = true;
                return x;
              });
              await wait();
              expect(done).toBe(false); // la finalizacion espera
              await c1.query('commit');
              expect(await fin).toBe('ok'); // ya no queda pendiente
              await c2.query('commit');
            });
            expect(
              (await owner(`select status from attendance_days where id = $1`, [day]))[0]!.status,
            ).toBe('finalized');
            expect((await recordsOf(day)).every((r) => r.status === 'present')).toBe(true);
          });

          it('carrera real: finalizar vs guardar (orden inverso) -> el guardado espera y se rechaza (42501); nada cambia', async () => {
            const g = await newGroup('R3');
            const ps = [await newPupil(g), await newPupil(g)];
            const day = await openRaw(g, ps);
            const [r1, r2] = await recordsOf(day);
            await api(markSql, [r1!.id, ids.boss]);
            await api(markSql, [r2!.id, ids.boss]);
            await api(`update attendance_days set revision = revision + 1 where id = $1`, [day]);
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await c1.query(finalizeSql, [day, ids.boss]);
              await c2.query('begin');
              const late = settle(
                c2.query(
                  `update attendance_records set status = 'absent', marked_by = $2 where id = $1`,
                  [r1!.id, ids.boss],
                ),
              );
              await wait();
              await c1.query('commit');
              expect(await late).toMatch(/^42501:/);
            });
            expect((await recordsOf(day)).every((r) => r.status === 'present')).toBe(true);
          });

          it('carrera real: dos finalizaciones simultaneas -> una sola; la otra recibe 42501 (la lista ya es historia)', async () => {
            const g = await newGroup('R4');
            const ps = [await newPupil(g)];
            const day = await openRaw(g, ps);
            const [r1] = await recordsOf(day);
            await api(markSql, [r1!.id, ids.boss]);
            await api(`update attendance_days set revision = revision + 1 where id = $1`, [day]);
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await c1.query(finalizeSql, [day, ids.boss]);
              await c2.query('begin');
              const second = settle(c2.query(finalizeSql, [day, ids.boss]));
              await wait();
              await c1.query('commit');
              expect(await second).toMatch(/^42501:/);
            });
            const row = (
              await owner(`select status, revision from attendance_days where id = $1`, [day])
            )[0]!;
            expect([row.status, row.revision]).toEqual(['finalized', 3]);
          });

          it('carrera real: la desactivacion del grupo vs la apertura de lista -> no se abre una lista de un grupo inactivo', async () => {
            const g = await newGroup('R5');
            const p = await newPupil(g);
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await c1.query('update groups set is_active = false where id = $1', [g]);
              await c2.query('begin');
              const pending = settle(
                c2.query(
                  `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)`,
                  [ids.year, g, D, ids.boss],
                ),
              );
              await wait();
              await c1.query('commit');
              expect(await pending).toBe('23514:att_days_group_active');
            });
            expect(p.student).toBeTruthy();
          });

          it('carrera real: acortar el ciclo vs abrir una lista (y al reves) -> nunca queda una lista fuera de las fechas', async () => {
            const y2 = (
              await owner(
                `insert into school_years (name, starts_on, ends_on) values ('Ciclo PG asistencia 2', $1, $2) returning id`,
                [addDays(today, -4000), addDays(today, -3700)],
              )
            )[0]!.id as string;
            const g2 = (
              await owner(
                `insert into groups (school_year_id, grade, code) values ($1, 2, 'Z') returning id`,
                [y2],
              )
            )[0]!.id as string;
            const date = lastDow(2, 3900);
            const ins = (c: pg.PoolClient) =>
              c.query(
                `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)`,
                [y2, g2, date, ids.boss],
              );
            // a) acortar primero (sin listas todavia), abrir despues -> la lista fuera del nuevo rango falla
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await c1.query(`update school_years set starts_on = $2 where id = $1`, [
                y2,
                addDays(date, 1),
              ]);
              await c2.query('begin');
              const pending = settle(ins(c2));
              await wait();
              await c1.query('commit');
              expect(await pending).toBe('23514:att_days_within_year');
            });
            await owner(`update school_years set starts_on = $2 where id = $1`, [
              y2,
              addDays(today, -4000),
            ]);
            // b) abrir primero, acortar despues -> el cambio de fechas falla
            await twoConnections(async (c1, c2) => {
              await c1.query('begin');
              await ins(c1);
              await c2.query('begin');
              const pending = settle(
                c2.query(`update school_years set starts_on = $2 where id = $1`, [
                  y2,
                  addDays(date, 1),
                ]),
              );
              await wait();
              await c1.query('commit');
              expect(await pending).toBe('23514:school_years_attendance_within');
            });
          });

          // ------------------------------------------------------------- con la API HTTP real (servicio + base)
          describe('el servicio serializa con revocaciones, desactivaciones y traslados', () => {
            const clock = { today: D };
            let app: Awaited<ReturnType<typeof kit.build>>;
            const json = (r: { json: () => unknown }) => r.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
            let n = 0;
            const rid = () => `00000000-0000-4000-8000-${String(700000000000 + ++n).slice(-12)}`;
            async function fixtures(code: string, students = 2) {
              const g = await newGroup(code);
              const ps: Pupil[] = [];
              for (let i = 0; i < students; i += 1) ps.push(await newPupil(g));
              const acc = await kit.seed({ role: 'prefectura' });
              await owner(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
              try {
                await owner(
                  `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
                  [acc.id, ids.year, g, ids.start, ids.boss],
                );
              } finally {
                await owner(
                  `alter table prefect_group_assignments enable trigger pga_guard_insert`,
                );
              }
              const login = await kit.login(acc, app);
              return { g, ps, acc, login };
            }
            const call = (
              login: Awaited<ReturnType<typeof kit.login>>,
              method: 'GET' | 'POST',
              url: string,
              body?: unknown,
            ) => kit.call(login, method, url, { body, target: app });

            beforeAll(async () => {
              app = await kit.build({}, { schoolToday: () => clock.today });
            });

            it('la revocacion de la asignacion vs un guardado: el guardado espera, y despues se rechaza (404); si el guardado va primero, la revocacion espera', async () => {
              const f = await fixtures('H1');
              const day = json(
                await call(f.login, 'POST', '/school/attendance/days', { groupId: f.g }),
              ).day.id as string;
              // a) revocacion sin confirmar mantiene bloqueada la asignacion
              const revoker = await cluster.pool.connect();
              try {
                await revoker.query('begin');
                await revoker.query(
                  `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Carrera con guardado' where user_id = $1`,
                  [f.acc.id, ids.boss],
                );
                let done = false;
                const saving = call(f.login, 'POST', `/school/attendance/days/${day}/marks`, {
                  expectedRevision: 1,
                  requestId: rid(),
                  marks: [{ studentId: f.ps[0]!.student, status: 'present' }],
                }).then((r) => {
                  done = true;
                  return r;
                });
                await wait();
                expect(done).toBe(false);
                await revoker.query('commit');
                const res = await saving;
                expect(res.statusCode).toBe(404);
                expect((await recordsOf(day)).every((r) => r.status === null)).toBe(true);
              } finally {
                await revoker.query('rollback').catch(() => undefined);
                revoker.release();
              }
              // b) un guardado en curso (acceso bloqueado FOR SHARE) hace esperar a la revocacion
              const g2 = await fixtures('H2');
              const day2 = json(
                await call(g2.login, 'POST', '/school/attendance/days', { groupId: g2.g }),
              ).day.id as string;
              const saver = await cluster.pool.connect();
              try {
                await saver.query('begin');
                await saver.query(
                  `select a.id from prefect_group_assignments a join users u on u.id = a.user_id where a.user_id = $1 for share of a, u`,
                  [g2.acc.id],
                );
                let revoked = false;
                const revoking = cluster.owner
                  .query(
                    `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Carrera inversa' where user_id = $1`,
                    [g2.acc.id, ids.boss],
                  )
                  .then(() => {
                    revoked = true;
                  });
                await wait();
                expect(revoked).toBe(false); // la captura en curso se completa antes de retirar el acceso
                await saver.query('commit');
                await revoking;
                expect(revoked).toBe(true);
              } finally {
                await saver.query('rollback').catch(() => undefined);
                saver.release();
              }
              expect(
                (await call(g2.login, 'GET', `/school/attendance/days/${day2}`)).statusCode,
              ).toBe(404);
            });

            it('desactivar el grupo vs guardar: si la desactivacion llega entre la comprobacion de acceso y el bloqueo, el guardado recibe 409 GROUP_INACTIVE', async () => {
              const f = await fixtures('H3');
              const day = json(
                await call(f.login, 'POST', '/school/attendance/days', { groupId: f.g }),
              ).day.id as string;
              const c1 = await cluster.pool.connect();
              try {
                await c1.query('begin');
                await c1.query('update groups set is_active = false where id = $1', [f.g]);
                let done = false;
                const saving = call(f.login, 'POST', `/school/attendance/days/${day}/marks`, {
                  expectedRevision: 1,
                  requestId: rid(),
                  marks: [{ studentId: f.ps[0]!.student, status: 'present' }],
                }).then((r) => {
                  done = true;
                  return r;
                });
                await wait();
                expect(done).toBe(false); // espera el COMMIT de la desactivacion
                await c1.query('commit');
                const res = await saving;
                // tras el COMMIT el acceso ya no existe (grupo inactivo) o, si se resolvio antes, el bloqueo ve el grupo inactivo
                expect([404, 409]).toContain(res.statusCode);
                if (res.statusCode === 409) expect(json(res).error.code).toBe('GROUP_INACTIVE');
                expect((await recordsOf(day)).every((r) => r.status === null)).toBe(true);
              } finally {
                await c1.query('rollback').catch(() => undefined);
                c1.release();
              }
            });

            it('un traslado que confirma durante la apertura no deja un padron inconsistente: la lista se abre con el padron ya actualizado', async () => {
              const f = await fixtures('H4', 3);
              const c1 = await cluster.pool.connect();
              try {
                await c1.query('begin');
                await c1.query(`update student_group_assignments set ends_on = $2 where id = $1`, [
                  f.ps[0]!.assignment,
                  addDays(D, -1),
                ]);
                let done = false;
                const opening = call(f.login, 'POST', '/school/attendance/days', {
                  groupId: f.g,
                }).then((r) => {
                  done = true;
                  return r;
                });
                await wait();
                expect(done).toBe(false); // el padron se bloquea FOR SHARE: espera al traslado
                await c1.query('commit');
                const res = await opening;
                expect(res.statusCode, res.body).toBe(201);
                const ids2 = json(res).day.records.map((r: { studentId: string }) => r.studentId);
                expect(ids2).toHaveLength(2);
                expect(ids2).not.toContain(f.ps[0]!.student);
              } finally {
                await c1.query('rollback').catch(() => undefined);
                c1.release();
              }
            });

            it('abrir y guardar con la misma prefecta desde varias conexiones: el historial queda sin duplicados', async () => {
              const f = await fixtures('H5', 4);
              const day = json(
                await call(f.login, 'POST', '/school/attendance/days', { groupId: f.g }),
              ).day.id as string;
              const requestId = rid();
              const marks = f.ps.map((p) => ({ studentId: p.student, status: 'present' }));
              const rs = await Promise.all(
                Array.from({ length: 6 }, () =>
                  call(f.login, 'POST', `/school/attendance/days/${day}/marks`, {
                    expectedRevision: 1,
                    requestId,
                    marks,
                  }),
                ),
              );
              expect(rs.every((r) => r.statusCode === 200)).toBe(true); // reintentos concurrentes de la MISMA solicitud
              expect(rs.filter((r) => json(r).replayed === false)).toHaveLength(1);
              expect(
                (
                  await owner(
                    `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed'`,
                    [day],
                  )
                )[0]!.n,
              ).toBe(4);
              expect(
                (await owner(`select revision from attendance_days where id = $1`, [day]))[0]!
                  .revision,
              ).toBe(2);
            });
          });
        });
      },
    },
  );
}

suite('PostgreSQL desechable + privilegios 0005 (asistencia)', 'full');
suite('PostgreSQL desechable sin privilegios 0005 (asistencia)', 'unavailable');
