import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionStore } from '../../src/modules/auth/session-service.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineAttendanceReportTests } from '../helpers/attendance-reports-suite.js';
import { lastDow } from '../helpers/attendance-suite.js';
import { addDays } from '../helpers/students-suite.js';

/**
 * Reportes basicos de asistencia contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria, con las propuestas
 * 0002 a 0005 como eta15_dev tras aplicarlas):
 *  - suite HTTP completa de los reportes (solo lectura) con conexiones reales;
 *  - los reportes NO requieren ningun privilegio nuevo: `eta15_api` solo lee (SELECT) lo que ya lee la asistencia;
 *  - CARRERA DE LECTURA determinista: un guardado confirmado ENTRE las consultas del reporte no se mezcla con ellas (foto REPEATABLE
 *    READ), y lecturas simultaneas a escrituras mantienen los totales internamente consistentes.
 * No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster(10, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
  });
  clusters.push(cluster);
}, 240_000);

defineAdminHttpSuite(
  'PG desechable reportes de asistencia',
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
      defineAttendanceReportTests(kit);

      describe('reportes sobre PostgreSQL real: privilegios y consistencia', () => {
        const W = lastDow(3, 2900); // miercoles dentro de un ciclo lejano propio (sin traslape con los de la suite)
        const q = async (sql: string, params: unknown[] = []) =>
          (await kit.harness.owner(sql, params)).rows;

        it('eta15_api no necesita privilegios nuevos: los reportes solo leen y la API no puede escribir donde no debe', async () => {
          // lectura de las tablas que consultan los reportes
          for (const t of [
            'attendance_days',
            'attendance_records',
            'students',
            'enrollments',
            'student_group_assignments',
            'groups',
            'school_years',
          ])
            await expect(cluster.pool.query(`select 1 from ${t} limit 1`)).resolves.toBeDefined();
          // y sigue sin poder borrar ni vaciar nada
          for (const sql of [
            'delete from attendance_days',
            'truncate attendance_records',
            'delete from students',
          ])
            await expect(cluster.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
        });

        it('una lectura de reporte NO mezcla la cabecera de una revision con los renglones de otra cuando un guardado se confirma entre las consultas', async () => {
          const year = (
            await q(
              `insert into school_years (name, starts_on, ends_on) values ('Ciclo carrera reportes', $1, $2) returning id`,
              [addDays(W, -100), addDays(W, 100)],
            )
          )[0]!.id as string;
          const group = (
            await q(
              `insert into groups (school_year_id, grade, code) values ($1, 1, 'RR') returning id`,
              [year],
            )
          )[0]!.id as string;
          const students: string[] = [];
          for (let i = 0; i < 4; i += 1) {
            const st = (
              await q(
                `insert into students (given_names, family_name) values ($1, 'Ficticia') returning id`,
                [`Alumno${'abcd'[i]}`],
              )
            )[0]!.id as string;
            const en = (
              await q(
                `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
                [st, year, addDays(W, -60)],
              )
            )[0]!.id as string;
            await q(
              `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
              [en, year, group, addDays(W, -60)],
            );
            students.push(st);
          }
          const normal = await kit.build({}, { schoolToday: () => W });
          const prefect = await kit.seed({ role: 'prefectura' });
          await q(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
          await q(
            `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
            [prefect.id, year, group, addDays(W, -90), kit.boss.id],
          );
          await q(`alter table prefect_group_assignments enable trigger pga_guard_insert`);
          const login = await kit.login(prefect, normal);
          const open = await kit.call(login, 'POST', '/school/attendance/days', {
            body: { groupId: group },
            target: normal,
          });
          expect(open.statusCode, open.body).toBe(201);
          const dayId = open.json().day.id as string;

          // Almacen envuelto: justo antes de la consulta de ALUMNOS del reporte, otra persona guarda y confirma por HTTP.
          let armed = false;
          let fired = 0;
          const hooked: SessionStore = {
            transaction: (fn) =>
              kit.harness.store.transaction((tx) =>
                fn({
                  query: async (sql, params) => {
                    if (armed && sql.includes('GROUP BY s.id, s.given_names, s.family_name')) {
                      armed = false;
                      fired += 1;
                      const save = await kit.call(
                        login,
                        'POST',
                        `/school/attendance/days/${dayId}/marks`,
                        {
                          body: {
                            expectedRevision: 1,
                            requestId: '00000000-0000-4000-8000-0000000000b1',
                            marks: [{ studentId: students[0], status: 'absent' }],
                          },
                          target: normal,
                        },
                      );
                      expect(save.statusCode, save.body).toBe(200);
                    }
                    return tx.query(sql, params);
                  },
                }),
              ),
          };
          const reader = await kit.build({}, { schoolToday: () => W, store: hooked });
          const readerLogin = await kit.login(prefect, reader);
          const url = `/school/attendance/reports/group?groupId=${group}&from=${W}&to=${W}`;
          armed = true;
          const view = await kit.call(readerLogin, 'GET', url, { target: reader });
          expect(view.statusCode, view.body).toBe(200);
          expect(fired).toBe(1); // el guardado se confirmo justo entre las consultas del reporte
          const rep = view.json();
          // UN solo instante: la cabecera de la lista y los renglones por alumno describen lo mismo (nada marcado todavia)
          const list = rep.days[0].list;
          const studentsSum = (k: string) =>
            rep.students.reduce((acc: number, s: Record<string, number>) => acc + s[k]!, 0);
          expect([list.present, list.absent, list.noMark]).toEqual([0, 0, 4]);
          expect([studentsSum('present'), studentsSum('absent'), studentsSum('noMark')]).toEqual([
            0, 0, 4,
          ]);
          expect(rep.totals).toMatchObject({ present: 0, absent: 0, noMark: 4, studentDays: 4 });
          // el guardado SI quedo confirmado: la siguiente lectura ya lo ve
          const later = await kit.call(readerLogin, 'GET', url, { target: reader });
          expect(later.json().totals).toMatchObject({ present: 0, absent: 1, noMark: 3 });

          // Lecturas simultaneas a guardados: cada respuesta es internamente consistente
          const sUrl = `/school/attendance/reports/student/${students[1]}?schoolYearId=${year}&from=${W}&to=${W}`;
          const writes = students.slice(1).map((s, i) =>
            kit.call(login, 'POST', `/school/attendance/days/${dayId}/marks`, {
              body: {
                expectedRevision: 2 + i,
                requestId: `00000000-0000-4000-8000-0000000000c${i}`,
                marks: [{ studentId: s, status: 'present' }],
              },
              target: normal,
            }),
          );
          const reads = Array.from({ length: 12 }, () =>
            kit.call(readerLogin, 'GET', url, { target: reader }),
          );
          const studentReads = Array.from({ length: 4 }, () =>
            kit.call(readerLogin, 'GET', sUrl, { target: reader }),
          );
          await Promise.all(writes);
          for (const r of await Promise.all(reads)) {
            expect(r.statusCode, r.body).toBe(200);
            const j = r.json();
            const sum = (k: string) =>
              j.students.reduce((acc: number, s: Record<string, number>) => acc + s[k]!, 0);
            expect([sum('present'), sum('absent'), sum('noMark')]).toEqual([
              j.totals.present,
              j.totals.absent,
              j.totals.noMark,
            ]);
            expect(j.totals.present + j.totals.absent + j.totals.noMark).toBe(j.totals.studentDays);
          }
          for (const r of await Promise.all(studentReads)) {
            expect(r.statusCode, r.body).toBe(200);
            expect(['present', 'no_mark']).toContain(r.json().days[0].state);
          }
        });
      });
    },
  },
);
