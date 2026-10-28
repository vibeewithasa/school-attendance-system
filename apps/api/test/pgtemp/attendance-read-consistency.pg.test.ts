import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SessionStore } from '../../src/modules/auth/session-service.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { addDays, todayIso } from '../helpers/students-suite.js';

/**
 * CARRERA DE LECTURA del portal web, reproducida de forma DETERMINISTA contra PostgreSQL 18 desechable (conexiones reales).
 *
 * `GET /school/attendance/days/:id` arma la respuesta con varias consultas (cabecera y conteos, luego renglones). Un guardado que se
 * confirme ENTRE ellas producia una respuesta con conteos de una revision y renglones de otra. Aqui el almacen se envuelve para
 * que, justo ANTES de la consulta de renglones, otra prefecta guarde (por HTTP, en otra conexion) y confirme. Con la foto
 * consistente (REPEATABLE READ) la respuesta debe describir UN solo instante. Nunca contra eta15_dev.
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
  'PG desechable consistencia de lectura web',
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
      const real = todayIso();
      // miercoles reciente: el "hoy" escolar simulado (la base impide listas futuras)
      let W = addDays(real, -10);
      while (((new Date(`${W}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 !== 3) W = addDays(W, -1);
      const q = async (sql: string, params: unknown[] = []) =>
        (await kit.harness.owner(sql, params)).rows;

      it('una lectura web NO mezcla la cabecera de una revision con los renglones de otra cuando un guardado se confirma entre ellas', async () => {
        const year = (
          await q(
            `insert into school_years (name, starts_on, ends_on) values ('Ciclo carrera web', $1, $2) returning id`,
            [addDays(real, -400), addDays(real, 300)],
          )
        )[0]!.id as string;
        const group = (
          await q(
            `insert into groups (school_year_id, grade, code) values ($1, 1, 'RW') returning id`,
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
              [st, year, addDays(real, -300)],
            )
          )[0]!.id as string;
          await q(
            `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
            [en, year, group, addDays(real, -300)],
          );
          students.push(st);
        }
        const normal = await kit.build({}, { schoolToday: () => W });
        const prefect = await kit.seed({ role: 'prefectura' });
        await q(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
        await q(
          `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
          [prefect.id, year, group, addDays(real, -380), kit.boss.id],
        );
        await q(`alter table prefect_group_assignments enable trigger pga_guard_insert`);
        const login = await kit.login(prefect, normal);
        const open = await kit.call(login, 'POST', '/school/attendance/days', {
          body: { groupId: group },
          target: normal,
        });
        expect(open.statusCode, open.body).toBe(201);
        const dayId = open.json().day.id as string;

        // Almacen envuelto: justo antes de la consulta de RENGLONES de la lectura, otra prefecta guarda y confirma.
        let armed = false;
        let fired = 0;
        const hooked: SessionStore = {
          transaction: (fn) =>
            kit.harness.store.transaction((tx) =>
              fn({
                query: async (sql, params) => {
                  if (armed && sql.includes('SELECT s.id AS student_id')) {
                    armed = false;
                    fired += 1;
                    const save = await kit.call(
                      login,
                      'POST',
                      `/school/attendance/days/${dayId}/marks`,
                      {
                        body: {
                          expectedRevision: 1,
                          requestId: '00000000-0000-4000-8000-0000000000a1',
                          marks: [{ studentId: students[0], status: 'present' }],
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
        armed = true;
        const view = await kit.call(readerLogin, 'GET', `/school/attendance/days/${dayId}`, {
          target: reader,
        });
        expect(view.statusCode, view.body).toBe(200);
        expect(fired).toBe(1); // el guardado se confirmo justo entre las consultas de la lectura
        const d = view.json();
        const marked = d.records.filter((r: { status: string }) => r.status !== 'pending').length;
        const counted = d.counts.present + d.counts.absent;
        // UN solo instante: conteos, renglones y revision describen lo mismo
        expect([counted, marked, d.revision]).toEqual([marked, marked, 1 + marked]);
        // y el guardado SI quedo confirmado despues (la siguiente lectura ya lo ve)
        const later = await kit.call(readerLogin, 'GET', `/school/attendance/days/${dayId}`, {
          target: reader,
        });
        expect(later.json().revision).toBe(2);
        expect(later.json().counts.present).toBe(1);
      });
    },
  },
);
