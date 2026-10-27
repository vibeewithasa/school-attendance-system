import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AdminKit, Login } from './admin-http-suite.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * Pruebas HTTP de la asistencia diaria con Fastify `inject`, un rol de ejecucion NO propietario (PGlite o clúster desechable) y un
 * RELOJ ESCOLAR simulado (`schoolToday`) para recorrer lunes a domingo y la medianoche sin depender del dia en que se ejecute la
 * prueba. Datos, cuentas y contrasenas FICTICIOS; nunca contra eta15_dev.
 * Las asignaciones de prefectura no se pueden retroceder desde la API (sin retroactividad), asi que las fixtures las siembra el
 * propietario con el trigger de alta desactivado un instante: equivale a que las asignaciones existian desde hace meses.
 * `mode: 'unavailable'` reproduce una base SIN los privilegios 0005: la asistencia responde 503 controlado y no cambia nada.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const isodow = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** Ultimo dia con ese dia de la semana (1 = lunes ... 7 = domingo) al menos `minAgo` dias antes de hoy. */
export function lastDow(dow: number, minAgo = 10): string {
  let d = addDays(todayIso(), -minAgo);
  while (isodow(d) !== dow) d = addDays(d, -1);
  return d;
}

export function defineAttendanceTests(
  kit: AdminKit,
  opts: { mode: 'full' | 'unavailable' } = { mode: 'full' },
): void {
  describe(`asistencia diaria (${opts.mode === 'full' ? 'con privilegios 0005' : 'sin privilegios: modulo no habilitado'})`, () => {
    const real = todayIso();
    const W = lastDow(3, 10); // miercoles reciente: el "hoy" escolar de casi toda la suite
    const clock = { today: W };
    let app: FastifyInstance;
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string[]> = {};
    let dir: Login;
    let tecnico: Login;
    let social: Login;
    let acceso: Login;
    let pA: Login;
    let pB: Login;
    let pC: Login;
    let pD: Login;
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const get = (login: Login | null, url: string) => kit.call(login, 'GET', url, { target: app });
    const post = (login: Login | null, url: string, body?: unknown, extra = {}) =>
      kit.call(login, 'POST', url, { body, target: app, ...extra });
    const body = (r: { json: () => unknown }) => r.json() as Json;
    const auditCount = async (type: string, outcome?: string) =>
      Number(
        (
          await q(
            `select count(*)::int n from audit_events where event_type = $1 and ($2::text is null or outcome = $2)`,
            [type, outcome ?? null],
          )
        )[0]!.n,
      );
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await q(sql, params))[0]!.n);
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const uuid = () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(900000000000 + n).slice(-12)}`;
    };
    const open = (login: Login, groupId: string, extra = {}) =>
      post(login, '/school/attendance/days', { groupId, ...extra });
    const save = (
      login: Login,
      dayId: string,
      expectedRevision: number,
      marks: Array<{ studentId: string; status: string }>,
      requestId = uuid(),
    ) =>
      post(login, `/school/attendance/days/${dayId}/marks`, { expectedRevision, requestId, marks });
    const finalize = (login: Login, dayId: string, expectedRevision: number) =>
      post(login, `/school/attendance/days/${dayId}/finalize`, { expectedRevision });
    const markAll = (studentIds: string[], status = 'present') =>
      studentIds.map((studentId) => ({ studentId, status }));
    const stripId = (r: { body: string }) => r.body.replace(/"requestId":"[^"]*"/, '');

    /** Alumno ficticio con matricula desde `from` y asignacion a `group`. */
    const newStudent = async (group: string, year = Y.cur!, from = addDays(real, -300)) => {
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
          [st, year, from],
        )
      )[0]!.id as string;
      const asg = (
        await q(
          `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4) returning id`,
          [en, year, group, from],
        )
      )[0]!.id as string;
      return { student: st, enrollment: en, assignment: asg };
    };
    const newGroup = async (code: string, grade = 1, active = true) =>
      (
        await q(
          `insert into groups (school_year_id, grade, code, is_active) values ($1, $2, $3, $4) returning id`,
          [Y.cur, grade, code, active],
        )
      )[0]!.id as string;
    /** Asignacion de prefectura "desde hace meses" (el trigger de alta impide la retroactividad desde la API). */
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

    it('preparacion: ciclo, grupos, alumnos ficticios, prefectas con asignaciones antiguas y el reloj escolar', async () => {
      app = await kit.build({}, { schoolToday: () => clock.today });
      dir = await kit.login(kit.boss, app);
      tecnico = await kit.login(kit.techBoss, app);
      social = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
      acceso = await kit.login(await kit.seed({ role: 'control_acceso' }), app);
      pA = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pB = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      pC = await kit.login(await kit.seed({ role: 'prefectura' }), app); // sin asignaciones
      pD = await kit.login(await kit.seed({ role: 'prefectura' }), app);
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo asistencia', $1, $2) returning id`,
          [addDays(real, -400), addDays(real, 300)],
        )
      )[0]!.id as string;
      G.A = await newGroup('A');
      G.B = await newGroup('B');
      G.C = await newGroup('C'); // sin alumnos
      G.off = await newGroup('OFF', 1, false);
      for (const key of ['A', 'B']) {
        S[key] = [];
        for (let i = 0; i < (key === 'A' ? 4 : 3); i += 1)
          S[key]!.push((await newStudent(G[key]!)).student);
      }
      await assignPrefect(pA.account.id, G.A!);
      await assignPrefect(pA.account.id, G.B!);
      await assignPrefect(pB.account.id, G.A!); // cobertura compartida del grupo A
      await assignPrefect(pD.account.id, G.B!);
      expect(isodow(W)).toBe(3);
    });

    describe('proteccion de la API', () => {
      const ROUTES = (day: string) =>
        [
          ['GET', '/school/attendance/today'],
          ['GET', '/school/attendance/days'],
          ['GET', `/school/attendance/days/${day}`],
          ['GET', `/school/attendance/days/${day}/events`],
          ['POST', '/school/attendance/days'],
          ['POST', `/school/attendance/days/${day}/marks`],
          ['POST', `/school/attendance/days/${day}/finalize`],
        ] as const;
      const SOME = '00000000-0000-4000-8000-000000000001';

      it('sin sesion: 401 en todas las rutas', async () => {
        for (const [m, url] of ROUTES(SOME))
          expect((await kit.call(null, m, url, { target: app })).statusCode, `${m} ${url}`).toBe(
            401,
          );
      });

      it('admin_tecnico, trabajo social y control de acceso: 403 en todo (trabajo social ya no lee asistencia) y queda auditado', async () => {
        const denied0 = await auditCount('authz.denied');
        const valid = (url: string) =>
          url.endsWith('/marks')
            ? {
                expectedRevision: 1,
                requestId: uuid(),
                marks: [{ studentId: S.A![0], status: 'present' }],
              }
            : url.endsWith('/finalize')
              ? { expectedRevision: 1 }
              : { groupId: G.A };
        for (const who of [tecnico, social, acceso])
          for (const [m, url] of ROUTES(SOME)) {
            const r = m === 'GET' ? await get(who, url) : await post(who, url, valid(url));
            expect(r.statusCode, `${m} ${url}`).toBe(403);
          }
        expect(await auditCount('authz.denied')).toBeGreaterThan(denied0);
        expect(await count(`select count(*)::int n from attendance_days`)).toBe(0);
      });

      it('mutaciones sin CSRF o sin Origin permitido: 403 y sin cambios', async () => {
        const payload = { groupId: G.A };
        expect(
          (await post(pA, '/school/attendance/days', payload, { csrf: false })).statusCode,
        ).toBe(403);
        expect(
          (await post(pA, '/school/attendance/days', payload, { csrf: 'incorrecto' })).statusCode,
        ).toBe(403);
        expect(
          (await post(pA, '/school/attendance/days', payload, { origin: false })).statusCode,
        ).toBe(403);
        expect(await count(`select count(*)::int n from attendance_days`)).toBe(0);
      });

      it('cuerpos y consultas estrictos: campos extra (actor, usuario, hora), fechas y uuid invalidos, duplicados y lotes enormes: 400', async () => {
        for (const bad of [
          { groupId: G.A, actorId: pA.account.id },
          { groupId: G.A, userId: pA.account.id },
          { groupId: G.A, createdBy: pA.account.id },
          { groupId: G.A, attendanceDate: '2026-13-40' },
          { groupId: G.A, attendanceDate: 'hoy' },
          { groupId: 'no-es-uuid' },
          {},
        ])
          expect(
            (await post(pA, '/school/attendance/days', bad)).statusCode,
            JSON.stringify(bad),
          ).toBe(400);
        const day = SOME;
        const st = { studentId: S.A![0], status: 'present' };
        for (const bad of [
          { expectedRevision: 1, requestId: uuid(), marks: [] },
          { expectedRevision: 0, requestId: uuid(), marks: [st] },
          { expectedRevision: 1, requestId: 'x', marks: [st] },
          { expectedRevision: 1, requestId: uuid(), marks: [st, st] },
          { expectedRevision: 1, requestId: uuid(), marks: [{ ...st, status: 'pending' }] },
          { expectedRevision: 1, requestId: uuid(), marks: [{ ...st, status: 'late' }] },
          { expectedRevision: 1, requestId: uuid(), marks: [{ ...st, markedAt: '2026-01-01' }] },
          { expectedRevision: 1, requestId: uuid(), marks: [st], actorId: pA.account.id },
          {
            expectedRevision: 1,
            requestId: uuid(),
            marks: Array.from({ length: 201 }, () => ({ studentId: uuid(), status: 'present' })),
          },
        ])
          expect((await post(pA, `/school/attendance/days/${day}/marks`, bad)).statusCode).toBe(
            400,
          );
        expect(
          (
            await post(pA, `/school/attendance/days/${day}/finalize`, {
              expectedRevision: 1,
              force: true,
            })
          ).statusCode,
        ).toBe(400);
        expect((await post(pA, `/school/attendance/days/${day}/finalize`, {})).statusCode).toBe(
          400,
        );
        for (const url of [
          '/school/attendance/days?page=0',
          '/school/attendance/days?status=otra',
          '/school/attendance/days?groupId=1',
          '/school/attendance/days?from=2026-02-30',
          `/school/attendance/days?from=${W}&to=${addDays(W, -3)}`,
          '/school/attendance/days/no-es-uuid',
          '/school/attendance/today?groupId=1',
        ])
          expect((await get(pA, url)).statusCode, url).toBe(400);
        // no existe DELETE ni ruta de correccion
        expect(
          (await kit.call(dir, 'DELETE', `/school/attendance/days/${SOME}`, { target: app }))
            .statusCode,
        ).toBe(404);
        expect((await post(dir, `/school/attendance/days/${SOME}/correct`, {})).statusCode).toBe(
          404,
        );
      });
    });

    if (opts.mode === 'unavailable') {
      it('sin privilegios 0005: responde 503 controlado, sin detalles SQL, y no cambia nada', async () => {
        for (const r of [
          await get(pA, '/school/attendance/today'),
          await get(pA, '/school/attendance/days'),
          await get(dir, '/school/attendance/days'),
          await open(pA, G.A!),
        ]) {
          expect(r.statusCode, r.body).toBe(503);
          expect(body(r).error.code).toBe('ATTENDANCE_UNAVAILABLE');
          expect(r.body).not.toMatch(/permission denied|attendance_days|SQLSTATE/i);
        }
        expect(await count(`select count(*)::int n from attendance_days`)).toBe(0);
        // los demas modulos siguen funcionando
        expect((await get(dir, '/school/students')).statusCode).toBe(200);
      });
      return;
    }

    describe('grupos del dia', () => {
      it('la prefecta ve solo sus grupos; sin asignaciones, ninguno; Direccion supervisa todos sin poder capturar', async () => {
        const a = body(await get(pA, '/school/attendance/today'));
        expect(a).toMatchObject({ schoolToday: W, isSchoolDay: true });
        expect(a.groups.map((x: Json) => x.group.code)).toEqual(['A', 'B']);
        expect(a.groups.every((x: Json) => x.canCapture === true && x.day === null)).toBe(true);
        expect(
          body(await get(pD, '/school/attendance/today')).groups.map((x: Json) => x.group.code),
        ).toEqual(['B']);
        expect(body(await get(pC, '/school/attendance/today')).groups).toEqual([]);
        const d = body(await get(dir, '/school/attendance/today'));
        expect(d.groups.map((x: Json) => x.group.code)).toEqual(['A', 'B', 'C']); // activos del ciclo
        expect(d.groups.every((x: Json) => x.canCapture === false)).toBe(true);
      });
    });

    describe('fechas escolares (America/Mazatlan): la fecha la decide el servidor', () => {
      it('lunes a viernes se abre lista a cualquier hora; sabado y domingo, no', async () => {
        const created: string[] = [];
        for (const dow of [1, 2, 3, 4, 5, 6, 7]) {
          clock.today = lastDow(dow, 10);
          const g = await newGroup(`D${dow}`, 2);
          await newStudent(g);
          await assignPrefect(pA.account.id, g);
          const t = body(await get(pA, '/school/attendance/today'));
          expect(t).toMatchObject({ schoolToday: clock.today, isSchoolDay: dow <= 5 });
          const r = await open(pA, g);
          if (dow <= 5) {
            expect(r.statusCode, r.body).toBe(201);
            expect(body(r).day.attendanceDate).toBe(clock.today);
            created.push(body(r).day.id);
          } else {
            expect([r.statusCode, body(r).error.code]).toEqual([409, 'NOT_SCHOOL_DAY']);
            expect(
              await count(`select count(*)::int n from attendance_days where group_id = $1`, [g]),
            ).toBe(0);
          }
        }
        clock.today = W;
        expect(created).toHaveLength(5);
        // la base tambien lo impide aunque se saltara la API
        const wk = lastDow(6, 10);
        const e = await kit.harness
          .owner(
            `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3::date, $4)`,
            [Y.cur, G.C, wk, kit.boss.id],
          )
          .then(
            () => 'ok',
            (x: { constraint?: string }) => x.constraint,
          );
        expect(e).toBe('att_days_weekday');
      });

      it('sin reloj inyectado el servidor usa el dia de America/Mazatlan (decidido por la base, no por el cliente ni el proceso)', async () => {
        const plain = kit.app();
        const l = await kit.login(kit.boss, plain);
        const r = await kit.call(l, 'GET', '/school/attendance/today', { target: plain });
        expect(r.statusCode).toBe(200);
        const t = body(r);
        const expected = todayIso();
        // (solo difiere si la prueba cruza la medianoche de Mazatlan justo entre las dos lecturas)
        expect([expected, addDays(expected, 1)]).toContain(t.schoolToday);
        expect(t.isSchoolDay).toBe(isodow(t.schoolToday) <= 5);
      });

      it('una fecha enviada por el cliente nunca se acepta: futura, pasada o falsa => 400 DATE_NOT_TODAY y nada se crea', async () => {
        const before = await count(`select count(*)::int n from attendance_days`);
        for (const attendanceDate of [
          addDays(W, 1),
          addDays(W, -1),
          addDays(W, -7),
          '2020-01-01',
          '2999-12-31',
        ]) {
          const r = await open(pA, G.A!, { attendanceDate });
          expect([r.statusCode, body(r).error.code], attendanceDate).toEqual([
            400,
            'DATE_NOT_TODAY',
          ]);
        }
        expect(await count(`select count(*)::int n from attendance_days`)).toBe(before);
      });
    });

    describe('abrir la lista: obtener o crear, una sola por grupo y fecha', () => {
      let dayA = '';
      it('la prefecta A abre la lista del grupo A (201); la prefecta B, con cobertura compartida, recibe LA MISMA (200)', async () => {
        const a = await open(pA, G.A!, { attendanceDate: W });
        expect(a.statusCode, a.body).toBe(201);
        expect(a.headers.location).toMatch(/^\/school\/attendance\/days\//);
        const da = body(a);
        dayA = da.day.id;
        expect(da).toMatchObject({
          created: true,
          day: { status: 'draft', revision: 1, attendanceDate: W, editable: true },
        });
        expect(da.day.counts).toEqual({ total: 4, present: 0, absent: 0, pending: 4 });
        const b = await open(pB, G.A!);
        expect(b.statusCode).toBe(200);
        expect(body(b)).toMatchObject({ created: false, day: { id: dayA } });
        expect(
          await count(
            `select count(*)::int n from attendance_days where group_id = $1 and attendance_date = $2::date`,
            [G.A, W],
          ),
        ).toBe(1);
        expect(
          await count(
            `select count(*)::int n from attendance_events where event_type = 'day_opened' and attendance_day_id = $1`,
            [dayA],
          ),
        ).toBe(1);
        // el detalle contiene solo lo necesario: id y nombre del alumno, estado y hora; sin codigo, expediente ni ids internos
        const rec = da.day.records[0];
        expect(Object.keys(rec).sort()).toEqual([
          'familyName',
          'givenNames',
          'markedAt',
          'status',
          'studentId',
        ]);
        expect(
          da.day.records.every((x: Json) => x.status === 'pending' && x.markedAt === null),
        ).toBe(true);
        expect(a.body).not.toMatch(/enrollment|assignment|schoolCode|createdBy"\s*:\s*"/i);
        expect(da.day.createdBy).toBeNull(); // la prefecta no ve quien abrio
      });

      it('aperturas SIMULTANEAS de la misma lista: una sola creacion, ambas reciben la misma', async () => {
        const g = await newGroup('SIM');
        for (let i = 0; i < 3; i += 1) await newStudent(g);
        await assignPrefect(pA.account.id, g);
        await assignPrefect(pB.account.id, g);
        const rs = await Promise.all([open(pA, g), open(pB, g), open(pA, g), open(pB, g)]);
        expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
        const ids = new Set(rs.map((r) => body(r).day.id));
        expect(ids.size).toBe(1);
        expect(
          await count(`select count(*)::int n from attendance_days where group_id = $1`, [g]),
        ).toBe(1);
        expect(
          await count(
            `select count(*)::int n from attendance_records where attendance_day_id = $1`,
            [[...ids][0]],
          ),
        ).toBe(3); // padron completo, sin duplicados
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1`,
            [[...ids][0]],
          ),
        ).toBe(1);
      });

      it('grupo ajeno o inexistente: 404 indistinguible; grupo sin alumnos: 409; grupo inactivo: 404 (sin acceso)', async () => {
        const foreign = await open(pD, G.A!); // pD solo tiene B
        const missing = await open(pD, '00000000-0000-4000-8000-0000000000cc');
        const noAssign = await open(pC, G.A!);
        for (const r of [foreign, missing, noAssign]) expect(r.statusCode).toBe(404);
        expect(stripId(foreign)).toBe(stripId(missing));
        expect(stripId(noAssign)).toBe(stripId(missing));
        const empty = await newGroup('VAC');
        await assignPrefect(pA.account.id, empty);
        const r = await open(pA, empty);
        expect([r.statusCode, body(r).error.code]).toEqual([409, 'EMPTY_ROSTER']);
        expect(
          await count(`select count(*)::int n from attendance_days where group_id = $1`, [empty]),
        ).toBe(0);
        expect((await open(pA, G.off!)).statusCode).toBe(404);
      });

      it('Direccion no captura (sin attendance:capture): 403; consulta cualquier lista', async () => {
        expect((await open(dir, G.A!)).statusCode).toBe(403);
        const r = await get(dir, `/school/attendance/days/${dayA}`);
        expect(r.statusCode).toBe(200);
        expect(body(r)).toMatchObject({ id: dayA, editable: false, createdBy: pA.account.id });
      });

      it('lista por id: la prefecta autorizada la ve; otra prefecta o un id inexistente reciben el MISMO 404', async () => {
        expect((await get(pA, `/school/attendance/days/${dayA}`)).statusCode).toBe(200);
        expect((await get(pB, `/school/attendance/days/${dayA}`)).statusCode).toBe(200);
        const foreign = await get(pD, `/school/attendance/days/${dayA}`);
        const missing = await get(
          pD,
          '/school/attendance/days/00000000-0000-4000-8000-0000000000dd',
        );
        expect([foreign.statusCode, missing.statusCode]).toEqual([404, 404]);
        expect(stripId(foreign)).toBe(stripId(missing));
        expect((await get(pC, `/school/attendance/days/${dayA}`)).statusCode).toBe(404);
        expect((await get(pD, `/school/attendance/days/${dayA}/events`)).statusCode).toBe(404);
        // no se filtran alumnos de otros grupos en ninguna respuesta de pD
        const lst = body(await get(pD, '/school/attendance/days'));
        expect(JSON.stringify(lst)).not.toContain(dayA);
      });
    });

    describe('capturar: guardar, revision optimista y reintentos', () => {
      let dayA = '';
      const rev = async () =>
        Number(
          (await q(`select revision from attendance_days where id = $1`, [dayA]))[0]!.revision,
        );
      it('A marca dos alumnos: cambia la revision, queda historial y los conteos se actualizan', async () => {
        dayA = body(await open(pA, G.A!)).day.id;
        const r = await save(pA, dayA, 1, [
          { studentId: S.A![0]!, status: 'present' },
          { studentId: S.A![1]!, status: 'absent' },
        ]);
        expect(r.statusCode, r.body).toBe(200);
        expect(body(r)).toMatchObject({
          changed: 2,
          replayed: false,
          day: { revision: 2, counts: { total: 4, present: 1, absent: 1, pending: 2 } },
        });
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed'`,
            [dayA],
          ),
        ).toBe(2);
        const marked = body(r).day.records.filter((x: Json) => x.status !== 'pending');
        expect(marked).toHaveLength(2);
        expect(marked.every((x: Json) => x.markedAt)).toBe(true);
      });

      it('un reintento IDENTICO (misma solicitud) es seguro: devuelve el estado vigente, sin duplicar historial ni revision', async () => {
        const requestId = uuid();
        const marks = [{ studentId: S.A![2]!, status: 'present' }];
        const first = await save(pA, dayA, 2, marks, requestId);
        expect(first.statusCode).toBe(200);
        expect(body(first)).toMatchObject({ changed: 1, replayed: false, day: { revision: 3 } });
        const events = await count(
          `select count(*)::int n from attendance_events where attendance_day_id = $1`,
          [dayA],
        );
        const again = await save(pA, dayA, 2, marks, requestId); // la respuesta se perdio; el cliente reintenta con la revision anterior
        expect(again.statusCode).toBe(200);
        expect(body(again)).toMatchObject({ changed: 0, replayed: true, day: { revision: 3 } });
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1`,
            [dayA],
          ),
        ).toBe(events);
        expect(await rev()).toBe(3);
      });

      it('la misma solicitud con OTRO contenido se rechaza (409) y no cambia nada', async () => {
        const requestId = uuid();
        expect(
          (await save(pA, dayA, 3, [{ studentId: S.A![3]!, status: 'present' }], requestId))
            .statusCode,
        ).toBe(200);
        const before = await count(
          `select count(*)::int n from attendance_events where attendance_day_id = $1`,
          [dayA],
        );
        const r = await save(pA, dayA, 4, [{ studentId: S.A![3]!, status: 'absent' }], requestId);
        expect([r.statusCode, body(r).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1`,
            [dayA],
          ),
        ).toBe(before);
        expect(await rev()).toBe(4);
      });

      it('version obsoleta: B (que vio la revision 1) recibe 409, nada se sobrescribe, recarga y puede guardar', async () => {
        const conflicts0 = await auditCount('attendance.save_conflict', 'failure');
        const stale = await save(pB, dayA, 1, [{ studentId: S.A![0]!, status: 'absent' }]);
        expect([stale.statusCode, body(stale).error.code]).toEqual([409, 'REVISION_CONFLICT']);
        expect(stale.body).not.toMatch(/SQLSTATE|attendance_/);
        expect(
          (
            await q(
              `select status from attendance_records r join enrollments e on e.id = r.enrollment_id where r.attendance_day_id = $1 and e.student_id = $2`,
              [dayA, S.A![0]],
            )
          )[0]!.status,
        ).toBe('present'); // el trabajo de A sigue intacto
        expect(await auditCount('attendance.save_conflict', 'failure')).toBe(conflicts0 + 1);
        const reload = body(await get(pB, `/school/attendance/days/${dayA}`)); // recargar
        expect(reload.revision).toBe(4);
        expect(reload.records.filter((x: Json) => x.status === 'present')).toHaveLength(3);
        const ok = await save(pB, dayA, reload.revision, [
          { studentId: S.A![0]!, status: 'absent' },
        ]);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(body(ok).day.revision).toBe(5);
      });

      it('un valor igual no cambia nada (sin revision nueva ni historial); alumnos ajenos o inexistentes se rechazan', async () => {
        const noop = await save(pA, dayA, 5, [{ studentId: S.A![0]!, status: 'absent' }]);
        expect(body(noop)).toMatchObject({ changed: 0, replayed: false, day: { revision: 5 } });
        const events = await count(
          `select count(*)::int n from attendance_events where attendance_day_id = $1`,
          [dayA],
        );
        for (const studentId of [S.B![0]!, uuid()]) {
          const r = await save(pA, dayA, 5, [{ studentId, status: 'present' }]);
          expect([r.statusCode, body(r).error.code]).toEqual([400, 'STUDENT_NOT_IN_LIST']);
        }
        // un lote con un alumno ajeno no aplica NINGUNO de los validos
        const mixed = await save(pA, dayA, 5, [
          { studentId: S.A![1]!, status: 'present' },
          { studentId: S.B![0]!, status: 'present' },
        ]);
        expect(mixed.statusCode).toBe(400);
        expect(
          (
            await q(
              `select r.status from attendance_records r join enrollments e on e.id = r.enrollment_id where r.attendance_day_id = $1 and e.student_id = $2`,
              [dayA, S.A![1]],
            )
          )[0]!.status,
        ).toBe('absent');
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1`,
            [dayA],
          ),
        ).toBe(events);
        expect(await rev()).toBe(5);
      });

      it('guardados SIMULTANEOS con la misma revision: uno gana, el otro recibe conflicto; nada se pierde', async () => {
        const g = await newGroup('RACE');
        const sts: string[] = [];
        for (let i = 0; i < 4; i += 1) sts.push((await newStudent(g)).student);
        await assignPrefect(pA.account.id, g);
        await assignPrefect(pB.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        const rs = await Promise.all([
          save(pA, day, 1, markAll(sts.slice(0, 2))),
          save(pB, day, 1, markAll(sts.slice(2), 'absent')),
        ]);
        expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const winner = rs.find((r) => r.statusCode === 200)!;
        expect(body(winner).day.revision).toBe(2);
        expect(
          await count(
            `select count(*)::int n from attendance_records where attendance_day_id = $1 and status is not null`,
            [day],
          ),
        ).toBe(2);
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed'`,
            [day],
          ),
        ).toBe(2);
      });
    });

    describe('finalizar', () => {
      let dayA = '';
      it('con pendientes NO se finaliza (409 con el conteo); con revision vieja tampoco; la lista sigue editable', async () => {
        dayA = body(await open(pA, G.A!)).day.id;
        const cur = body(await get(pA, `/school/attendance/days/${dayA}`));
        expect(cur.counts.pending).toBe(0); // la prueba anterior marco a todos
        // volver a abrir un caso con pendientes: grupo B
        const dayB = body(await open(pA, G.B!)).day.id as string;
        const part = await save(pA, dayB, 1, [{ studentId: S.B![0]!, status: 'present' }]);
        const r = await finalize(pA, dayB, body(part).day.revision);
        expect([r.statusCode, body(r).error.code]).toEqual([409, 'PENDING_RECORDS']);
        expect(body(r).error.message).toMatch(/Faltan 2 alumnos/);
        const stale = await finalize(pA, dayB, 1);
        expect([stale.statusCode, body(stale).error.code]).toEqual([409, 'REVISION_CONFLICT']);
        expect(
          (await q(`select status from attendance_days where id = $1`, [dayB]))[0]!.status,
        ).toBe('draft');
        expect(body(await get(pA, `/school/attendance/days/${dayB}`)).editable).toBe(true);
      });

      it('completa y finaliza (200); la hora la pone el servidor; luego la edicion ordinaria queda bloqueada', async () => {
        const cur = body(await get(pA, `/school/attendance/days/${dayA}`));
        const r = await finalize(pA, dayA, cur.revision);
        expect(r.statusCode, r.body).toBe(200);
        expect(body(r)).toMatchObject({
          alreadyFinalized: false,
          day: { status: 'finalized', editable: false, revision: cur.revision + 1 },
        });
        expect(body(r).day.finalizedAt).toBeTruthy();
        expect(await auditCount('attendance.day_finalized')).toBeGreaterThanOrEqual(1);
        const edit = await save(pA, dayA, cur.revision + 1, [
          { studentId: S.A![0]!, status: 'present' },
        ]);
        expect([edit.statusCode, body(edit).error.code]).toEqual([409, 'DAY_FINALIZED']);
        const stillA = await get(pB, `/school/attendance/days/${dayA}`);
        expect(body(stillA)).toMatchObject({ status: 'finalized', editable: false });
        // consulta posterior conservada y abrir otra vez devuelve LA MISMA lista finalizada
        const again = await open(pB, G.A!);
        expect(again.statusCode).toBe(200);
        expect(body(again)).toMatchObject({
          created: false,
          day: { id: dayA, status: 'finalized', editable: false },
        });
      });

      it('finalizar de nuevo (reintento o carrera) es idempotente: mismo resultado y sin historial nuevo', async () => {
        const finals = await count(
          `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'day_finalized'`,
          [dayA],
        );
        const revision = Number(
          (await q(`select revision from attendance_days where id = $1`, [dayA]))[0]!.revision,
        );
        for (const login of [pA, pB, pA])
          expect(body(await finalize(login, dayA, 1)).alreadyFinalized).toBe(true); // aun con revision vieja
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'day_finalized'`,
            [dayA],
          ),
        ).toBe(finals);
        expect(
          Number(
            (await q(`select revision from attendance_days where id = $1`, [dayA]))[0]!.revision,
          ),
        ).toBe(revision);
        // un guardado antiguo ya aplicado se reconoce aunque la lista este finalizada (no es una modificacion nueva)
      });

      it('dos finalizaciones SIMULTANEAS producen un solo resultado', async () => {
        const g = await newGroup('FIN');
        const sts: string[] = [];
        for (let i = 0; i < 3; i += 1) sts.push((await newStudent(g)).student);
        await assignPrefect(pA.account.id, g);
        await assignPrefect(pB.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        const saved = await save(pA, day, 1, markAll(sts));
        const revision = body(saved).day.revision as number;
        const rs = await Promise.all([
          finalize(pA, day, revision),
          finalize(pB, day, revision),
          finalize(pA, day, revision),
        ]);
        expect(rs.every((r) => r.statusCode === 200)).toBe(true);
        expect(rs.filter((r) => body(r).alreadyFinalized === false)).toHaveLength(1);
        expect(new Set(rs.map((r) => body(r).day.finalizedAt)).size).toBe(1);
        expect(
          await count(
            `select count(*)::int n from attendance_events where attendance_day_id = $1 and event_type = 'day_finalized'`,
            [day],
          ),
        ).toBe(1);
        expect(
          Number(
            (await q(`select revision from attendance_days where id = $1`, [day]))[0]!.revision,
          ),
        ).toBe(revision + 1);
      });

      it('guardar y finalizar a la vez: o gana el guardado (y la finalizacion con la revision vieja falla) o gana la finalizacion; nunca una lista a medias', async () => {
        const g = await newGroup('SVF');
        const sts: string[] = [];
        for (let i = 0; i < 3; i += 1) sts.push((await newStudent(g)).student);
        await assignPrefect(pA.account.id, g);
        await assignPrefect(pB.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        const r1 = await save(pA, day, 1, markAll(sts)); // todos presentes: lista completa
        const revision = body(r1).day.revision as number;
        const [s, f] = await Promise.all([
          save(pB, day, revision, [{ studentId: sts[0]!, status: 'absent' }]),
          finalize(pA, day, revision),
        ]);
        // exactamente una operacion gana; la otra recibe un conflicto controlado (nunca una mezcla)
        expect([s.statusCode, f.statusCode].sort()).toEqual([200, 409]);
        const first = (
          await q(
            `select r.status from attendance_records r join enrollments e on e.id = r.enrollment_id where r.attendance_day_id = $1 and e.student_id = $2`,
            [day, sts[0]],
          )
        )[0]!.status;
        const dayRow = (
          await q(`select status, revision from attendance_days where id = $1`, [day])
        )[0]!;
        if (s.statusCode === 200) {
          expect(body(f).error.code).toBe('REVISION_CONFLICT'); // el guardado fue primero: quien finaliza no vio ese cambio
          expect([dayRow.status, first]).toEqual(['draft', 'absent']);
        } else {
          expect(body(s).error.code).toBe('DAY_FINALIZED'); // la finalizacion fue primera: el guardado ya no entra
          expect([dayRow.status, first]).toEqual(['finalized', 'present']);
        }
      });
    });

    describe('cambio de fecha escolar durante la captura (medianoche)', () => {
      it('una lista abierta el dia anterior no se guarda ni se finaliza hoy; sigue consultable; hoy se abre otra', async () => {
        const g = await newGroup('MID');
        const sts: string[] = [];
        for (let i = 0; i < 2; i += 1) sts.push((await newStudent(g)).student);
        await assignPrefect(pA.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        expect(
          body(await save(pA, day, 1, [{ studentId: sts[0]!, status: 'present' }])).day.revision,
        ).toBe(2);
        clock.today = addDays(W, 1); // pasa la medianoche: jueves
        try {
          const s = await save(pA, day, 2, [{ studentId: sts[1]!, status: 'present' }]);
          expect([s.statusCode, body(s).error.code]).toEqual([409, 'DAY_NOT_CURRENT']);
          const f = await finalize(pA, day, 2);
          expect([f.statusCode, body(f).error.code]).toEqual([409, 'DAY_NOT_CURRENT']);
          const view = body(await get(pA, `/school/attendance/days/${day}`));
          expect(view).toMatchObject({
            attendanceDate: W,
            status: 'draft',
            editable: false,
            schoolToday: addDays(W, 1),
          });
          const today = await open(pA, g);
          expect(today.statusCode).toBe(201);
          expect(body(today).day.id).not.toBe(day);
          expect(body(today).day.attendanceDate).toBe(addDays(W, 1));
          // reabrir hoy devuelve la MISMA lista de hoy: no se duplica
          const again = await open(pA, g);
          expect([again.statusCode, body(again).day.id]).toEqual([200, body(today).day.id]);
          // no hay forma de "resucitar" el dia anterior con una fecha artificial
          const artificial = await open(pA, g, { attendanceDate: W });
          expect([artificial.statusCode, body(artificial).error.code]).toEqual([
            400,
            'DATE_NOT_TODAY',
          ]);
          // la autoridad sigue viendo el borrador historico, sin poder capturar
          const asDir = body(await get(dir, `/school/attendance/days/${day}`));
          expect(asDir).toMatchObject({ attendanceDate: W, status: 'draft', editable: false });
          expect((await finalize(dir, day, 2)).statusCode).toBe(403);
        } finally {
          clock.today = W;
        }
        expect(
          await count(`select count(*)::int n from attendance_days where group_id = $1`, [g]),
        ).toBe(2);
      });
    });

    describe('el acceso se evalua en cada peticion', () => {
      it('asignacion revocada: ya no puede ver, guardar ni finalizar, y la lista no se pierde; la otra prefecta sigue', async () => {
        const g = await newGroup('REV');
        const sts: string[] = [];
        for (let i = 0; i < 2; i += 1) sts.push((await newStudent(g)).student);
        const acc = await kit.seed({ role: 'prefectura' });
        const pr = await kit.login(acc, app);
        await assignPrefect(acc.id, g);
        await assignPrefect(pB.account.id, g);
        const day = body(await open(pr, g)).day.id as string;
        expect(
          (await save(pr, day, 1, [{ studentId: sts[0]!, status: 'present' }])).statusCode,
        ).toBe(200);
        await q(
          `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Prueba de revocacion' where user_id = $1 and group_id = $3`,
          [acc.id, kit.boss.id, g],
        );
        const s = await save(pr, day, 2, [{ studentId: sts[1]!, status: 'present' }]);
        expect(s.statusCode).toBe(404);
        expect((await finalize(pr, day, 2)).statusCode).toBe(404);
        expect((await get(pr, `/school/attendance/days/${day}`)).statusCode).toBe(404);
        expect(body(await get(pr, '/school/attendance/today')).groups).toEqual([]);
        expect(body(await get(pr, '/school/attendance/days')).items).toEqual([]);
        expect((await open(pr, g)).statusCode).toBe(404);
        // la captura confirmada ANTES de la revocacion se conserva
        expect(
          (
            await q(
              `select count(*)::int n from attendance_records where attendance_day_id = $1 and status = 'present'`,
              [day],
            )
          )[0]!.n,
        ).toBe(1);
        // la otra prefecta con acceso vigente sigue pudiendo capturar
        const ok = await save(pB, day, 2, [{ studentId: sts[1]!, status: 'absent' }]);
        expect(ok.statusCode, ok.body).toBe(200);
      });

      it('rol revocado o sesion revocada: 401 inmediato; la lista no cambia', async () => {
        const g = await newGroup('SES');
        const sts: string[] = [];
        for (let i = 0; i < 2; i += 1) sts.push((await newStudent(g)).student);
        const a1 = await kit.seed({ role: 'prefectura' });
        const a2 = await kit.seed({ role: 'prefectura' });
        const l1 = await kit.login(a1, app);
        const l2 = await kit.login(a2, app);
        await assignPrefect(a1.id, g);
        await assignPrefect(a2.id, g);
        const day = body(await open(l1, g)).day.id as string;
        await q(
          `update sessions set revoked_at = now(), revoked_reason = 'admin' where user_id = $1`,
          [a1.id],
        );
        expect(
          (await save(l1, day, 1, [{ studentId: sts[0]!, status: 'present' }])).statusCode,
        ).toBe(401);
        await q(
          `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
          [a2.id, kit.boss.id],
        );
        expect(
          (await save(l2, day, 1, [{ studentId: sts[0]!, status: 'present' }])).statusCode,
        ).toBe(401);
        expect(
          await count(
            `select count(*)::int n from attendance_records where attendance_day_id = $1 and status is not null`,
            [day],
          ),
        ).toBe(0);
      });

      it('grupo desactivado durante la captura: no se guarda ni se finaliza (409); la lista sigue consultable', async () => {
        const g = await newGroup('INA');
        const sts: string[] = [];
        for (let i = 0; i < 2; i += 1) sts.push((await newStudent(g)).student);
        await assignPrefect(pA.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        await q(`update groups set is_active = false where id = $1`, [g]);
        // con el grupo inactivo la prefecta pierde el acceso al grupo (assigned_groups exige grupo activo): 404 indistinguible
        const s = await save(pA, day, 1, [{ studentId: sts[0]!, status: 'present' }]);
        expect(s.statusCode).toBe(404);
        expect((await finalize(pA, day, 1)).statusCode).toBe(404);
        // Direccion si lo consulta, y no es editable
        const view = body(await get(dir, `/school/attendance/days/${day}`));
        expect(view).toMatchObject({ status: 'draft', editable: false });
        expect(
          await count(
            `select count(*)::int n from attendance_records where attendance_day_id = $1 and status is not null`,
            [day],
          ),
        ).toBe(0);
      });
    });

    describe('padron congelado y discrepancias', () => {
      it('altas y traslados POSTERIORES a la apertura no cambian la lista; se informan como discrepancia', async () => {
        const g = await newGroup('PAD');
        const sts: Array<Awaited<ReturnType<typeof newStudent>>> = [];
        for (let i = 0; i < 3; i += 1) sts.push(await newStudent(g));
        await assignPrefect(pA.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        expect(body(await get(dir, `/school/attendance/days/${day}`)).discrepancies).toEqual({
          addedToRoster: 0,
          removedFromRoster: 0,
        });
        // llega un alumno al grupo ese mismo dia
        const late = await newStudent(g, Y.cur, W);
        // otro alumno se traslada fuera del grupo con efecto en la misma fecha (cierre de su periodo el dia anterior)
        await q(`update student_group_assignments set ends_on = $2 where id = $1`, [
          sts[0]!.assignment,
          addDays(W, -1),
        ]);
        const view = body(await get(dir, `/school/attendance/days/${day}`));
        expect(view.records).toHaveLength(3); // los renglones capturados no cambiaron
        expect(view.records.map((r: Json) => r.studentId)).not.toContain(late.student);
        expect(view.discrepancies).toEqual({ addedToRoster: 1, removedFromRoster: 1 });
        // la prefecta no puede marcar al recien llegado ni "sacar" al trasladado: el padron esta congelado
        const r = await save(pA, day, 1, [{ studentId: late.student, status: 'present' }]);
        expect([r.statusCode, body(r).error.code]).toEqual([400, 'STUDENT_NOT_IN_LIST']);
        const moved = await save(pA, day, 1, [{ studentId: sts[0]!.student, status: 'present' }]);
        expect(moved.statusCode).toBe(200); // sigue en la lista de ese dia (historial)
      });

      it('finalizar CON discrepancias esta permitido (decision provisional): el padron congelado se finaliza tal cual y la discrepancia sigue visible, sin cambiar la lista', async () => {
        const g = await newGroup('PFD');
        const sts: Array<Awaited<ReturnType<typeof newStudent>>> = [];
        for (let i = 0; i < 2; i += 1) sts.push(await newStudent(g));
        await assignPrefect(pA.account.id, g);
        const day = body(await open(pA, g)).day.id as string;
        const late = await newStudent(g, Y.cur, W); // llega despues de abrir la lista
        const saved = await save(
          pA,
          day,
          1,
          markAll(
            sts.map((s) => s.student),
            'absent',
          ),
        );
        expect(saved.statusCode).toBe(200);
        const fin = await finalize(pA, day, body(saved).day.revision);
        expect(fin.statusCode).toBe(200);
        const view = body(await get(dir, `/school/attendance/days/${day}`));
        expect(view).toMatchObject({
          status: 'finalized',
          discrepancies: { addedToRoster: 1, removedFromRoster: 0 },
        });
        expect(view.records).toHaveLength(2);
        expect(view.records.map((r: Json) => r.studentId)).not.toContain(late.student);
        // la lista finalizada ya no admite al recien llegado ni cambios
        const after = await save(pA, day, view.revision, [
          { studentId: late.student, status: 'present' },
        ]);
        expect(after.statusCode).toBeGreaterThanOrEqual(400);
        expect(
          await count(
            `select count(*)::int n from attendance_records where attendance_day_id = $1`,
            [day],
          ),
        ).toBe(2);
      });

      it('cambio de grupo en otra fecha: la lista antigua conserva al alumno y la nueva (otro dia) usa su nuevo grupo', async () => {
        const g1 = await newGroup('T1');
        const g2 = await newGroup('T2');
        const mover = await newStudent(g1);
        await newStudent(g1);
        await newStudent(g2);
        await assignPrefect(pA.account.id, g1);
        await assignPrefect(pA.account.id, g2);
        const d1 = body(await open(pA, g1)).day;
        expect(d1.records).toHaveLength(2);
        // traslado con efecto el dia siguiente a W
        await q(`update student_group_assignments set ends_on = $2 where id = $1`, [
          mover.assignment,
          W,
        ]);
        await q(
          `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
          [mover.enrollment, Y.cur, g2, addDays(W, 1)],
        );
        clock.today = addDays(W, 1);
        try {
          const n1 = body(await open(pA, g1)).day; // hoy (jueves): el alumno ya no esta en g1
          const n2 = body(await open(pA, g2)).day;
          expect(n1.records).toHaveLength(1);
          expect(n2.records).toHaveLength(2);
          expect(n2.records.map((r: Json) => r.studentId)).toContain(mover.student);
        } finally {
          clock.today = W;
        }
        // la lista de W conserva al alumno en g1
        const old = body(await get(pA, `/school/attendance/days/${d1.id}`));
        expect(old.records.map((r: Json) => r.studentId)).toContain(mover.student);
      });

      it('alumno dado de baja: sale del padron del dia siguiente pero sigue en la lista de los dias en que estaba inscrito', async () => {
        const g = await newGroup('BAJ');
        const stay = await newStudent(g);
        const leaver = await newStudent(g);
        await assignPrefect(pA.account.id, g);
        const first = body(await open(pA, g)).day;
        expect(first.records).toHaveLength(2);
        await q(`update student_group_assignments set ends_on = $2 where id = $1`, [
          leaver.assignment,
          W,
        ]);
        await q(`update enrollments set ends_on = $2 where id = $1`, [leaver.enrollment, W]);
        clock.today = addDays(W, 1);
        try {
          const next = body(await open(pA, g)).day;
          expect(next.records.map((r: Json) => r.studentId)).toEqual([stay.student]);
        } finally {
          clock.today = W;
        }
        expect(body(await get(pA, `/school/attendance/days/${first.id}`)).records).toHaveLength(2);
      });
    });

    describe('consultas, historial y privacidad', () => {
      it('Direccion lista con filtros, paginacion y orden estable; la prefecta solo ve sus grupos', async () => {
        const all = body(await get(dir, '/school/attendance/days?pageSize=3'));
        expect(all.items).toHaveLength(3);
        expect(all.total).toBeGreaterThan(8);
        const p2 = body(await get(dir, '/school/attendance/days?pageSize=3&page=2'));
        expect(
          p2.items
            .map((x: Json) => x.id)
            .filter((id: string) => all.items.some((y: Json) => y.id === id)),
        ).toEqual([]);
        expect(all.items.every((x: Json) => x.createdBy !== null)).toBe(true);
        const fin = body(await get(dir, '/school/attendance/days?status=finalized'));
        expect(fin.items.every((x: Json) => x.status === 'finalized')).toBe(true);
        const byGroup = body(
          await get(dir, `/school/attendance/days?groupId=${G.A}&from=${W}&to=${W}`),
        );
        expect(byGroup.items.map((x: Json) => x.group.code)).toEqual(['A']);
        const mine = body(await get(pD, '/school/attendance/days?pageSize=100'));
        expect(mine.items.length).toBeGreaterThan(0);
        expect(mine.items.every((x: Json) => x.group.id === G.B)).toBe(true);
        expect(mine.items.every((x: Json) => x.createdBy === null && x.finalizedBy === null)).toBe(
          true,
        );
        expect(body(await get(pC, '/school/attendance/days')).total).toBe(0);
        // el filtro por un grupo ajeno no amplia el alcance
        expect(body(await get(pD, `/school/attendance/days?groupId=${G.A}`)).total).toBe(0);
      });

      it('historial: tipos y orden; sin nombres de alumnos; el actor solo se revela a Direccion', async () => {
        const dayA = (
          await q(
            `select id from attendance_days where group_id = $1 and attendance_date = $2::date`,
            [G.A, W],
          )
        )[0]!.id as string;
        const ev = body(await get(dir, `/school/attendance/days/${dayA}/events?pageSize=100`));
        expect(ev.items[0]).toMatchObject({
          eventType: 'day_opened',
          revisionAfter: 1,
          studentId: null,
        });
        expect(ev.items.at(-1)).toMatchObject({ eventType: 'day_finalized' });
        const marks = ev.items.filter((e: Json) => e.eventType === 'mark_changed');
        expect(marks.length).toBeGreaterThanOrEqual(4);
        expect(
          marks.every(
            (e: Json) =>
              e.studentId &&
              e.newStatus &&
              (e.oldStatus === 'pending' || e.oldStatus === 'present' || e.oldStatus === 'absent'),
          ),
        ).toBe(true);
        expect(ev.items.every((e: Json) => typeof e.actorId === 'string')).toBe(true);
        const mineEv = body(await get(pA, `/school/attendance/days/${dayA}/events?pageSize=100`));
        expect(mineEv.items.every((e: Json) => e.actorId === null)).toBe(true);
        expect(JSON.stringify(ev)).not.toMatch(/Alumno|Apellido/);
        expect(
          body(await get(dir, `/school/attendance/days/${dayA}/events?pageSize=2&page=2`)).items,
        ).toHaveLength(2);
      });

      it('auditoria con IDs y conteos, nunca nombres; respuestas y logs sin secretos', async () => {
        const events = await q(
          `select event_type, details from audit_events where event_type like 'attendance.%'`,
        );
        const types = new Set(events.map((e) => e.event_type));
        expect([...types]).toEqual(
          expect.arrayContaining([
            'attendance.day_opened',
            'attendance.marks_saved',
            'attendance.day_finalized',
            'attendance.day_viewed',
            'attendance.save_conflict',
          ]),
        );
        expect(JSON.stringify(events)).not.toMatch(/Alumno|Apellido|Persona de prueba|@escuela/);
        const text = JSON.stringify(body(await get(dir, '/school/attendance/days?pageSize=100')));
        expect(text).not.toMatch(/password|hash|token|cookie|csrf/i);
        for (const secret of kit.secrets) expect(text).not.toContain(secret);
        for (const line of kit.logs)
          for (const secret of kit.secrets) expect(line).not.toContain(secret);
      });

      it('sin borrado fisico: ningun registro se perdio; no hay estados fuera de los permitidos', async () => {
        expect(await count(`select count(*)::int n from attendance_days`)).toBeGreaterThan(8);
        expect(
          await count(
            `select count(*)::int n from attendance_records where status is not null and status not in ('present','absent')`,
          ),
        ).toBe(0);
        // toda lista finalizada tiene a todos sus alumnos marcados
        expect(
          await count(
            `select count(*)::int n from attendance_days d where d.status = 'finalized'
               and exists (select 1 from attendance_records r where r.attendance_day_id = d.id and r.status is null)`,
          ),
        ).toBe(0);
      });
    });
  });
}
