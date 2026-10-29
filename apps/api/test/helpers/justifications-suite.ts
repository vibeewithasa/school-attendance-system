import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../../src/modules/auth/session-service.js';
import type { AdminKit, Login } from './admin-http-suite.js';
import { lastDow } from './attendance-suite.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * Pruebas HTTP del registro de RECEPCION de justificantes (Trabajo Social) con Fastify `inject`, un rol de ejecucion NO propietario
 * (PGlite o clúster desechable) y un RELOJ ESCOLAR simulado. Alumnos, cuentas y contrasenas FICTICIOS; nunca contra eta15_dev.
 * Lo que NO debe pasar tambien se prueba: la recepcion no toca la asistencia ni los reportes, no existe aprobacion ni edicion, y la
 * prefectura (aunque tenga `justifications:read` con alcance assigned_groups) no accede.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function defineJustificationTests(kit: AdminKit): void {
  describe('recepcion de justificantes (Trabajo Social)', () => {
    const real = todayIso();
    const W = lastDow(3, 10); // miercoles reciente: el "hoy" escolar simulado
    const clock = { today: W };
    let app: FastifyInstance;
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string> = {};
    let ts: Login; // trabajo social
    let ts2: Login; // otra persona de trabajo social
    let dir: Login;
    let tecnico: Login;
    let acceso: Login;
    let pA: Login; // prefectura con grupo A (y con justifications:read assigned_groups de la semilla)
    let pC: Login; // prefectura sin asignaciones
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await q(sql, params))[0]!.n);
    const get = (login: Login | null, url: string) => kit.call(login, 'GET', url, { target: app });
    const post = (login: Login | null, url: string, body?: unknown, extra = {}) =>
      kit.call(login, 'POST', url, { body, target: app, ...extra });
    const J = '/school/justifications';
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const uuid = () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(700000000000 + n).slice(-12)}`;
    };
    const receiptsCount = () => count(`select count(*)::int n from justification_receipts`);
    const register = (
      login: Login | null,
      studentId: string,
      schoolDate: string,
      requestId = uuid(),
      extra: Record<string, unknown> = {},
    ) => post(login, `${J}/receipts`, { requestId, studentId, schoolDate, ...extra });
    const auditCount = (type: string, outcome?: string) =>
      count(
        `select count(*)::int n from audit_events where event_type = $1 and ($2::text is null or outcome = $2)`,
        [type, outcome ?? null],
      );
    const newStudent = async (
      group: string,
      from: string,
      over: { given?: string; family?: string; code?: string | null; endsOn?: string | null } = {},
    ) => {
      n += 1;
      const st = (
        await q(
          `insert into students (given_names, family_name, school_code) values ($1, $2, $3) returning id`,
          [
            over.given ?? `Alumno${alpha(n)}`,
            over.family ?? `Apellido${alpha(n)}`,
            over.code ?? null,
          ],
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
      if (over.endsOn) {
        await q(`update student_group_assignments set ends_on = $2 where enrollment_id = $1`, [
          en,
          over.endsOn,
        ]);
        await q(`update enrollments set ends_on = $2 where id = $1`, [en, over.endsOn]);
      }
      return st;
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
    /** Huella de TODA la asistencia (listas, renglones y eventos): debe ser identica tras registrar justificantes. */
    const attendanceFingerprint = async () =>
      JSON.stringify([
        await q(
          `select id, status, revision, finalized_at is null as open, attendance_date::text d from attendance_days order by id`,
        ),
        await q(`select id, status, marked_by, marked_at from attendance_records order by id`),
        await q(
          `select id, event_type, old_status, new_status, revision_after from attendance_events order by id`,
        ),
      ]);
    const withoutVolatile = (r: { body: string }) =>
      r.body.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"-"');
    const D1 = addDays(W, -2); // lunes
    const D2 = addDays(W, -1); // martes
    const FUTURE = addDays(W, 1); // jueves (despues del "hoy" simulado)

    it('preparacion: ciclo, grupos, alumnos ficticios, cuentas y una lista de asistencia con una falta (para comprobar que nada cambia)', async () => {
      app = await kit.build({}, { schoolToday: () => clock.today });
      ts = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
      ts2 = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
      dir = await kit.login(kit.boss, app);
      tecnico = await kit.login(kit.techBoss, app);
      acceso = await kit.login(await kit.seed({ role: 'control_acceso' }), app);
      pA = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pC = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo recepcion', $1, $2) returning id`,
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
      S.s1 = await newStudent(G.A!, old, { given: 'Ana', family: 'Ficticia', code: 'JUS-A1' });
      S.s2 = await newStudent(G.A!, old);
      S.s3 = await newStudent(G.B!, old);
      // homonimos en grupos distintos
      S.h1 = await newStudent(G.A!, old, { given: 'Mismo', family: 'Nombre' });
      S.h2 = await newStudent(G.B!, old, { given: 'Mismo', family: 'Nombre' });
      // se incorpora despues de D2
      S.late = await newStudent(G.A!, W);
      // dado de baja: ultimo dia inscrito = D1
      S.gone = await newStudent(G.A!, old, { endsOn: D1 });
      await assignPrefect(pA.account.id, G.A!);
      // una lista de asistencia con una FALTA de s1 en D1 (la abre y la captura la prefecta por la API)
      clock.today = D1;
      const opened = await post(pA, '/school/attendance/days', { groupId: G.A });
      expect(opened.statusCode, opened.body).toBe(201);
      const day = opened.json().day as Json;
      const marks = day.records.map((r: Json) => ({
        studentId: r.studentId,
        status: r.studentId === S.s1 ? 'absent' : 'present',
      }));
      const saved = await post(pA, `/school/attendance/days/${day.id}/marks`, {
        expectedRevision: day.revision,
        requestId: uuid(),
        marks,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      clock.today = W;
    });

    describe('proteccion y autorizacion', () => {
      const routes = () =>
        [
          ['GET', `${J}/students?q=Ana`],
          ['GET', `${J}/receipts`],
          ['GET', `${J}/receipts/${uuid()}`],
          ['POST', `${J}/receipts`],
        ] as const;
      const call = (who: Login | null, m: 'GET' | 'POST', url: string) =>
        m === 'GET'
          ? get(who, url)
          : post(who, url, { requestId: uuid(), studentId: S.s1, schoolDate: D1 });

      it('sin sesion, con cookie invalida o con la sesion caducada: 401 en todas las rutas', async () => {
        for (const [m, url] of routes())
          expect((await call(null, m, url)).statusCode, url).toBe(401);
        const fake: Login = { cookie: 'eta15_sid=invalida', csrf: 'x', account: ts.account };
        for (const [m, url] of routes())
          expect((await call(fake, m, url)).statusCode, url).toBe(401);
        const before = await receiptsCount();
        await q(
          `update sessions set idle_expires_at = now() - interval '1 minute' where user_id = $1 and revoked_at is null`,
          [ts2.account.id],
        );
        for (const [m, url] of routes())
          expect((await call(ts2, m, url)).statusCode, url).toBe(401);
        expect(await receiptsCount()).toBe(before);
        ts2 = await kit.login(ts2.account, app); // nueva sesion para el resto
      });

      it('cuenta deshabilitada: 401 aunque conserve la cookie', async () => {
        const who = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
        expect((await get(who, `${J}/receipts`)).statusCode).toBe(200);
        await q(`update users set status = 'disabled' where id = $1`, [who.account.id]);
        for (const [m, url] of routes())
          expect((await call(who, m, url)).statusCode, url).toBe(401);
      });

      it('prefectura (aunque lea asistencia y tenga justifications:read por grupos), control de acceso y administracion tecnica: 403 y auditado', async () => {
        const denied0 = await auditCount('authz.denied');
        const rows0 = await receiptsCount();
        for (const who of [pA, pC, acceso, tecnico])
          for (const [m, url] of routes())
            expect((await call(who, m, url)).statusCode, `${m} ${url}`).toBe(403);
        expect(await auditCount('authz.denied')).toBe(denied0 + 16);
        expect(await receiptsCount()).toBe(rows0);
      });

      it('Direccion consulta y busca (justifications:read) pero NO registra (403)', async () => {
        expect((await get(dir, `${J}/receipts`)).statusCode).toBe(200);
        expect((await get(dir, `${J}/students?q=Ana`)).statusCode).toBe(200);
        const before = await receiptsCount();
        expect((await register(dir, S.s1!, D1)).statusCode).toBe(403);
        expect(await receiptsCount()).toBe(before);
      });

      it('la creacion exige CSRF y Origin; no existen rutas de aprobar, rechazar, editar ni eliminar', async () => {
        const before = await receiptsCount();
        const body = { requestId: uuid(), studentId: S.s1, schoolDate: D1 };
        expect((await post(ts, `${J}/receipts`, body, { csrf: false })).statusCode).toBe(403);
        expect((await post(ts, `${J}/receipts`, body, { csrf: 'otro-token' })).statusCode).toBe(
          403,
        );
        expect((await post(ts, `${J}/receipts`, body, { origin: false })).statusCode).toBe(403);
        expect(await receiptsCount()).toBe(before);
        const id = uuid();
        for (const [m, url] of [
          ['POST', `${J}/receipts/${id}/approve`],
          ['POST', `${J}/receipts/${id}/reject`],
          ['POST', `${J}/receipts/${id}`],
          ['PATCH', `${J}/receipts/${id}`],
          ['DELETE', `${J}/receipts/${id}`],
        ] as const) {
          const r = await kit.call(ts, m, url, { body: {}, target: app });
          expect([404, 405], `${m} ${url}`).toContain(r.statusCode);
        }
      });
    });

    describe('registro de la recepcion', () => {
      it('registro valido: 201 con folio, estado Recibido, quien lo recibio y la hora del servidor; sin cambios en la asistencia', async () => {
        const fp = await attendanceFingerprint();
        const t0 = Date.now();
        const rid = uuid();
        const r = await register(ts, S.s1!, D1, rid);
        expect(r.statusCode, r.body).toBe(201);
        expect(r.headers['cache-control']).toBe('no-store');
        const b = r.json() as Json;
        expect(b.replayed).toBe(false);
        expect(b.receipt).toMatchObject({
          folio: expect.stringMatching(/^JR-\d{6,}$/),
          status: 'received',
          schoolDate: D1,
          student: { id: S.s1, givenNames: 'Ana', familyName: 'Ficticia' },
          receivedBy: { id: ts.account.id },
        });
        expect(Object.keys(b.receipt).sort()).toEqual([
          'folio',
          'id',
          'receivedAt',
          'receivedBy',
          'schoolDate',
          'status',
          'student',
        ]);
        expect(r.headers.location).toBe(`${J}/receipts/${b.receipt.id}`);
        // la hora la fija el servidor (la base), no el cliente ni el reloj escolar simulado
        const at = Date.parse(b.receipt.receivedAt);
        expect(Math.abs(at - t0)).toBeLessThan(60_000);
        // auditado: actor, alumno, fecha, folio y solicitud; sin nombres
        const ev = await q(
          `select actor_user_id, outcome, details from audit_events where event_type = 'justification.receipt_registered'`,
        );
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ actor_user_id: ts.account.id, outcome: 'success' });
        expect(ev[0]!.details).toMatchObject({
          receiptId: b.receipt.id,
          folio: b.receipt.folio,
          studentId: S.s1,
          schoolDate: D1,
          requestId: rid,
        });
        expect(JSON.stringify(ev[0]!.details)).not.toMatch(/Ana|Ficticia/);
        // la asistencia (incluida la FALTA de ese dia) sigue exactamente igual
        expect(await attendanceFingerprint()).toBe(fp);
      });

      it('reintento identico y doble clic: el mismo registro (200, replayed), sin segundo folio ni segunda auditoria', async () => {
        const rid = uuid();
        const first = await register(ts, S.s2!, D1, rid);
        expect(first.statusCode).toBe(201);
        const rows = await receiptsCount();
        const audits = await auditCount('justification.receipt_registered');
        const again = await register(ts, S.s2!, D1, rid);
        expect(again.statusCode).toBe(200);
        expect(again.json().replayed).toBe(true);
        expect(again.json().receipt).toEqual(first.json().receipt);
        // cinco envios simultaneos con la misma clave: un solo registro
        const rid2 = uuid();
        const burst = await Promise.all(
          Array.from({ length: 5 }, () => register(ts, S.s3!, D1, rid2)),
        );
        expect(burst.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
        expect(new Set(burst.map((r) => r.json().receipt.id)).size).toBe(1);
        expect(await receiptsCount()).toBe(rows + 1);
        expect(await auditCount('justification.receipt_registered')).toBe(audits + 1);
      });

      it('la misma clave con otro alumno u otra fecha: 409, auditado y sin registro nuevo; la clave de otra cuenta no se reconoce', async () => {
        const rid = uuid();
        expect((await register(ts, S.s1!, D2, rid)).statusCode).toBe(201);
        const rows = await receiptsCount();
        const mism = await auditCount('justification.idempotency_mismatch', 'failure');
        for (const [st, d] of [
          [S.s2!, D2],
          [S.s1!, D1],
        ] as const) {
          const r = await register(ts, st, d, rid);
          expect([r.statusCode, r.json().error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        }
        expect(await receiptsCount()).toBe(rows);
        expect(await auditCount('justification.idempotency_mismatch', 'failure')).toBe(mism + 2);
        // otra persona con la MISMA clave: es otra solicitud (no se filtra que existe) y crea su propio registro
        const other = await register(ts2, S.s2!, D2, rid);
        expect(other.statusCode).toBe(201);
        expect(other.json().receipt.receivedBy.id).toBe(ts2.account.id);
        expect(await receiptsCount()).toBe(rows + 1);
      });

      it('varios documentos del mismo alumno y fecha son validos (sin UNIQUE alumno + fecha) y reciben folios distintos y crecientes', async () => {
        const a = (await register(ts, S.s2!, D2)).json().receipt;
        const b = (await register(ts, S.s2!, D2)).json().receipt;
        const c = (await register(ts2, S.s2!, D2)).json().receipt;
        expect(new Set([a.folio, b.folio, c.folio]).size).toBe(3);
        const num = (f: string) => Number(f.slice(3));
        expect(num(b.folio)).toBeGreaterThan(num(a.folio));
        expect(num(c.folio)).toBeGreaterThan(num(b.folio));
        expect(
          await count(
            `select count(*)::int n from justification_receipts where student_id = $1 and school_date = $2`,
            [S.s2, D2],
          ),
        ).toBeGreaterThanOrEqual(3);
      });

      it('un justificante de un dia SIN lista de asistencia y de un alumno SIN falta se registra igual (no hace falta una marca ausente)', async () => {
        const noList = await register(ts, S.s3!, D2); // B no tiene lista ese dia
        expect(noList.statusCode, noList.body).toBe(201);
        const present = await register(ts, S.s2!, D1); // s2 estuvo presente
        expect(present.statusCode, present.body).toBe(201);
        expect(
          await count(`select count(*)::int n from attendance_days where group_id = $1`, [G.B]),
        ).toBe(0);
      });

      it('fecha escolar: fin de semana, futura, malformada o inexistente -> rechazada sin dejar rastro', async () => {
        const rows = await receiptsCount();
        const sat = addDays(W, -4); // sabado
        const sun = addDays(W, -3);
        for (const [d, code] of [
          [sat, 'NOT_SCHOOL_DAY'],
          [sun, 'NOT_SCHOOL_DAY'],
          [FUTURE, 'DATE_IN_FUTURE'],
        ] as const) {
          const r = await register(ts, S.s1!, d);
          expect([r.statusCode, r.json().error.code], d).toEqual([400, code]);
        }
        for (const d of ['2026-02-30', '2026-13-01', 'ayer', '', '2026-1-1', '28/10/2026']) {
          const r = await register(ts, S.s1!, d);
          expect(r.statusCode, d).toBe(400);
          expect(r.body).not.toContain('ayer');
        }
        expect(await receiptsCount()).toBe(rows);
      });

      it('alumno: inexistente -> 404; sin matricula en esa fecha (antes de inscribirse o despues de la baja) -> 400; dentro de su matricula, aunque ya este de baja -> 201', async () => {
        const rows = await receiptsCount();
        const none = await register(ts, '00000000-0000-4000-8000-00000000dead', D1);
        expect([none.statusCode, none.json().error.code]).toEqual([404, 'STUDENT_NOT_FOUND']);
        const early = await register(ts, S.late!, D1); // se inscribio despues
        expect([early.statusCode, early.json().error.code]).toEqual([400, 'NOT_ENROLLED_ON_DATE']);
        const after = await register(ts, S.gone!, D2); // baja con ultimo dia = D1
        expect([after.statusCode, after.json().error.code]).toEqual([400, 'NOT_ENROLLED_ON_DATE']);
        expect(await receiptsCount()).toBe(rows);
        const within = await register(ts, S.gone!, D1);
        expect(within.statusCode, within.body).toBe(201);
      });

      it('entradas manipuladas: campos que el cliente no debe enviar (hora, actor, folio, estado, motivo), ids invalidos o cuerpo vacio -> 400', async () => {
        const rows = await receiptsCount();
        const base = { requestId: uuid(), studentId: S.s1, schoolDate: D1 };
        for (const extra of [
          { receivedAt: '2000-01-01T00:00:00Z' },
          { receivedBy: ts2.account.id },
          { folio: 'JR-000001' },
          { status: 'approved' },
          { reason: 'cita medica' },
          { diagnosis: 'x' },
          { schoolYearId: Y.cur },
        ]) {
          const r = await post(ts, `${J}/receipts`, { ...base, ...extra });
          expect(r.statusCode, JSON.stringify(extra)).toBe(400);
          expect(r.body).not.toMatch(/cita medica/);
        }
        for (const body of [
          {},
          { ...base, requestId: 'no-es-uuid' },
          { ...base, studentId: 'no-es-uuid' },
          { ...base, studentId: undefined },
          { ...base, schoolDate: undefined },
          { ...base, requestId: undefined },
          [],
        ])
          expect((await post(ts, `${J}/receipts`, body)).statusCode, JSON.stringify(body)).toBe(
            400,
          );
        expect(await receiptsCount()).toBe(rows);
      });
    });

    describe('consulta', () => {
      it('lista paginada, mas reciente primero, con filtros por alumno y por rango de fecha escolar', async () => {
        const all = (await get(ts, `${J}/receipts?pageSize=50`)).json() as Json;
        expect(all.total).toBeGreaterThanOrEqual(8);
        const stamps = all.items.map((i: Json) => i.receivedAt);
        expect([...stamps].sort().reverse()).toEqual(stamps);
        const p1 = (await get(ts, `${J}/receipts?pageSize=3&page=1`)).json() as Json;
        const p2 = (await get(ts, `${J}/receipts?pageSize=3&page=2`)).json() as Json;
        expect([p1.items.length, p1.page, p1.pageSize, p1.total]).toEqual([3, 1, 3, all.total]);
        expect(
          p1.items
            .map((i: Json) => i.id)
            .filter((id: string) => p2.items.some((j: Json) => j.id === id)),
        ).toEqual([]);
        const mine = (await get(dir, `${J}/receipts?studentId=${S.s1}&pageSize=50`)).json() as Json;
        expect(mine.items.every((i: Json) => i.student.id === S.s1)).toBe(true);
        expect(mine.total).toBeGreaterThanOrEqual(2);
        const day = (await get(ts, `${J}/receipts?from=${D1}&to=${D1}&pageSize=50`)).json() as Json;
        expect(day.items.every((i: Json) => i.schoolDate === D1)).toBe(true);
        const both = (
          await get(ts, `${J}/receipts?studentId=${S.s1}&from=${D2}&to=${D2}`)
        ).json() as Json;
        expect(both.items.every((i: Json) => i.student.id === S.s1 && i.schoolDate === D2)).toBe(
          true,
        );
        const none = (await get(ts, `${J}/receipts?studentId=${S.late}`)).json() as Json;
        expect([none.items, none.total]).toEqual([[], 0]);
      });

      it('parametros invalidos -> 400 sin repetir la entrada', async () => {
        for (const qs of [
          'page=0',
          'page=abc',
          'pageSize=51',
          'pageSize=0',
          'studentId=no-es-uuid',
          'from=2026-02-30',
          `from=${D2}&to=${D1}`,
          'actorId=x',
          'status=approved',
        ]) {
          const r = await get(ts, `${J}/receipts?${qs}`);
          expect(r.statusCode, qs).toBe(400);
          expect(r.body, qs).not.toContain('no-es-uuid');
        }
      });

      it('consulta individual (auditada); inexistente -> 404; id invalido -> 400', async () => {
        const id = (await get(ts, `${J}/receipts?pageSize=1`)).json().items[0].id as string;
        const views = await auditCount('justification.receipt_viewed');
        const r = await get(dir, `${J}/receipts/${id}`);
        expect(r.statusCode).toBe(200);
        expect(r.json().id).toBe(id);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(await auditCount('justification.receipt_viewed')).toBe(views + 1);
        expect(
          (await get(ts, `${J}/receipts/00000000-0000-4000-8000-00000000dead`)).statusCode,
        ).toBe(404);
        expect((await get(ts, `${J}/receipts/no-es-uuid`)).statusCode).toBe(400);
        expect((await get(ts, `${J}/receipts/${id}?x=1`)).statusCode).toBe(400);
      });

      it('busqueda de alumno: datos minimos, homonimos distinguibles por grupo, minimo de letras, limite y sin filtrar lo escrito en la auditoria', async () => {
        const r = await get(ts, `${J}/students?q=${encodeURIComponent('Mismo Nombre')}`);
        expect(r.statusCode, r.body).toBe(200);
        const b = r.json() as Json;
        expect(b.truncated).toBe(false);
        expect(b.items).toHaveLength(2);
        expect(Object.keys(b.items[0]).sort()).toEqual([
          'currentGroup',
          'familyName',
          'givenNames',
          'id',
          'schoolCode',
        ]);
        expect(b.items.map((i: Json) => i.currentGroup.code).sort()).toEqual(['A', 'B']);
        expect(JSON.stringify(b)).not.toMatch(/birth|curp|tutor|diagnos/i);
        // por codigo escolar y por apellido, sin distinguir mayusculas
        expect(
          (await get(ts, `${J}/students?q=jus-a1`)).json().items.map((i: Json) => i.id),
        ).toEqual([S.s1]);
        expect(
          (await get(ts, `${J}/students?q=${encodeURIComponent('FICTICIA')}`)).json().items[0].id,
        ).toBe(S.s1);
        // minimo 3 letras; caracteres comodin literales
        for (const qs of ['q=ab', 'q=', 'q=%20%20%20', ''])
          expect((await get(ts, `${J}/students?${qs}`)).statusCode, qs).toBe(400);
        expect(
          (await get(ts, `${J}/students?q=${encodeURIComponent('%%%')}`)).json().items,
        ).toEqual([]);
        expect((await get(ts, `${J}/students?q=Ana&x=1`)).statusCode).toBe(400);
        // la auditoria anota el conteo, no el texto buscado ni nombres
        const ev = await q(
          `select details from audit_events where event_type = 'justification.students_searched' order by occurred_at desc limit 5`,
        );
        expect(ev.length).toBeGreaterThan(0);
        expect(JSON.stringify(ev)).not.toMatch(/Mismo|Nombre|FICTICIA|jus-a1|Ana/i);
        expect(Object.keys(ev[0]!.details as object).sort()).toEqual(['resultCount', 'truncated']);
      });

      it('busqueda: maximo 20 resultados y marca de recorte', async () => {
        for (let i = 0; i < 22; i += 1)
          await newStudent(G.B!, addDays(real, -300), {
            given: `Masivo${alpha(i + 1000)}`,
            family: 'Prueba',
          });
        const r = (await get(ts, `${J}/students?q=Masivo`)).json() as Json;
        expect([r.items.length, r.truncated]).toEqual([20, true]);
      });
    });

    describe('independencia de la asistencia y de los reportes', () => {
      it('registrar justificantes (incluso para el dia de una FALTA) no cambia listas, renglones, historial ni los reportes', async () => {
        const reportG = `/school/attendance/reports/group?groupId=${G.A}&from=${D1}&to=${W}`;
        const reportS = `/school/attendance/reports/student/${S.s1}?schoolYearId=${Y.cur}&from=${D1}&to=${W}`;
        const fp = await attendanceFingerprint();
        const g0 = await get(dir, reportG);
        const s0 = await get(dir, reportS);
        expect(g0.statusCode, g0.body).toBe(200);
        expect(s0.json().days[0]).toMatchObject({ date: D1, state: 'absent' });
        const before = await receiptsCount();
        for (let i = 0; i < 3; i += 1) expect((await register(ts, S.s1!, D1)).statusCode).toBe(201);
        expect((await register(ts2, S.s1!, D2)).statusCode).toBe(201);
        expect(await receiptsCount()).toBe(before + 4);
        expect(await attendanceFingerprint()).toBe(fp);
        expect(withoutVolatile(await get(dir, reportG))).toBe(withoutVolatile(g0));
        const s1 = await get(dir, reportS);
        expect(withoutVolatile(s1)).toBe(withoutVolatile(s0));
        expect(s1.json().days[0]).toMatchObject({ date: D1, state: 'absent' }); // la falta SIGUE siendo falta
        expect(s1.json().totals).toMatchObject({ absent: 1 });
        // ni los reportes ni la asistencia mencionan justificantes
        expect(s1.body + g0.body).not.toMatch(/justif|folio|JR-/i);
      });

      it('la base impide que un justificante toque la asistencia: no hay FK ni columna que los relacione', async () => {
        const cols = await q(
          `select column_name c from information_schema.columns where table_name = 'justification_receipts' order by ordinal_position`,
        );
        expect(cols.map((c) => c.c)).toEqual([
          'id',
          'folio_number',
          'folio',
          'student_id',
          'school_year_id',
          'school_date',
          'status',
          'received_by',
          'received_at',
          'request_id',
          'payload_hash',
        ]);
        const fks = await q(
          `select confrelid::regclass::text t from pg_constraint where conrelid = 'justification_receipts'::regclass and contype = 'f' order by 1`,
        );
        expect(fks.map((f) => f.t)).toEqual(['enrollments', 'users']);
      });
    });

    describe('integridad en la base (propietario)', () => {
      const owner = (sql: string, params: unknown[] = []) => q(sql, params);
      it('el registro es inmutable: UPDATE, DELETE y TRUNCATE se rechazan incluso para el propietario', async () => {
        const id = (await q(`select id from justification_receipts limit 1`))[0]!.id as string;
        for (const sql of [
          `update justification_receipts set school_date = school_date where id = '${id}'`,
          `update justification_receipts set status = 'received' where id = '${id}'`,
          `delete from justification_receipts where id = '${id}'`,
          `truncate justification_receipts`,
        ])
          await expect(owner(sql), sql).rejects.toMatchObject({ code: '42501' });
      });

      it('el propietario tampoco puede insertar estados distintos de "received", fines de semana, fechas futuras ni fuera de la matricula; folio y hora los fija la base', async () => {
        const base = [S.s2, Y.cur, D1, ts.account.id] as const;
        const ins = (date: string, status = 'received', student = S.s2) =>
          owner(
            `insert into justification_receipts (student_id, school_year_id, school_date, received_by, request_id, payload_hash, status)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [student, Y.cur, date, ts.account.id, uuid(), 'a'.repeat(64), status],
          );
        void base;
        await expect(ins(D1, 'approved')).rejects.toMatchObject({
          code: '23514',
          constraint: 'jr_status',
        });
        await expect(ins(addDays(W, -4))).rejects.toMatchObject({
          code: '23514',
          constraint: 'jr_weekday',
        });
        // futura segun la hora REAL de la base (el reloj escolar simulado solo existe en el servicio)
        let nextWeekday = addDays(real, 2);
        while ([0, 6].includes(new Date(`${nextWeekday}T00:00:00Z`).getUTCDay()))
          nextWeekday = addDays(nextWeekday, 1);
        await expect(ins(nextWeekday)).rejects.toMatchObject({
          code: '23514',
          constraint: 'jr_not_future',
        });
        await expect(ins(D1, 'received', S.late)).rejects.toMatchObject({
          code: '23514',
          constraint: 'jr_enrolled_on_date',
        });
        // hora y folio: aunque el propietario los pida, la base manda
        const row = (
          await owner(
            `insert into justification_receipts (student_id, school_year_id, school_date, received_by, request_id, payload_hash, received_at, folio)
             values ($1, $2, $3, $4, $5, $6, '2000-01-01T00:00:00Z', 'JR-999999') returning received_at, folio, folio_number`,
            [S.s2, Y.cur, D1, ts.account.id, uuid(), 'b'.repeat(64)],
          )
        )[0]!;
        expect(Date.parse(String(row.received_at as string))).toBeGreaterThan(
          Date.parse('2020-01-01'),
        );
        expect(row.folio).toBe(`JR-${String(row.folio_number).padStart(6, '0')}`);
        await expect(
          owner(
            `insert into justification_receipts (student_id, school_year_id, school_date, received_by, request_id, payload_hash, folio_number) overriding user value values ($1,$2,$3,$4,$5,$6, 1)`,
            [S.s2, Y.cur, D1, ts.account.id, uuid(), 'c'.repeat(64)],
          ),
        ).resolves.toBeDefined(); // OVERRIDING USER VALUE ignora el valor: la identidad sigue mandando
        // la matricula de OTRO ciclo (o inexistente) no sirve: la rechaza el trigger antes que la FK
        await expect(
          owner(
            `insert into justification_receipts (student_id, school_year_id, school_date, received_by, request_id, payload_hash)
             values ($1, '00000000-0000-4000-8000-00000000dead', $2, $3, $4, $5)`,
            [S.s2, D1, ts.account.id, uuid(), 'd'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'jr_enrolled_on_date' });
      });

      it('RBAC de la semilla: justifications:create solo para trabajo social (all); direccion lee; prefectura conserva su concesion historica pero el modulo no la acepta', async () => {
        const rows = await q(
          `select r.key role, p.key perm, rp.scope from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
            where p.key like 'justifications:%' order by 1, 2`,
        );
        expect(rows.map((x) => `${x.role}|${x.perm}|${x.scope}`)).toEqual([
          'direccion|justifications:read|all',
          'prefectura|justifications:read|assigned_groups',
          'trabajo_social|justifications:create|all',
          'trabajo_social|justifications:manage|all',
          'trabajo_social|justifications:read|all',
        ]);
      });
    });

    describe('fallos de la base y atomicidad', () => {
      /** Almacen que hace fallar UNA vez la primera sentencia que cumpla la condicion (simula un corte o un error de la base). */
      const failingStore = (
        when: (sql: string, params?: unknown[]) => boolean,
        error: Error,
      ): SessionStore => {
        let armed = true;
        return {
          transaction: (fn) =>
            kit.harness.store.transaction((tx) =>
              fn({
                query: async (sql, params) => {
                  if (armed && when(sql, params)) {
                    armed = false;
                    throw error;
                  }
                  return tx.query(sql, params);
                },
              }),
            ),
        };
      };

      it('si la auditoria falla, NO queda el registro (misma transaccion) y el reintento con la misma clave lo crea', async () => {
        const broken = await kit.build(
          {},
          {
            schoolToday: () => clock.today,
            store: failingStore(
              (sql, params) =>
                sql.includes('INSERT INTO audit_events') &&
                params?.[0] === 'justification.receipt_registered',
              Object.assign(new Error('boom: detalle interno secreto'), { code: '57P01' }),
            ),
          },
        );
        const login = await kit.login(ts.account, broken);
        const rows = await receiptsCount();
        const rid = uuid();
        const body = { requestId: rid, studentId: S.s2, schoolDate: D1 };
        const bad = await post(login, `${J}/receipts`, body, { target: broken });
        expect([bad.statusCode, bad.json().error.code]).toEqual([503, 'DATABASE_UNAVAILABLE']);
        expect(bad.body).not.toMatch(/boom|secreto/);
        expect(await receiptsCount()).toBe(rows); // nada quedo a medias
        const ok = await post(login, `${J}/receipts`, body, { target: broken });
        expect([ok.statusCode, ok.json().replayed]).toEqual([201, false]);
        expect(await receiptsCount()).toBe(rows + 1);
      });

      it('un error inesperado de la base responde 500 generico, sin detalles internos', async () => {
        const broken = await kit.build(
          {},
          {
            schoolToday: () => clock.today,
            store: failingStore(
              (sql) => sql.includes('INSERT INTO justification_receipts'),
              Object.assign(new Error('relation secreta rota en la linea 7'), { code: 'XX000' }),
            ),
          },
        );
        const login = await kit.login(ts.account, broken);
        const rows = await receiptsCount();
        const bad = await post(
          login,
          `${J}/receipts`,
          { requestId: uuid(), studentId: S.s2, schoolDate: D1 },
          { target: broken },
        );
        expect(bad.statusCode).toBe(500);
        expect(bad.body).not.toMatch(/secreta|linea 7|XX000/);
        expect(await receiptsCount()).toBe(rows);
      });

      it('los registros de la aplicacion no contienen nombres de menores, folios con datos personales ni claves de envio', async () => {
        const leaked = kit.logs.filter((l) => /Ana|Ficticia|JUS-A1|Mismo|Masivo/.test(l));
        expect(leaked).toEqual([]);
      });
    });
  });
}
