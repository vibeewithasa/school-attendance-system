import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AdminKit, Login } from './admin-http-suite.js';
import { lastDow } from './attendance-suite.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * Pruebas de lo que el «Seguimiento de ausencias» (portal) necesita del reporte por grupo EXISTENTE (PR #9), sin duplicar su suite:
 * ausencias repetidas, baja y traslado (las ausencias de otro grupo nunca se atribuyen), consistencia de los cortes, acceso de
 * Trabajo Social (sin `attendance:read`: 403 aunque tenga `justifications:*`, sin filtrar nombres ni opciones), sesion caducada y
 * cuenta inactiva, y que registrar justificantes no cambia ningun conteo. Datos FICTICIOS; PGlite o PostgreSQL 18 desechable.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function defineFollowupTests(kit: AdminKit): void {
  describe('seguimiento de ausencias registradas (sobre el reporte por grupo)', () => {
    const real = todayIso();
    const D1 = lastDow(1, 21); // lunes de hace 3 a 4 semanas
    const D = [D1, addDays(D1, 1), addDays(D1, 2), addDays(D1, 3), addDays(D1, 4)] as const;
    const REPORT_TODAY = addDays(D[4], 7);
    const clock = { today: REPORT_TODAY };
    let app: FastifyInstance;
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string> = {};
    let dir: Login;
    let social: Login;
    let pA: Login;
    let pB: Login;
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await q(sql, params))[0]!.n);
    const get = (login: Login | null, url: string) => kit.call(login, 'GET', url, { target: app });
    const post = (login: Login | null, url: string, body?: unknown) =>
      kit.call(login, 'POST', url, { body, target: app });
    const R = '/school/attendance/reports';
    const groupUrl = (g: string, from = D[0], to = D[4]) =>
      `${R}/group?groupId=${g}&from=${from}&to=${to}`;
    const studentUrl = (s: string, from = D[0], to = D[4]) =>
      `${R}/student/${s}?schoolYearId=${Y.cur}&from=${from}&to=${to}`;
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const uuid = () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(600000000000 + n).slice(-12)}`;
    };
    const newStudent = async (group: string, from: string) => {
      n += 1;
      const st = (
        await q(`insert into students (given_names, family_name) values ($1, $2) returning id`, [
          `Alumno${alpha(n)}`,
          `Apellido${alpha(n)}`,
        ])
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
          `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
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
        }
      } finally {
        clock.today = REPORT_TODAY;
      }
    };
    const volatile = (r: { body: string }) =>
      r.body.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"-"');
    const fingerprint = async () =>
      JSON.stringify([
        await q(`select id, status, revision from attendance_days order by id`),
        await q(`select id, status, marked_by, marked_at from attendance_records order by id`),
        await q(`select id, event_type, old_status, new_status from attendance_events order by id`),
      ]);

    it('preparacion: grupos A y B, alumnos con ausencias repetidas, baja y traslado, y cuentas', async () => {
      app = await kit.build({}, { schoolToday: () => clock.today });
      dir = await kit.login(kit.boss, app);
      social = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
      pA = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pB = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo seguimiento', $1, $2) returning id`,
          [addDays(real, -400), addDays(real, 300)],
        )
      )[0]!.id as string;
      const grp = async (code: string) =>
        (
          await q(
            `insert into groups (school_year_id, grade, code) values ($1, 1, $2) returning id`,
            [Y.cur, code],
          )
        )[0]!.id as string;
      G.A = await grp('A');
      G.B = await grp('B');
      const old = addDays(real, -300);
      S.rep = (await newStudent(G.A!, old)).student; // ausencias repetidas
      S.ok = (await newStudent(G.A!, old)).student; // siempre presente
      const gone = await newStudent(G.A!, old); // baja a mitad del periodo
      S.gone = gone.student;
      const mover = await newStudent(G.A!, old); // traslado de A a B
      S.mover = mover.student;
      S.b1 = (await newStudent(G.B!, old)).student;
      await assignPrefect(pA.account.id, G.A!);
      await assignPrefect(pB.account.id, G.B!);

      // A: lunes a jueves con lista (viernes SIN lista). rep ausente 4 veces; gone ausente el lunes y baja despues del martes; mover
      // ausente el lunes y el martes en A y se traslada a B desde el miercoles.
      const all = (over: Record<string, 'present' | 'absent'>) => ({
        [S.rep!]: 'absent' as const,
        [S.ok!]: 'present' as const,
        [S.gone!]: 'present' as const,
        [S.mover!]: 'present' as const,
        ...over,
      });
      await capture(pA, G.A!, D[0], all({ [S.gone!]: 'absent', [S.mover!]: 'absent' }), true);
      await capture(pA, G.A!, D[1], all({ [S.mover!]: 'absent' }), true);
      // baja: ultimo dia inscrito = martes (D2); traslado: A termina el martes y B empieza el miercoles
      await q(
        `update student_group_assignments set ends_on = $2 where enrollment_id = $1 and ends_on is null`,
        [gone.enrollment, D[1]],
      );
      await q(`update enrollments set ends_on = $2 where id = $1`, [gone.enrollment, D[1]]);
      await q(
        `update student_group_assignments set ends_on = $2 where enrollment_id = $1 and ends_on is null`,
        [mover.enrollment, D[1]],
      );
      await q(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
        [mover.enrollment, Y.cur, G.B, D[2]],
      );
      const rest = { [S.rep!]: 'absent' as const, [S.ok!]: 'present' as const };
      await capture(pA, G.A!, D[2], rest, true);
      await capture(pA, G.A!, D[3], { ...rest, [S.ok!]: 'absent' }, false); // BORRADOR con una ausencia registrada
      await capture(pB, G.B!, D[2], { [S.b1!]: 'present', [S.mover!]: 'absent' }, true);
      await capture(pB, G.B!, D[3], { [S.b1!]: 'present', [S.mover!]: 'present' }, true);
    });

    const A = async (url = groupUrl(G.A!)) => (await get(dir, url)).json() as Json;
    const row = (rep: Json, id: string) =>
      rep.students.find((s: Json) => s.studentId === id) as Json;

    it('ausencias repetidas: solo marcas ausentes, en listas finalizadas y en borrador, con su estado por lista', async () => {
      const rep = await A();
      expect(rep.totals).toMatchObject({
        weekdays: 5,
        withList: 4,
        draft: 1,
        finalized: 3,
        withoutList: 1,
      });
      expect(row(rep, S.rep!)).toMatchObject({
        listsApplicable: 4,
        present: 0,
        absent: 4,
        noMark: 0,
      });
      // la ausencia de la lista en BORRADOR se cuenta como registrada (y la lista se ve como borrador)
      expect(row(rep, S.ok!)).toMatchObject({ listsApplicable: 4, present: 3, absent: 1 });
      expect(rep.days.map((d: Json) => d.list?.status ?? 'none')).toEqual([
        'finalized',
        'finalized',
        'finalized',
        'draft',
        'none',
      ]);
      // el dia sin lista (viernes) no genera ninguna ausencia
      expect(rep.days[4]).toEqual({ date: D[4], list: null });
    });

    it('baja y traslado: solo cuentan las listas que lo incluyen; las ausencias de otro grupo no se atribuyen', async () => {
      const a = await A();
      expect(row(a, S.gone!)).toMatchObject({ listsApplicable: 2, present: 1, absent: 1 }); // lunes ausente; martes presente; sin mas listas
      expect(row(a, S.mover!)).toMatchObject({ listsApplicable: 2, present: 0, absent: 2 }); // solo sus dos dias en A
      const b = await A(groupUrl(G.B!));
      expect(row(b, S.mover!)).toMatchObject({ listsApplicable: 2, present: 1, absent: 1 }); // sus dias en B, no los de A
      expect(row(b, S.b1!)).toMatchObject({ absent: 0, present: 2 });
      // el reporte individual coincide (Direccion ve ambos grupos; ninguna ausencia se pierde ni se duplica)
      const s = (await get(dir, studentUrl(S.mover!))).json() as Json;
      expect(s.totals).toMatchObject({ present: 1, absent: 3, notInRoster: 0, listsApplicable: 4 });
    });

    it('los cortes por alumno suman EXACTAMENTE los totales del grupo (sin doble conteo por uniones) en cada grupo y rango', async () => {
      for (const url of [
        groupUrl(G.A!),
        groupUrl(G.B!),
        groupUrl(G.A!, D[1], D[3]),
        groupUrl(G.A!, D[3], D[4]),
      ]) {
        const rep = await A(url);
        const sum = (k: string) => rep.students.reduce((a: number, s: Json) => a + s[k], 0);
        expect([sum('present'), sum('absent'), sum('noMark')]).toEqual([
          rep.totals.present,
          rep.totals.absent,
          rep.totals.noMark,
        ]);
        expect(rep.totals.present + rep.totals.absent + rep.totals.noMark).toBe(
          rep.totals.studentDays,
        );
        for (const s of rep.students)
          expect(s.present + s.absent + s.noMark).toBe(s.listsApplicable);
      }
      // y un periodo parcial recorta las ausencias sin inventar ninguna
      expect(row(await A(groupUrl(G.A!, D[1], D[1])), S.rep!)).toMatchObject({
        absent: 1,
        listsApplicable: 1,
      });
    });

    it('prefectura: solo su grupo; el grupo ajeno y el inexistente son indistinguibles y no revelan nombres', async () => {
      expect((await get(pA, groupUrl(G.A!))).statusCode).toBe(200);
      const foreign = await get(pA, groupUrl(G.B!));
      const missing = await get(pA, groupUrl('00000000-0000-4000-8000-00000000dead'));
      expect([foreign.statusCode, missing.statusCode]).toEqual([404, 404]);
      expect(foreign.json().error).toEqual({
        ...missing.json().error,
        requestId: foreign.json().error.requestId,
      });
      expect(foreign.body).not.toMatch(/Alumno|Apellido/);
      const opts = (await get(pB, `${R}/options`)).json() as Json;
      expect(JSON.stringify(opts)).not.toContain(G.A!);
      // el alumno que paso a su grupo solo muestra los dias en SU grupo
      const s = (await get(pB, studentUrl(S.mover!))).json() as Json;
      expect(s.totals).toMatchObject({ absent: 1, present: 1, notInGroup: 2, noList: 1 });
    });

    it('Trabajo Social (justifications:read/create, sin attendance:read) y cuentas sin sesion o con sesion caducada o inactivas: sin acceso ni nombres', async () => {
      const urls = [
        `${R}/options`,
        groupUrl(G.A!),
        studentUrl(S.rep!),
        `${R}/group/${G.A}/students`,
      ];
      for (const url of urls) {
        const r = await get(social, url);
        expect(r.statusCode, url).toBe(403);
        expect(r.body, url).not.toMatch(/Alumno|Apellido|Ciclo seguimiento/);
        expect((await get(null, url)).statusCode, url).toBe(401);
      }
      const who = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      expect((await get(who, `${R}/options`)).statusCode).toBe(200);
      await q(
        `update sessions set idle_expires_at = now() - interval '1 minute' where user_id = $1 and revoked_at is null`,
        [who.account.id],
      );
      for (const url of urls) expect((await get(who, url)).statusCode, url).toBe(401);
      const inactive = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      await q(`update users set status = 'disabled' where id = $1`, [inactive.account.id]);
      for (const url of urls) expect((await get(inactive, url)).statusCode, url).toBe(401);
    });

    it('parametros manipulados y ciclo equivocado: 400/404 sin repetir la entrada ni filtrar datos', async () => {
      for (const qs of [
        `groupId=${G.A}&from=2026-02-30&to=${D[4]}`,
        `groupId=${G.A}&from=${D[4]}&to=${D[0]}`,
        `groupId=${G.A}&from=${addDays(D[0], -400)}&to=${D[4]}`,
        `groupId=no-es-uuid&from=${D[0]}&to=${D[4]}`,
        `groupId=${G.A}&from=${D[0]}&to=${D[4]}&sort=absences`,
      ]) {
        const r = await get(dir, `${R}/group?${qs}`);
        expect(r.statusCode, qs).toBe(400);
        expect(r.body, qs).not.toContain('no-es-uuid');
      }
      const other = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo ajeno', $1, $2) returning id`,
          [addDays(real, -900), addDays(real, -500)],
        )
      )[0]!.id as string;
      expect((await get(dir, `${groupUrl(G.A!)}&schoolYearId=${other}`)).statusCode).toBe(404);
    });

    it('registrar justificantes (incluso de dias con ausencia) no cambia ningun conteo, lista ni evento', async () => {
      const urlA = groupUrl(G.A!);
      const urlS = studentUrl(S.rep!);
      const fp = await fingerprint();
      const g0 = await get(dir, urlA);
      const s0 = await get(dir, urlS);
      const before = await count(`select count(*)::int n from justification_receipts`);
      for (const d of [D[0], D[1], D[1]]) {
        const r = await post(social, '/school/justifications/receipts', {
          requestId: uuid(),
          studentId: S.rep,
          schoolDate: d,
        });
        expect(r.statusCode, r.body).toBe(201);
      }
      expect(await count(`select count(*)::int n from justification_receipts`)).toBe(before + 3);
      expect(await fingerprint()).toBe(fp);
      expect(volatile(await get(dir, urlA))).toBe(volatile(g0));
      const s1 = await get(dir, urlS);
      expect(volatile(s1)).toBe(volatile(s0));
      expect(s1.json().totals).toMatchObject({ absent: 4 }); // las ausencias SIGUEN siendo ausencias
      expect(g0.body + s1.body).not.toMatch(/justif|folio|JR-/i);
    });

    it('las lecturas del seguimiento no escriben nada (ni listas, ni eventos, ni auditoria de lectura)', async () => {
      const nonAuthz = () =>
        count(`select count(*)::int n from audit_events where event_type not like 'authz.%'`);
      const audits = await nonAuthz();
      const fp = await fingerprint();
      for (const who of [dir, pA, pB])
        for (const url of [`${R}/options`, groupUrl(G.A!), groupUrl(G.B!)]) await get(who, url);
      expect(await fingerprint()).toBe(fp);
      // las lecturas permitidas no auditan (solo las denegadas, `authz.*`, dejan rastro)
      expect(await nonAuthz()).toBe(audits);
    });
  });
}
