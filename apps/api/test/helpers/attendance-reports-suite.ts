import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AdminKit, Login } from './admin-http-suite.js';
import { lastDow } from './attendance-suite.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * Pruebas HTTP de los reportes basicos de asistencia (solo lectura) con Fastify `inject`, un rol de ejecucion NO propietario
 * (PGlite o clúster desechable) y un RELOJ ESCOLAR simulado. Las listas se crean POR LA API (abrir, guardar, finalizar) moviendo el
 * reloj a cada dia; las altas, traslados y bajas de alumnos los siembra el propietario. Datos y cuentas FICTICIOS; nunca eta15_dev.
 *
 * Escenario (semana D1..D5 = lunes a viernes de hace 2 a 3 semanas), grupos A y B del mismo ciclo:
 *  - A: D1 finalizada (a2 ausente) · D2 BORRADOR (a3 y a4 sin marca) · D3 SIN LISTA · D4 finalizada (3 alumnos) · D5 borrador.
 *  - a4 se traslada de A a B el D3 (B tiene lista el D3). a5 se incorpora a A el D4 DESPUES de abrir la lista (fuera del padron).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function defineAttendanceReportTests(kit: AdminKit): void {
  describe('reportes basicos de asistencia (solo lectura)', () => {
    const real = todayIso();
    const D1 = lastDow(1, 14);
    const D = [D1, addDays(D1, 1), addDays(D1, 2), addDays(D1, 3), addDays(D1, 4)] as const;
    const REPORT_TODAY = addDays(D[4], 7); // viernes de la semana siguiente (todavia en el pasado real)
    const clock = { today: REPORT_TODAY };
    let app: FastifyInstance;
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string> = {};
    let dir: Login;
    let tecnico: Login;
    let social: Login;
    let acceso: Login;
    let pA: Login; // grupos A y B
    let pB: Login; // solo A
    let pC: Login; // sin asignaciones
    let pD: Login; // solo B
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await q(sql, params))[0]!.n);
    const get = (login: Login | null, url: string) => kit.call(login, 'GET', url, { target: app });
    const post = (login: Login | null, url: string, body?: unknown) =>
      kit.call(login, 'POST', url, { body, target: app });
    const R = '/school/attendance/reports';
    const groupUrl = (g: string, from: string, to: string, extra = '') =>
      `${R}/group?groupId=${g}&from=${from}&to=${to}${extra}`;
    const studentUrl = (s: string, from: string, to: string, year = Y.cur) =>
      `${R}/student/${s}?schoolYearId=${year}&from=${from}&to=${to}`;
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const uuid = () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(800000000000 + n).slice(-12)}`;
    };
    const newStudent = async (group: string, from: string, code: string | null = null) => {
      n += 1;
      const st = (
        await q(
          `insert into students (given_names, family_name, school_code) values ($1, $2, $3) returning id`,
          [`Alumno${alpha(n)}`, `Apellido${alpha(n)}`, code],
        )
      )[0]!.id as string;
      const en = (
        await q(
          `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
          [st, Y.cur, from],
        )
      )[0]!.id as string;
      await q(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
        [en, Y.cur, group, from],
      );
      return { student: st, enrollment: en };
    };
    const assignPrefect = async (userId: string, groupId: string) => {
      await q(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
      try {
        await q(
          `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by)
           values ($1, $2, $3, $4, $5)`,
          [userId, Y.cur, groupId, addDays(real, -200), kit.boss.id],
        );
      } finally {
        await q(`alter table prefect_group_assignments enable trigger pga_guard_insert`);
      }
    };
    /** Abre la lista del grupo EN esa fecha (reloj simulado), guarda las marcas y, si se pide, la finaliza. */
    const capture = async (
      login: Login,
      groupId: string,
      date: string,
      marks: Record<string, 'present' | 'absent'>,
      finalize: boolean,
    ) => {
      clock.today = date;
      try {
        const opened = await post(login, '/school/attendance/days', { groupId });
        expect(opened.statusCode, opened.body).toBe(201);
        let day = opened.json().day as Json;
        const list = Object.entries(marks).map(([studentId, status]) => ({ studentId, status }));
        if (list.length > 0) {
          const saved = await post(login, `/school/attendance/days/${day.id}/marks`, {
            expectedRevision: day.revision,
            requestId: uuid(),
            marks: list,
          });
          expect(saved.statusCode, saved.body).toBe(200);
          day = saved.json().day;
        }
        if (finalize) {
          const done = await post(login, `/school/attendance/days/${day.id}/finalize`, {
            expectedRevision: day.revision,
          });
          expect(done.statusCode, done.body).toBe(200);
          day = done.json().day;
        }
        return day;
      } finally {
        clock.today = REPORT_TODAY;
      }
    };
    const auditTotal = () => count(`select count(*)::int n from audit_events`);
    const withoutVolatile = (r: { body: string }) =>
      r.body.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"-"');

    it('preparacion: ciclo, grupos, alumnos ficticios, listas por la API, traslado e incorporacion tardia', async () => {
      app = await kit.build({}, { schoolToday: () => clock.today });
      dir = await kit.login(kit.boss, app);
      tecnico = await kit.login(kit.techBoss, app);
      social = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
      acceso = await kit.login(await kit.seed({ role: 'control_acceso' }), app);
      pA = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pB = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pC = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pD = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo reportes', $1, $2) returning id`,
          [addDays(real, -400), addDays(real, 300)],
        )
      )[0]!.id as string;
      Y.old = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo anterior', $1, $2) returning id`,
          [addDays(real, -900), addDays(real, -500)],
        )
      )[0]!.id as string;
      const newGroup = async (year: string, code: string, active = true) =>
        (
          await q(
            `insert into groups (school_year_id, grade, code, is_active) values ($1, 1, $2, $3) returning id`,
            [year, code, active],
          )
        )[0]!.id as string;
      G.A = await newGroup(Y.cur!, 'A');
      G.B = await newGroup(Y.cur!, 'B');
      G.C = await newGroup(Y.cur!, 'C'); // sin alumnos
      G.Z = await newGroup(Y.old!, 'Z'); // otro ciclo
      G.off = await newGroup(Y.cur!, 'OFF', false);
      const from = addDays(real, -300);
      S.a1 = (await newStudent(G.A!, from, 'FIC-A1')).student;
      S.a2 = (await newStudent(G.A!, from)).student;
      S.a3 = (await newStudent(G.A!, from)).student;
      const a4 = await newStudent(G.A!, from);
      S.a4 = a4.student;
      S.b1 = (await newStudent(G.B!, from)).student;
      S.b2 = (await newStudent(G.B!, from)).student;
      S.b3 = (await newStudent(G.B!, from)).student;
      await assignPrefect(pA.account.id, G.A!);
      await assignPrefect(pA.account.id, G.B!);
      await assignPrefect(pB.account.id, G.A!);
      await assignPrefect(pD.account.id, G.B!);

      await capture(
        pA,
        G.A!,
        D[0],
        { [S.a1!]: 'present', [S.a2!]: 'absent', [S.a3!]: 'present', [S.a4!]: 'present' },
        true,
      );
      await capture(pA, G.A!, D[1], { [S.a1!]: 'present', [S.a2!]: 'absent' }, false); // a3 y a4 sin marca
      // a4 se traslada de A a B a partir del D3
      await q(
        `update student_group_assignments set ends_on = $2 where enrollment_id = $1 and ends_on is null`,
        [a4.enrollment, D[1]],
      );
      await q(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
        [a4.enrollment, Y.cur, G.B, D[2]],
      );
      await capture(
        pA,
        G.B!,
        D[2],
        { [S.b1!]: 'present', [S.b2!]: 'present', [S.b3!]: 'present', [S.a4!]: 'present' },
        true,
      );
      // D3 de A: SIN LISTA a proposito
      await capture(
        pA,
        G.A!,
        D[3],
        { [S.a1!]: 'present', [S.a2!]: 'present', [S.a3!]: 'present' },
        true,
      );
      // a5 se incorpora a A el D4, DESPUES de abrir la lista de ese dia: no esta en su padron congelado
      S.a5 = (await newStudent(G.A!, D[3])).student;
      await capture(
        pA,
        G.A!,
        D[4],
        { [S.a1!]: 'absent', [S.a2!]: 'present', [S.a3!]: 'present', [S.a5!]: 'present' },
        false,
      );
      expect(await count(`select count(*)::int n from attendance_days`)).toBe(5);
    });

    describe('proteccion y autorizacion', () => {
      const urls = () => [
        `${R}/options`,
        `${R}/group/${G.A}/students`,
        groupUrl(G.A!, D[0], D[4]),
        studentUrl(S.a1!, D[0], D[4]),
      ];

      it('sin sesion: 401 en todas las rutas de reportes', async () => {
        for (const url of urls()) expect((await get(null, url)).statusCode, url).toBe(401);
      });

      it('admin_tecnico, trabajo social y control de acceso: 403, auditado y sin ningun cambio', async () => {
        const before = await count(
          `select count(*)::int n from audit_events where event_type = 'authz.denied'`,
        );
        const days = await count(`select count(*)::int n from attendance_days`);
        for (const who of [tecnico, social, acceso])
          for (const url of urls()) expect((await get(who, url)).statusCode, url).toBe(403);
        expect(
          await count(`select count(*)::int n from audit_events where event_type = 'authz.denied'`),
        ).toBe(before + 12);
        expect(await count(`select count(*)::int n from attendance_days`)).toBe(days);
      });

      it('metodos de escritura sobre los reportes no existen (404/405) y las respuestas llevan Cache-Control: no-store', async () => {
        for (const url of [`${R}/group`, `${R}/options`, `${R}/student/${S.a1}`]) {
          const r = await post(dir, url, {});
          expect([404, 405], url).toContain(r.statusCode);
        }
        for (const url of urls()) {
          const r = await get(dir, url);
          expect(r.statusCode, url).toBe(200);
          expect(r.headers['cache-control'], url).toBe('no-store');
        }
      });

      it('la prefectura solo ve sus grupos; lo ajeno, lo inexistente y lo de otro ciclo son indistinguibles (404)', async () => {
        const unknown = '00000000-0000-4000-8000-00000000dead';
        const cases: Array<[string, Login]> = [
          [groupUrl(G.B!, D[0], D[4]), pB], // grupo de otra prefecta
          [groupUrl(G.A!, D[0], D[4]), pC], // sin asignaciones
          [`${R}/group/${G.B}/students`, pB],
          [`${R}/group/${G.A}/students`, pC],
        ];
        for (const [url, who] of cases) expect((await get(who, url)).statusCode, url).toBe(404);
        const foreign = await get(pB, groupUrl(G.B!, D[0], D[4]));
        const missing = await get(pB, groupUrl(unknown, D[0], D[4]));
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json().error.code).toBe(missing.json().error.code);
        expect(foreign.json().error.message).toBe(missing.json().error.message);
        // ciclo equivocado para un grupo valido
        expect(
          (await get(dir, groupUrl(G.A!, D[0], D[4], `&schoolYearId=${Y.old}`))).statusCode,
        ).toBe(404);
        expect(
          (await get(dir, groupUrl(G.A!, D[0], D[4], `&schoolYearId=${Y.cur}`))).statusCode,
        ).toBe(200);
        // el grupo de otro ciclo existe para Direccion y no para la prefectura
        const old = addDays(real, -800);
        expect((await get(dir, groupUrl(G.Z!, old, addDays(old, 6)))).statusCode).toBe(200);
        expect((await get(pA, groupUrl(G.Z!, old, addDays(old, 6)))).statusCode).toBe(404);
      });

      it('alumnos: ajeno, inexistente, de otro ciclo y de grupo fuera de alcance -> 404 indistinguibles; sin permiso de lectura -> 403', async () => {
        const unknown = '00000000-0000-4000-8000-00000000dead';
        const a = await get(pD, studentUrl(S.a1!, D[0], D[4])); // alumno de A, prefecta de B
        const b = await get(pD, studentUrl(unknown, D[0], D[4]));
        expect([a.statusCode, b.statusCode]).toEqual([404, 404]);
        expect(a.json().error.code).toBe(b.json().error.code);
        expect((await get(pC, studentUrl(S.a1!, D[0], D[4]))).statusCode).toBe(404);
        expect((await get(dir, studentUrl(S.a1!, D[0], D[4], Y.old))).statusCode).toBe(404); // sin matricula en ese ciclo
        expect((await get(dir, studentUrl(unknown, D[0], D[4]))).statusCode).toBe(404);
      });

      it('parametros manipulados: 400 sin repetir la entrada (ids, fechas, rangos, parametros extra o repetidos)', async () => {
        const bad = [
          `${R}/group`,
          `${R}/group?groupId=${G.A}`,
          groupUrl('no-es-uuid', D[0], D[4]),
          groupUrl(G.A!, '2026-02-30', D[4]), // fecha de calendario inexistente
          groupUrl(G.A!, '2026-1-1', D[4]),
          groupUrl(G.A!, D[0], 'manana'),
          groupUrl(G.A!, D[4], D[0]), // inicio posterior al fin
          groupUrl(G.A!, addDays(D[0], -400), D[0]), // rango excesivo
          groupUrl(G.A!, D[0], D[4], '&actorId=x'), // parametro extra
          groupUrl(G.A!, D[0], D[4], '&groupId=' + G.B), // repetido
          groupUrl(G.A!, D[0], D[4], '&schoolYearId=zzz'),
          `${R}/student/no-es-uuid?schoolYearId=${Y.cur}&from=${D[0]}&to=${D[4]}`,
          `${R}/student/${S.a1}?from=${D[0]}&to=${D[4]}`, // falta el ciclo
          `${R}/student/${S.a1}?schoolYearId=${Y.cur}&from=${D[4]}&to=${D[0]}`,
          `${R}/student/${S.a1}?schoolYearId=${Y.cur}&from=${D[0]}&to=${D[4]}&limit=9999`,
          `${R}/options?x=1`,
          `${R}/group/${G.A}/students?x=1`,
        ];
        for (const url of bad) {
          const r = await get(dir, url);
          expect(r.statusCode, url).toBe(400);
          expect(r.body, url).not.toContain('no-es-uuid');
        }
      });

      it('rangos fuera del ciclo o en el futuro: 400 con motivo; el error de rango no se revela a quien no tiene acceso (404 primero)', async () => {
        const out = await get(dir, groupUrl(G.A!, addDays(real, -401), addDays(real, -391)));
        expect([out.statusCode, out.json().error.code]).toEqual([400, 'RANGE_OUT_OF_YEAR']);
        const late = await get(dir, groupUrl(G.A!, D[0], addDays(real, 301)));
        // supera el ciclo Y el hoy: cualquiera de los dos motivos es 400 valido, pero nunca 200
        expect(late.statusCode).toBe(400);
        const future = await get(dir, groupUrl(G.A!, D[0], addDays(REPORT_TODAY, 1)));
        expect([future.statusCode, future.json().error.code]).toEqual([400, 'RANGE_IN_FUTURE']);
        const sFuture = await get(dir, studentUrl(S.a1!, D[0], addDays(REPORT_TODAY, 1)));
        expect([sFuture.statusCode, sFuture.json().error.code]).toEqual([400, 'RANGE_IN_FUTURE']);
        const sOut = await get(dir, studentUrl(S.a1!, addDays(real, -401), addDays(real, -391)));
        expect([sOut.statusCode, sOut.json().error.code]).toEqual([400, 'RANGE_OUT_OF_YEAR']);
        // sin acceso: 404, no 400 (no se confirma nada sobre el recurso)
        expect((await get(pB, groupUrl(G.B!, D[0], addDays(REPORT_TODAY, 1)))).statusCode).toBe(
          404,
        );
        expect((await get(pD, studentUrl(S.a1!, D[0], addDays(REPORT_TODAY, 1)))).statusCode).toBe(
          404,
        );
      });
    });

    describe('opciones de seleccion', () => {
      it('Direccion ve todos los ciclos y grupos; la prefectura solo los suyos; sin asignaciones, vacio', async () => {
        const all = (await get(dir, `${R}/options`)).json();
        expect(all.schoolToday).toBe(REPORT_TODAY);
        const codes = (y: string) =>
          all.schoolYears.find((x: Json) => x.id === y).groups.map((g: Json) => g.code);
        expect(codes(Y.cur!)).toEqual(['A', 'B', 'C', 'OFF']);
        expect(codes(Y.old!)).toEqual(['Z']);
        const a = (await get(pA, `${R}/options`)).json();
        expect(a.schoolYears.map((y: Json) => y.groups.map((g: Json) => g.code))).toEqual([
          ['A', 'B'],
        ]);
        const b = (await get(pB, `${R}/options`)).json();
        expect(b.schoolYears[0].groups.map((g: Json) => g.code)).toEqual(['A']);
        expect((await get(pC, `${R}/options`)).json().schoolYears).toEqual([]);
        expect(JSON.stringify(b)).not.toContain(G.B!);
      });

      it('alumnos del grupo: incluye a quien estuvo asignado alguna vez (a4 en A y en B); respeta el alcance', async () => {
        const names = (r: Json) => r.students.map((s: Json) => s.studentId).sort();
        const a = (await get(dir, `${R}/group/${G.A}/students`)).json();
        expect(names(a)).toEqual([S.a1, S.a2, S.a3, S.a4, S.a5].sort());
        const b = (await get(pD, `${R}/group/${G.B}/students`)).json();
        expect(names(b)).toEqual([S.b1, S.b2, S.b3, S.a4].sort());
        expect(Object.keys(b.students[0]).sort()).toEqual([
          'familyName',
          'givenNames',
          'studentId',
        ]);
        expect((await get(dir, `${R}/group/${G.C}/students`)).json().students).toEqual([]);
      });
    });

    describe('reporte por grupo', () => {
      it('distingue lista inexistente, borrador y finalizada; cuenta presentes, ausentes y sin marca; totales verificables', async () => {
        const r = await get(pA, groupUrl(G.A!, D[0], addDays(D[4], 2))); // incluye sabado y domingo
        expect(r.statusCode, r.body).toBe(200);
        const rep = r.json();
        expect(rep.period).toEqual({ from: D[0], to: addDays(D[4], 2) });
        expect(rep.group).toMatchObject({ id: G.A, code: 'A', isActive: true });
        expect(rep.schoolYear.id).toBe(Y.cur);
        // fines de semana: no son dias del reporte ni ausencias
        expect(rep.days.map((d: Json) => d.date)).toEqual([...D]);
        const byDate = (d: string) => rep.days.find((x: Json) => x.date === d).list;
        expect(byDate(D[0])).toMatchObject({
          status: 'finalized',
          rosterSize: 4,
          present: 3,
          absent: 1,
          noMark: 0,
        });
        expect(byDate(D[1])).toMatchObject({
          status: 'draft',
          rosterSize: 4,
          present: 1,
          absent: 1,
          noMark: 2,
        });
        expect(byDate(D[2])).toBeNull(); // SIN LISTA
        expect(byDate(D[3])).toMatchObject({
          status: 'finalized',
          rosterSize: 3,
          present: 3,
          absent: 0,
          noMark: 0,
        });
        expect(byDate(D[4])).toMatchObject({
          status: 'draft',
          rosterSize: 4,
          present: 3,
          absent: 1,
          noMark: 0,
        });
        expect(rep.totals).toEqual({
          weekdays: 5,
          withList: 4,
          draft: 2,
          finalized: 2,
          withoutList: 1,
          studentDays: 15,
          present: 10,
          absent: 3,
          noMark: 2,
        });
        // alumnos del padron: cada uno solo cuenta las listas que lo incluyen
        const st = (id: string) => rep.students.find((s: Json) => s.studentId === id);
        expect(st(S.a1!)).toMatchObject({ listsApplicable: 4, present: 3, absent: 1, noMark: 0 });
        expect(st(S.a2!)).toMatchObject({ listsApplicable: 4, present: 2, absent: 2, noMark: 0 });
        expect(st(S.a3!)).toMatchObject({ listsApplicable: 4, present: 3, absent: 0, noMark: 1 });
        expect(st(S.a4!)).toMatchObject({ listsApplicable: 2, present: 1, absent: 0, noMark: 1 }); // trasladado
        expect(st(S.a5!)).toMatchObject({ listsApplicable: 1, present: 1, absent: 0, noMark: 0 }); // incorporacion tardia
        expect(rep.students.map((s: Json) => s.studentId).sort()).toEqual(
          [S.a1, S.a2, S.a3, S.a4, S.a5].sort(),
        );
        // consistencia interna: los tres cortes suman lo mismo
        const sum = (k: string) => rep.students.reduce((acc: number, s: Json) => acc + s[k], 0);
        expect([sum('present'), sum('absent'), sum('noMark'), sum('listsApplicable')]).toEqual([
          10, 3, 2, 15,
        ]);
        expect(rep.totals.present + rep.totals.absent + rep.totals.noMark).toBe(
          rep.totals.studentDays,
        );
        expect(rep.totals.withList + rep.totals.withoutList).toBe(rep.totals.weekdays);
        // sin porcentajes ni campos inventados
        expect(r.body).not.toMatch(/percent|porcentaje|justif/i);
      });

      it('orden determinista de alumnos y respuesta identica entre llamadas', async () => {
        const url = groupUrl(G.A!, D[0], D[4]);
        const r1 = await get(dir, url);
        const r2 = await get(dir, url);
        expect(withoutVolatile(r1)).toBe(withoutVolatile(r2));
        // el orden es el de la base (apellidos, nombres, id) y no cambia entre llamadas
        expect(r1.json().students.map((s: Json) => s.studentId)).toEqual(
          r2.json().students.map((s: Json) => s.studentId),
        );
      });

      it('un rango sin listas devuelve solo "sin lista" (no ausencias); un fin de semana completo no tiene dias habiles', async () => {
        const empty = (await get(dir, groupUrl(G.C!, D[0], D[4]))).json();
        expect(empty.totals).toMatchObject({
          weekdays: 5,
          withList: 0,
          withoutList: 5,
          studentDays: 0,
          absent: 0,
          present: 0,
        });
        expect(empty.students).toEqual([]);
        expect(empty.days.every((d: Json) => d.list === null)).toBe(true);
        const weekend = (await get(dir, groupUrl(G.A!, addDays(D[4], 1), addDays(D[4], 2)))).json();
        expect(weekend.days).toEqual([]);
        expect(weekend.totals.weekdays).toBe(0);
      });

      it('una lista de otro grupo no se mezcla: B solo tiene la lista del D3 (con el alumno trasladado)', async () => {
        const rep = (await get(pD, groupUrl(G.B!, D[0], D[4]))).json();
        expect(rep.totals).toMatchObject({
          weekdays: 5,
          withList: 1,
          finalized: 1,
          withoutList: 4,
          studentDays: 4,
          present: 4,
          absent: 0,
        });
        expect(rep.students.map((s: Json) => s.studentId).sort()).toEqual(
          [S.a4, S.b1, S.b2, S.b3].sort(),
        );
        const a4 = rep.students.find((s: Json) => s.studentId === S.a4);
        expect(a4).toMatchObject({ listsApplicable: 1, present: 1 }); // sus dias en A NO se atribuyen a B
      });

      it('un periodo parcial recorta las listas y los totales', async () => {
        const rep = (await get(dir, groupUrl(G.A!, D[1], D[2]))).json();
        expect(rep.totals).toMatchObject({
          weekdays: 2,
          withList: 1,
          draft: 1,
          withoutList: 1,
          studentDays: 4,
          present: 1,
          absent: 1,
          noMark: 2,
        });
      });

      it('Direccion y prefectura ven lo mismo del grupo (misma foto); el codigo escolar no aparece en el reporte de grupo', async () => {
        const a = await get(dir, groupUrl(G.A!, D[0], D[4]));
        const b = await get(pB, groupUrl(G.A!, D[0], D[4]));
        expect(withoutVolatile(a)).toBe(withoutVolatile(b));
        expect(a.body).not.toContain('FIC-A1');
      });
    });

    describe('reporte por alumno', () => {
      const states = (rep: Json) => rep.days.map((d: Json) => d.state);

      it('a4 (trasladado de A a B): marcas de A, "sin marca" en borrador, lista de B tras el traslado y "sin lista" despues', async () => {
        const r = await get(dir, studentUrl(S.a4!, D[0], addDays(D[4], 2)));
        expect(r.statusCode, r.body).toBe(200);
        const rep = r.json();
        expect(rep.student).toMatchObject({ id: S.a4 });
        expect(rep.enrollment.endsOn).toBeNull();
        expect(states(rep)).toEqual(['present', 'no_mark', 'present', 'no_list', 'no_list']);
        expect(rep.days.map((d: Json) => d.group?.code)).toEqual(['A', 'A', 'B', 'B', 'B']);
        expect(rep.days.map((d: Json) => d.listStatus)).toEqual([
          'finalized',
          'draft',
          'finalized',
          null,
          null,
        ]);
        expect(rep.groups.map((g: Json) => [g.group.code, g.startsOn === g.endsOn])).toHaveLength(
          2,
        );
        expect(rep.totals).toEqual({
          weekdays: 5,
          present: 2,
          absent: 0,
          noMark: 1,
          noList: 2,
          notInRoster: 0,
          notInGroup: 0,
          listsApplicable: 3,
        });
      });

      it('a5 (incorporado despues de abrir la lista): sin grupo antes, "fuera del padron" el D4 (no es ausencia), presente el D5', async () => {
        const rep = (await get(dir, studentUrl(S.a5!, D[0], D[4]))).json();
        expect(states(rep)).toEqual([
          'not_in_group',
          'not_in_group',
          'not_in_group',
          'not_in_roster',
          'present',
        ]);
        expect(rep.totals).toMatchObject({
          absent: 0,
          notInGroup: 3,
          notInRoster: 1,
          present: 1,
          listsApplicable: 1,
        });
        expect(rep.days[3]).toMatchObject({ listStatus: 'finalized' });
        expect(rep.days[0]).toMatchObject({ group: null, dayId: null });
      });

      it('a1: ausencia y presencia registradas; el dia sin lista es "sin lista", jamas ausente', async () => {
        const rep = (await get(dir, studentUrl(S.a1!, D[0], D[4]))).json();
        expect(states(rep)).toEqual(['present', 'present', 'no_list', 'present', 'absent']);
        expect(rep.totals).toMatchObject({
          present: 3,
          absent: 1,
          noList: 1,
          noMark: 0,
          listsApplicable: 4,
        });
        const a2 = (await get(dir, studentUrl(S.a2!, D[0], D[4]))).json();
        expect(states(a2)).toEqual(['absent', 'absent', 'no_list', 'present', 'present']);
      });

      it('a3: borrador con renglon pendiente -> "sin marca" (no ausente)', async () => {
        const rep = (await get(dir, studentUrl(S.a3!, D[0], D[4]))).json();
        expect(rep.days[1]).toMatchObject({ state: 'no_mark', listStatus: 'draft' });
        expect(rep.totals).toMatchObject({ noMark: 1, absent: 0 });
      });

      it('coherencia con el reporte de grupo: lo que dice el alumno coincide con su renglon en el grupo', async () => {
        const group = (await get(dir, groupUrl(G.A!, D[0], D[4]))).json();
        for (const id of [S.a1, S.a2, S.a3, S.a4, S.a5] as string[]) {
          const rep = (await get(dir, studentUrl(id, D[0], D[4]))).json();
          const inA = rep.days.filter((d: Json) => d.group?.code === 'A');
          const row = group.students.find((s: Json) => s.studentId === id);
          const c = (s: string) => inA.filter((d: Json) => d.state === s).length;
          expect([c('present'), c('absent'), c('no_mark')]).toEqual([
            row.present,
            row.absent,
            row.noMark,
          ]);
        }
      });

      it('el codigo escolar solo lo ve quien tiene alcance total (Direccion); la prefectura no', async () => {
        expect((await get(dir, studentUrl(S.a1!, D[0], D[4]))).json().student.schoolCode).toBe(
          'FIC-A1',
        );
        const p = await get(pA, studentUrl(S.a1!, D[0], D[4]));
        expect(p.statusCode).toBe(200);
        expect(p.json().student.schoolCode).toBeNull();
        expect(p.body).not.toContain('FIC-A1');
      });

      it('alcance parcial: la prefectura solo ve los dias y grupos de SUS grupos; lo demas es "sin grupo" (no se filtra el otro grupo)', async () => {
        // pD (solo B): a4 existe para ella por su asignacion en B; los dias en A no se muestran
        const d = (await get(pD, studentUrl(S.a4!, D[0], D[4]))).json();
        expect(states(d)).toEqual([
          'not_in_group',
          'not_in_group',
          'present',
          'no_list',
          'no_list',
        ]);
        expect(d.groups.map((g: Json) => g.group.code)).toEqual(['B']);
        expect(JSON.stringify(d)).not.toContain(G.A!);
        // pB (solo A): ve sus dias en A y nada de la lista de B
        const b = (await get(pB, studentUrl(S.a4!, D[0], D[4]))).json();
        expect(states(b)).toEqual([
          'present',
          'no_mark',
          'not_in_group',
          'not_in_group',
          'not_in_group',
        ]);
        expect(JSON.stringify(b)).not.toContain(G.B!);
        // pA ve ambos
        const a = (await get(pA, studentUrl(S.a4!, D[0], D[4]))).json();
        expect(states(a)).toEqual(['present', 'no_mark', 'present', 'no_list', 'no_list']);
      });

      it('Direccion consulta un alumno sin grupo asignado en el periodo: todo "sin grupo", ningun conteo inventado', async () => {
        const lone = await newStudent(G.C!, addDays(real, -100));
        await q(
          `update student_group_assignments set ends_on = $2 where enrollment_id = (select id from enrollments where student_id = $1)`,
          [lone.student, addDays(real, -90)],
        );
        const rep = (await get(dir, studentUrl(lone.student, D[0], D[4]))).json();
        expect(rep.totals).toMatchObject({
          weekdays: 5,
          notInGroup: 5,
          present: 0,
          absent: 0,
          listsApplicable: 0,
        });
      });
    });

    describe('sin efectos secundarios y semantica de eventos', () => {
      it('las lecturas no escriben nada (ni auditoria de lectura, ni listas, ni eventos)', async () => {
        const before = [
          await auditTotal(),
          await count(`select count(*)::int n from attendance_days`),
          await count(`select count(*)::int n from attendance_records`),
          await count(`select count(*)::int n from attendance_events`),
        ];
        for (const who of [dir, pA, pB, pD])
          for (const url of [
            `${R}/options`,
            `${R}/group/${G.A}/students`,
            groupUrl(G.A!, D[0], D[4]),
            studentUrl(S.a1!, D[0], D[4]),
          ])
            await get(who, url);
        const after = [
          await auditTotal(),
          await count(`select count(*)::int n from attendance_days`),
          await count(`select count(*)::int n from attendance_records`),
          await count(`select count(*)::int n from attendance_events`),
        ];
        // las lecturas permitidas no auditan; solo las denegadas (de la prefectura sin acceso a un grupo) pueden hacerlo, y aqui no hay
        expect(after).toEqual(before);
      });

      it('un guardado sin cambios (recibo mark_changed con old = new) no altera ningun conteo; un cambio real si', async () => {
        const url = groupUrl(G.A!, D[0], D[4]);
        const sUrl = studentUrl(S.a1!, D[0], D[4]);
        const g0 = await get(dir, url);
        const s0 = await get(dir, sUrl);
        const day = (g0.json().days[4].list as Json).dayId as string;
        const detail = (await get(dir, `/school/attendance/days/${day}`)).json();
        const receiptsBefore = await count(
          `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed' and old_status is not distinct from new_status`,
          [day],
        );
        // se reenvia EXACTAMENTE lo ya guardado (la lista D5 sigue en borrador)
        clock.today = D[4];
        try {
          const same = await post(pA, `/school/attendance/days/${day}/marks`, {
            expectedRevision: detail.revision,
            requestId: uuid(),
            marks: [
              { studentId: S.a1, status: 'absent' },
              { studentId: S.a2, status: 'present' },
            ],
          });
          expect(same.statusCode, same.body).toBe(200);
          expect(same.json().changed).toBe(0);
        } finally {
          clock.today = REPORT_TODAY;
        }
        const receiptsAfter = await count(
          `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed' and old_status is not distinct from new_status`,
          [day],
        );
        expect(receiptsAfter).toBeGreaterThan(receiptsBefore); // el recibo existe...
        expect(withoutVolatile(await get(dir, url))).toBe(withoutVolatile(g0)); // ...y no cuenta
        expect(withoutVolatile(await get(dir, sUrl))).toBe(withoutVolatile(s0));

        // cambio real: a1 pasa de ausente a presente en el D5
        clock.today = D[4];
        try {
          const rev = (await get(dir, `/school/attendance/days/${day}`)).json().revision;
          const change = await post(pA, `/school/attendance/days/${day}/marks`, {
            expectedRevision: rev,
            requestId: uuid(),
            marks: [{ studentId: S.a1, status: 'present' }],
          });
          expect(change.json().changed).toBe(1);
        } finally {
          clock.today = REPORT_TODAY;
        }
        const g1 = (await get(dir, url)).json();
        expect(g1.days[4].list).toMatchObject({ present: 4, absent: 0 });
        expect(g1.totals).toMatchObject({ present: 11, absent: 2, noMark: 2 });
        const s1 = (await get(dir, sUrl)).json();
        expect(s1.days[4].state).toBe('present');
        expect(s1.totals).toMatchObject({ present: 4, absent: 0 });
      });

      it('los registros no contienen nombres de menores ni cadenas del reporte (sin fugas en los logs)', async () => {
        const leaked = kit.logs.filter((l) => /Alumno[a-j]+|Apellido[a-j]+|FIC-A1/.test(l));
        expect(leaked).toEqual([]);
      });
    });
  });
}
