import { describe, expect, it } from 'vitest';
import type { AdminKit, Login } from './admin-http-suite.js';

/**
 * Pruebas HTTP de alumnos, matriculas e historial de grupo con Fastify `inject` sobre PostgreSQL real (PGlite o clúster
 * desechable) y un rol de ejecucion NO propietario. TODOS los datos son FICTICIOS; nunca contra eta15_dev.
 * La base ya tiene aplicada la migracion RBAC 0008 (politica de alumnos cerrada por defecto). `mode: 'unavailable'` reproduce
 * el estado de una base SIN los privilegios 0003 (el modulo responde 503 sin cambiar nada).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCHOOL_TZ = 'America/Mazatlan';
export const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ }).format(new Date());
export const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function defineStudentsTests(
  kit: AdminKit,
  opts: { mode: 'full' | 'unavailable' } = { mode: 'full' },
): void {
  describe(`alumnos y matriculas (${opts.mode === 'full' ? 'con privilegios 0003' : 'sin privilegios: modulo no habilitado'})`, () => {
    const today = todayIso();
    const yr = {
      past: { startsOn: addDays(today, -800), endsOn: addDays(today, -435) },
      cur: { startsOn: addDays(today, -100), endsOn: addDays(today, 200) },
      fut: { startsOn: addDays(today, 201), endsOn: addDays(today, 400) },
    };
    const Y: Record<'past' | 'cur' | 'fut', string> = { past: '', cur: '', fut: '' };
    const G: Record<string, string> = {};
    let dir: Login;
    let tecnico: Login;
    let pref: Login;
    let social: Login;
    let acceso: Login;
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const auditCount = async (type: string) =>
      Number(
        (await q(`select count(*)::int n from audit_events where event_type = $1`, [type]))[0]!.n,
      );
    const post = (
      login: Login | null,
      url: string,
      body?: unknown,
      extra: Record<string, unknown> = {},
    ) => kit.call(login, 'POST', url, { body, ...extra });
    const patch = (login: Login | null, url: string, body?: unknown) =>
      kit.call(login, 'PATCH', url, { body });
    const get = (login: Login | null, url: string) => kit.call(login, 'GET', url);
    const body = (r: { json: () => unknown }) => r.json() as Json;
    let n = 0;
    /** Los nombres no admiten digitos: el contador se escribe con letras (1 -> B, 12 -> BC). */
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const newStudent = async (extra: Record<string, unknown> = {}) => {
      n += 1;
      const r = await post(dir, '/school/students', {
        givenNames: `Alumno${alpha(n)}`,
        familyName: 'Ficticia',
        ...extra,
      });
      expect(r.statusCode, r.body).toBe(201);
      return body(r);
    };
    const enrollIn = async (studentId: string, year: 'cur' | 'fut' = 'cur', startsOn?: string) => {
      const r = await post(dir, `/school/students/${studentId}/enrollments`, {
        schoolYearId: Y[year],
        ...(startsOn ? { startsOn } : {}),
      });
      expect(r.statusCode, r.body).toBe(201);
      return body(r);
    };

    it('preparacion: ciclos y grupos ficticios (pasado, vigente, futuro) y cuentas de cada rol', async () => {
      dir = await kit.login(kit.boss);
      tecnico = await kit.login(kit.techBoss);
      pref = await kit.login(await kit.seed({ role: 'prefectura' }));
      social = await kit.login(await kit.seed({ role: 'trabajo_social' }));
      acceso = await kit.login(await kit.seed({ role: 'control_acceso' }));
      for (const k of ['past', 'cur', 'fut'] as const) {
        Y[k] = (
          await q(
            `insert into school_years (name, starts_on, ends_on) values ($1, $2, $3) returning id`,
            [`Ciclo ${k}`, yr[k].startsOn, yr[k].endsOn],
          )
        )[0]!.id as string;
      }
      const grp = async (key: string, year: string, grade: number, code: string, active = true) => {
        G[key] = (
          await q(
            `insert into groups (school_year_id, grade, code, is_active) values ($1, $2, $3, $4) returning id`,
            [year, grade, code, active],
          )
        )[0]!.id as string;
      };
      await grp('A', Y.cur, 1, 'A');
      await grp('B', Y.cur, 1, 'B');
      await grp('C', Y.cur, 2, 'C');
      await grp('off', Y.cur, 3, 'OFF', false);
      await grp('FA', Y.fut, 1, 'A');
      await grp('FB', Y.fut, 1, 'B');
      await grp('PA', Y.past, 1, 'A');
      for (let i = 0; i < 8; i += 1) await grp(`R${i}`, Y.cur, 3, `R${i}`);
    });

    describe('autorizacion y proteccion de la API', () => {
      it('sin sesion: 401 en todas las rutas', async () => {
        const id = '00000000-0000-4000-8000-000000000001';
        for (const [m, u] of [
          ['GET', '/school/students'],
          ['POST', '/school/students'],
          ['GET', `/school/students/${id}`],
          ['PATCH', `/school/students/${id}`],
          ['POST', `/school/students/${id}/deactivate`],
          ['POST', `/school/students/${id}/reactivate`],
          ['GET', `/school/students/${id}/enrollments`],
          ['POST', `/school/students/${id}/enrollments`],
          ['GET', `/school/enrollments/${id}`],
          ['POST', `/school/enrollments/${id}/withdraw`],
          ['POST', `/school/enrollments/${id}/group-assignments`],
          ['POST', `/school/enrollments/${id}/transfer`],
        ] as const) {
          const r = await kit.call(null, m, u, { body: m === 'GET' ? undefined : {} });
          expect(r.statusCode, `${m} ${u}`).toBe(401);
        }
      });

      it('mutaciones sin CSRF o sin Origin permitido: 403 y sin cambios', async () => {
        const before = Number((await q(`select count(*)::int n from students`))[0]!.n);
        const payload = { givenNames: 'Sin', familyName: 'Csrf' };
        expect((await post(dir, '/school/students', payload, { csrf: false })).statusCode).toBe(
          403,
        );
        expect((await post(dir, '/school/students', payload, { csrf: 'x' })).statusCode).toBe(403);
        const noOrigin = await post(dir, '/school/students', payload, { origin: false });
        expect(body(noOrigin).error.code).toBe('FORBIDDEN_ORIGIN');
        expect(Number((await q(`select count(*)::int n from students`))[0]!.n)).toBe(before);
      });

      it('sesion revocada: 401 inmediato en lectura y escritura', async () => {
        const second = await kit.login(await kit.seed({ domain: 'school', role: 'direccion' }));
        await q(
          `update sessions set revoked_at = now(), revoked_reason = 'admin' where revoked_at is null and user_id = (select id from users where email = $1)`,
          [second.account.email],
        );
        expect((await get(second, '/school/students')).statusCode).toBe(401);
        expect(
          (await post(second, '/school/students', { givenNames: 'X', familyName: 'Y' })).statusCode,
        ).toBe(401);
      });

      if (opts.mode === 'unavailable') return;

      it('admin_tecnico, trabajo social y control de acceso (politica cerrada): 403 en todo y queda auditado', async () => {
        const id = (await newStudent()).id as string;
        const before = await auditCount('authz.denied');
        for (const who of [tecnico, social, acceso]) {
          expect((await get(who, '/school/students')).statusCode).toBe(403);
          expect((await get(who, `/school/students/${id}`)).statusCode).toBe(403);
          expect((await get(who, `/school/students/${id}/enrollments`)).statusCode).toBe(403);
          expect(
            (await post(who, '/school/students', { givenNames: 'X', familyName: 'Y' })).statusCode,
          ).toBe(403);
          expect(
            (await post(who, `/school/students/${id}/enrollments`, { schoolYearId: Y.cur }))
              .statusCode,
          ).toBe(403);
        }
        expect(await auditCount('authz.denied')).toBeGreaterThanOrEqual(before + 15);
      });

      it('prefectura SIN asignaciones de grupo: lista vacia (0 filas, total 0), detalle 404 y sin escritura (403)', async () => {
        const s = await newStudent();
        const g = await enrollIn(s.id);
        await post(dir, `/school/enrollments/${g.id}/group-assignments`, { groupId: G.A });
        const list = await get(pref, '/school/students');
        expect(list.statusCode).toBe(200);
        expect(body(list)).toMatchObject({ items: [], total: 0 });
        expect(
          (await get(pref, `/school/students?q=${encodeURIComponent('Alumno')}`)).json(),
        ).toMatchObject({ total: 0 });
        expect((await get(pref, `/school/students/${s.id}`)).statusCode).toBe(404); // igual que uno inexistente
        expect(
          (await get(pref, `/school/students/00000000-0000-4000-8000-0000000000aa`)).statusCode,
        ).toBe(404);
        expect((await get(pref, `/school/students/${s.id}/enrollments`)).statusCode).toBe(404);
        expect(
          (await post(pref, '/school/students', { givenNames: 'X', familyName: 'Y' })).statusCode,
        ).toBe(403);
        expect(
          (await post(pref, `/school/enrollments/${g.id}/transfer`, { groupId: G.B })).statusCode,
        ).toBe(403);
      });
    });

    if (opts.mode === 'unavailable') {
      it('sin privilegios 0003 el modulo responde 503 STUDENTS_UNAVAILABLE sin detalles internos y sin cambiar nada', async () => {
        for (const res of [
          await get(dir, '/school/students'),
          await get(dir, '/school/students/00000000-0000-4000-8000-000000000001'),
          await post(dir, '/school/students', { givenNames: 'Ana', familyName: 'Ficticia' }),
          await post(dir, '/school/students/00000000-0000-4000-8000-000000000001/enrollments', {
            schoolYearId: Y.cur,
          }),
        ]) {
          expect(res.statusCode, res.body).toBe(503);
          expect(body(res).error.code).toBe('STUDENTS_UNAVAILABLE');
          expect(res.body).not.toMatch(/permission|42501|relation|sql|students\b.*does not exist/i);
        }
      });
      return;
    }

    describe('alumnos', () => {
      it('crea un alumno (201) con nombres normalizados, codigo canonico y SOLO los campos minimos', async () => {
        const r = await post(dir, '/school/students', {
          givenNames: '  María   José ',
          familyName: "D'Angelo-Pérez",
          schoolCode: ' esc-01 ',
        });
        expect(r.statusCode, r.body).toBe(201);
        const s = body(r);
        expect(s).toMatchObject({
          givenNames: 'María José',
          familyName: "D'Angelo-Pérez",
          schoolCode: 'ESC-01',
          isActive: true,
          currentGroup: null,
        });
        expect(Object.keys(s).sort()).toEqual([
          'createdAt',
          'currentGroup',
          'familyName',
          'givenNames',
          'id',
          'isActive',
          'schoolCode',
          'updatedAt',
        ]);
        expect(r.headers.location).toBe(`/school/students/${s.id}`);
        const row = (await q(`select school_code from students where id = $1`, [s.id]))[0]!;
        expect(row.school_code).toBe('ESC-01');
        // sin campos sensibles ni credenciales en la respuesta
        expect(r.body).not.toMatch(/curp|password|token|hash|birth|tutor|photo/i);
      });

      it('el codigo es opcional; homonimos permitidos; codigo duplicado 409 DUPLICATE_SCHOOL_CODE', async () => {
        const a = await newStudent({ givenNames: 'Ana', familyName: 'Homónima' });
        const b = await newStudent({ givenNames: 'Ana', familyName: 'Homónima' });
        expect(a.id).not.toBe(b.id);
        expect(a.schoolCode).toBeNull();
        await newStudent({ schoolCode: 'UNICO-1' });
        const dup = await post(dir, '/school/students', {
          givenNames: 'Otro',
          familyName: 'Alumno',
          schoolCode: 'unico-1',
        });
        expect(dup.statusCode).toBe(409);
        expect(body(dup).error.code).toBe('DUPLICATE_SCHOOL_CODE');
        expect(dup.body).not.toMatch(/constraint|violates|duplicate key|sql/i);
      });

      it.each([
        ['nombre vacio', { givenNames: '', familyName: 'F' }],
        ['solo espacios', { givenNames: '   ', familyName: 'F' }],
        ['digitos', { givenNames: 'Ana2', familyName: 'F' }],
        ['simbolos', { givenNames: 'Ana<script>', familyName: 'F' }],
        ['mas de 100', { givenNames: 'A'.repeat(101), familyName: 'F' }],
        ['control', { givenNames: 'Ana\u0007', familyName: 'F' }],
        ['empieza con guion', { givenNames: '-Ana', familyName: 'F' }],
        ['apellido vacio', { givenNames: 'Ana', familyName: '' }],
        ['codigo con espacios', { givenNames: 'Ana', familyName: 'F', schoolCode: 'A B' }],
        ['codigo con acento', { givenNames: 'Ana', familyName: 'F', schoolCode: 'ÁB' }],
        ['codigo largo', { givenNames: 'Ana', familyName: 'F', schoolCode: 'A'.repeat(21) }],
        ['codigo vacio', { givenNames: 'Ana', familyName: 'F', schoolCode: '' }],
        ['CURP (campo no existente)', { givenNames: 'Ana', familyName: 'F', curp: 'XXXX' }],
        ['fecha de nacimiento', { givenNames: 'Ana', familyName: 'F', birthDate: '2012-01-01' }],
        ['isActive en el alta', { givenNames: 'Ana', familyName: 'F', isActive: false }],
        [
          'id impuesto',
          { givenNames: 'Ana', familyName: 'F', id: '00000000-0000-4000-8000-000000000001' },
        ],
        ['sin apellido', { givenNames: 'Ana' }],
      ])('rechaza %s (400) sin eco de la entrada', async (_n, payload) => {
        const r = await post(dir, '/school/students', payload);
        expect(r.statusCode, r.body).toBe(400);
        expect(body(r).error.code).toBe('VALIDATION_ERROR');
        expect(r.body).not.toMatch(/XXXX|script/);
      });

      it('lista con paginacion, busqueda por nombre o codigo (sin distinguir mayusculas) y comodines escapados', async () => {
        for (const [g, f, c] of [
          ['Búsqueda', 'Uno', 'BUS-1'],
          ['Búsqueda', 'Dos', null],
          ['Otra', 'Persona', 'BUS-2'],
        ] as const)
          await newStudent({ givenNames: g, familyName: f, schoolCode: c });
        const all = body(await get(dir, '/school/students?pageSize=100'));
        expect(all.total).toBeGreaterThan(5);
        const byName = body(await get(dir, `/school/students?q=${encodeURIComponent('búsqueda')}`));
        expect(byName.total).toBe(2);
        expect(byName.items.map((s: Json) => s.familyName)).toEqual(['Dos', 'Uno']); // orden por apellido
        expect(body(await get(dir, '/school/students?q=bus-')).total).toBe(2); // por codigo, parcial
        expect(body(await get(dir, '/school/students?q=%25%25')).total).toBe(0); // "%%" no es comodin
        expect(body(await get(dir, '/school/students?q=ZZZZ-NO')).total).toBe(0);
        const p1 = body(await get(dir, '/school/students?pageSize=3&page=1'));
        const p2 = body(await get(dir, '/school/students?pageSize=3&page=2'));
        expect(p1.items).toHaveLength(3);
        expect(new Set([...p1.items, ...p2.items].map((s: Json) => s.id)).size).toBe(6);
        for (const bad of [
          '?pageSize=101',
          '?page=0',
          '?q=a',
          '?isActive=1',
          '?x=1',
          '?schoolYearId=no',
          '?asOf=2026-13-40',
        ])
          expect((await get(dir, `/school/students${bad}`)).statusCode, bad).toBe(400);
      });

      it('detalle (200), inexistente (404) e id mal formado (400); corrige datos permitidos y es idempotente', async () => {
        const s = await newStudent({
          givenNames: 'Corregir',
          familyName: 'Datos',
          schoolCode: 'COR-1',
        });
        const url = `/school/students/${s.id}`;
        expect(body(await get(dir, url))).toMatchObject({ id: s.id, givenNames: 'Corregir' });
        expect(
          (await get(dir, '/school/students/00000000-0000-4000-8000-0000000000bb')).statusCode,
        ).toBe(404);
        expect((await get(dir, '/school/students/no-es-uuid')).statusCode).toBe(400);
        const before = await auditCount('student.updated');
        const ok = await patch(dir, url, { familyName: '  Corregida  ', schoolCode: null });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(body(ok)).toMatchObject({ id: s.id, familyName: 'Corregida', schoolCode: null });
        expect(await auditCount('student.updated')).toBe(before + 1);
        expect((await patch(dir, url, { familyName: 'Corregida' })).statusCode).toBe(200); // sin cambios: no audita
        expect(await auditCount('student.updated')).toBe(before + 1);
        for (const bad of [
          {},
          { id: s.id },
          { isActive: false },
          { curp: 'X' },
          { givenNames: '' },
        ])
          expect((await patch(dir, url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
        const other = await newStudent({ schoolCode: 'COR-2' });
        expect(
          (await patch(dir, `/school/students/${other.id}`, { schoolCode: 'cor-2' })).statusCode,
        ).toBe(200);
        expect((await patch(dir, url, { schoolCode: 'COR-2' })).statusCode).toBe(409);
        expect(
          (
            await patch(dir, '/school/students/00000000-0000-4000-8000-0000000000bb', {
              givenNames: 'X',
            })
          ).statusCode,
        ).toBe(404);
        // el id nunca cambia
        expect((await q(`select id from students where id = $1`, [s.id])).length).toBe(1);
      });

      it('la auditoria registra IDs y nombres de campo, jamas nombres de menores ni el texto de la busqueda', async () => {
        const s = await newStudent({ givenNames: 'Secreta', familyName: 'Ficticiasecreta' });
        await patch(dir, `/school/students/${s.id}`, { givenNames: 'Cambiada' });
        await get(dir, `/school/students?q=${encodeURIComponent('Ficticiasecreta')}`);
        await get(dir, `/school/students/${s.id}`);
        const rows = await q(
          `select string_agg(details::text, ' ') as d from audit_events where event_type like 'student.%' or event_type like 'enrollment.%' or event_type like 'group_assignment.%'`,
        );
        const all = String(rows[0]!.d);
        expect(all).not.toMatch(/Secreta|Ficticiasecreta|Cambiada/);
        expect(all).toContain(s.id);
        expect(await auditCount('student.searched')).toBeGreaterThanOrEqual(1);
        expect(await auditCount('student.viewed')).toBeGreaterThanOrEqual(1);
      });

      it('desactiva (idempotente), bloquea con matricula sin baja, impide nuevas matriculas y reactiva con auditoria', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id);
        const block = await post(dir, `/school/students/${s.id}/deactivate`);
        expect(block.statusCode).toBe(409);
        expect(body(block).error.code).toBe('HAS_OPEN_ENROLLMENT');
        expect((await post(dir, `/school/enrollments/${e.id}/withdraw`, {})).statusCode).toBe(200);
        const off = await post(dir, `/school/students/${s.id}/deactivate`);
        expect(off.statusCode, off.body).toBe(200);
        expect(body(off).isActive).toBe(false);
        const count = await auditCount('student.deactivated');
        expect((await post(dir, `/school/students/${s.id}/deactivate`)).statusCode).toBe(200);
        expect(await auditCount('student.deactivated')).toBe(count);
        const inactive = await post(dir, `/school/students/${s.id}/enrollments`, {
          schoolYearId: Y.fut,
        });
        expect(inactive.statusCode).toBe(409);
        expect(body(inactive).error.code).toBe('STUDENT_INACTIVE');
        expect(
          (await get(dir, '/school/students?isActive=false&pageSize=100'))
            .json()
            .items.some((x: Json) => x.id === s.id),
        ).toBe(true);
        const on = await post(dir, `/school/students/${s.id}/reactivate`);
        expect(body(on).isActive).toBe(true);
        expect(await auditCount('student.reactivated')).toBeGreaterThanOrEqual(1);
        await enrollIn(s.id, 'fut'); // reactivado: ya puede matricularse
      });

      it('no hay rutas de borrado: DELETE responde 404', async () => {
        const s = await newStudent();
        for (const u of [
          `/school/students/${s.id}`,
          '/school/students',
          `/school/enrollments/${s.id}`,
        ])
          expect((await kit.call(dir, 'DELETE', u)).statusCode, u).toBe(404);
        expect((await q(`select 1 from students where id = $1`, [s.id])).length).toBe(1);
      });
    });

    describe('matriculas por ciclo', () => {
      it('inscribe (201) en el ciclo vigente: inicio por defecto hoy; estado active; una matricula por alumno y ciclo', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id);
        expect(e).toMatchObject({
          studentId: s.id,
          schoolYearId: Y.cur,
          startsOn: today,
          endsOn: null,
          status: 'active',
          assignments: [],
        });
        const dup = await post(dir, `/school/students/${s.id}/enrollments`, {
          schoolYearId: Y.cur,
        });
        expect(dup.statusCode).toBe(409);
        expect(body(dup).error.code).toBe('ALREADY_EXISTS');
        const f = await enrollIn(s.id, 'fut'); // otro ciclo: historial entre ciclos
        expect(f).toMatchObject({
          schoolYearId: Y.fut,
          startsOn: yr.fut.startsOn,
          status: 'upcoming',
        });
        const list = body(await get(dir, `/school/students/${s.id}/enrollments`));
        expect(list.map((x: Json) => x.schoolYearId)).toEqual([Y.fut, Y.cur]); // mas reciente primero
      });

      it('fecha de inicio retroactiva dentro del ciclo se permite y se audita como backdated; fuera del ciclo 400', async () => {
        const s = await newStudent();
        const back = await enrollIn(s.id, 'cur', addDays(today, -20));
        expect(back.startsOn).toBe(addDays(today, -20));
        const ev = (
          await q(
            `select details from audit_events where event_type = 'enrollment.created' and details->>'enrollmentId' = $1`,
            [back.id],
          )
        )[0]!;
        expect((ev.details as Json).backdated).toBe(true);
        const t = await newStudent();
        for (const startsOn of [addDays(yr.cur.startsOn, -1), addDays(yr.cur.endsOn, 1)]) {
          const r = await post(dir, `/school/students/${t.id}/enrollments`, {
            schoolYearId: Y.cur,
            startsOn,
          });
          expect(r.statusCode, startsOn).toBe(400);
          expect(body(r).error.code).toBe('OUT_OF_YEAR');
        }
        expect(
          (
            await post(dir, `/school/students/${t.id}/enrollments`, {
              schoolYearId: Y.cur,
              startsOn: yr.cur.endsOn,
            })
          ).statusCode,
        ).toBe(201); // el ultimo dia es valido
      });

      it('ciclo terminado: 409 HISTORICAL; ciclo inexistente 400; alumno inexistente 404; cuerpo con campos extra 400', async () => {
        const s = await newStudent();
        const past = await post(dir, `/school/students/${s.id}/enrollments`, {
          schoolYearId: Y.past,
        });
        expect(past.statusCode).toBe(409);
        expect(body(past).error.code).toBe('HISTORICAL');
        const unk = await post(dir, `/school/students/${s.id}/enrollments`, {
          schoolYearId: '00000000-0000-4000-8000-0000000000cc',
        });
        expect(unk.statusCode).toBe(400);
        expect(
          (
            await post(dir, '/school/students/00000000-0000-4000-8000-0000000000bb/enrollments', {
              schoolYearId: Y.cur,
            })
          ).statusCode,
        ).toBe(404);
        for (const bad of [
          {},
          { schoolYearId: Y.cur, groupId: G.A },
          { schoolYearId: Y.cur, studentId: s.id },
          { schoolYearId: 'x' },
        ])
          expect(
            (await post(dir, `/school/students/${s.id}/enrollments`, bad)).statusCode,
            JSON.stringify(bad),
          ).toBe(400);
      });

      it('diez inscripciones simultaneas del mismo alumno en el mismo ciclo: exactamente una (201), el resto 409', async () => {
        const s = await newStudent();
        const rs = await Promise.all(
          Array.from({ length: 10 }, () =>
            post(dir, `/school/students/${s.id}/enrollments`, { schoolYearId: Y.cur }),
          ),
        );
        expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
        expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(9);
        expect(
          Number(
            (await q(`select count(*)::int n from enrollments where student_id = $1`, [s.id]))[0]!
              .n,
          ),
        ).toBe(1);
      });

      it('baja: cierra la matricula y su grupo vigente en una transaccion; no se repite ni se reabre', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -30));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        const w = await post(dir, `/school/enrollments/${e.id}/withdraw`, {
          endsOn: addDays(today, 5),
        });
        expect(w.statusCode, w.body).toBe(200);
        const dto = body(w);
        expect(dto).toMatchObject({ status: 'withdrawn', endsOn: addDays(today, 5) });
        expect(dto.assignments[0]).toMatchObject({ endsOn: addDays(today, 5) });
        const twice = await post(dir, `/school/enrollments/${e.id}/withdraw`, {});
        expect(twice.statusCode).toBe(409);
        expect(body(twice).error.code).toBe('ALREADY_WITHDRAWN');
        // matricula cerrada: ni asignar ni trasladar
        expect(
          body(
            await post(dir, `/school/enrollments/${e.id}/transfer`, {
              groupId: G.B,
              effectiveOn: addDays(today, 2),
            }),
          ).error.code,
        ).toBe('ENROLLMENT_CLOSED');
        expect(
          body(await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.B }))
            .error.code,
        ).toBe('ENROLLMENT_CLOSED');
        const rows = await q(
          `select ends_on::text e from student_group_assignments where enrollment_id = $1`,
          [e.id],
        );
        expect(rows).toEqual([{ e: addDays(today, 5) }]);
        expect(await auditCount('enrollment.withdrawn')).toBeGreaterThanOrEqual(1);
      });

      it('baja con fecha invalida: antes del inicio, despues del ciclo o con periodos de grupo posteriores => 400', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -10));
        const a = await post(dir, `/school/enrollments/${e.id}/withdraw`, {
          endsOn: addDays(today, -11),
        });
        expect(a.statusCode).toBe(400);
        expect(
          (
            await post(dir, `/school/enrollments/${e.id}/withdraw`, {
              endsOn: addDays(yr.cur.endsOn, 1),
            })
          ).statusCode,
        ).toBe(400);
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        await post(dir, `/school/enrollments/${e.id}/transfer`, {
          groupId: G.B,
          effectiveOn: addDays(today, 10),
        });
        const later = await post(dir, `/school/enrollments/${e.id}/withdraw`, {
          endsOn: addDays(today, 5),
        });
        expect(later.statusCode).toBe(400);
        expect(body(later).error.code).toBe('ASSIGNMENT_AFTER_END');
        expect((await post(dir, `/school/enrollments/${e.id}/withdraw`, { x: 1 })).statusCode).toBe(
          400,
        );
        // sin cambios: la matricula sigue sin baja
        expect(
          (await q(`select ends_on from enrollments where id = $1`, [e.id]))[0]!.ends_on,
        ).toBeNull();
      });

      it('matricula de un ciclo terminado (sembrada por el propietario): baja, asignar y trasladar => 409 HISTORICAL', async () => {
        const sid = (
          await q(
            `insert into students (given_names, family_name) values ('Historica', 'Ficticia') returning id`,
          )
        )[0]!.id as string;
        const eid = (
          await q(
            `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
            [sid, Y.past, yr.past.startsOn],
          )
        )[0]!.id as string;
        await q(
          `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
          [eid, Y.past, G.PA, yr.past.startsOn],
        );
        for (const [u, b] of [
          [`/school/enrollments/${eid}/withdraw`, {}],
          [`/school/enrollments/${eid}/group-assignments`, { groupId: G.PA }],
          [
            `/school/enrollments/${eid}/transfer`,
            { groupId: G.PA, effectiveOn: addDays(yr.past.startsOn, 5) },
          ],
        ] as const) {
          const r = await post(dir, u, b);
          expect(r.statusCode, u).toBe(409);
          expect(body(r).error.code).toBe('HISTORICAL');
        }
        const h = body(await get(dir, `/school/enrollments/${eid}`));
        expect(h).toMatchObject({ status: 'completed', endsOn: null });
        expect(h.assignments[0].current).toBe(false);
      });
    });

    describe('historial de grupos y traslados', () => {
      it('asigna el primer grupo (201); grupo de otro ciclo, inexistente o inactivo se rechaza; un segundo "asignar" usa traslado', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -3));
        const url = `/school/enrollments/${e.id}/group-assignments`;
        expect(body(await post(dir, url, { groupId: G.FA })).error.code).toBe('GROUP_NOT_IN_YEAR'); // grupo de otro ciclo
        expect(
          body(await post(dir, url, { groupId: '00000000-0000-4000-8000-0000000000dd' })).error
            .code,
        ).toBe('GROUP_NOT_IN_YEAR');
        expect(body(await post(dir, url, { groupId: G.off })).error.code).toBe('GROUP_INACTIVE');
        expect(
          (await post(dir, url, { groupId: G.A, startsOn: addDays(today, -4) })).statusCode,
        ).toBe(400); // antes de la matricula
        const ok = await post(dir, url, { groupId: G.A });
        expect(ok.statusCode, ok.body).toBe(201);
        expect(body(ok).assignments).toHaveLength(1);
        expect(body(ok).assignments[0]).toMatchObject({
          startsOn: addDays(today, -3),
          endsOn: null,
          current: true,
        });
        expect(body(ok).assignments[0].group).toMatchObject({ id: G.A, code: 'A', grade: 1 });
        const again = await post(dir, url, { groupId: G.B });
        expect(again.statusCode).toBe(409);
        expect(body(again).error.code).toBe('ALREADY_ASSIGNED');
        const detail = body(await get(dir, `/school/students/${s.id}`));
        expect(detail.currentGroup).toMatchObject({ id: G.A, schoolYearName: 'Ciclo cur' });
      });

      it('traslado en fecha valida: cierra el periodo anterior el dia previo, abre el nuevo y conserva el historial', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -10));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        const before = await q(
          `select id, group_id, starts_on::text s, ends_on::text e from student_group_assignments where enrollment_id = $1`,
          [e.id],
        );
        const t = await post(dir, `/school/enrollments/${e.id}/transfer`, {
          groupId: G.B,
          effectiveOn: addDays(today, 7),
        });
        expect(t.statusCode, t.body).toBe(200);
        const as = body(t).assignments as Json[];
        expect(as).toHaveLength(2);
        expect(as[0]).toMatchObject({
          id: before[0]!.id,
          startsOn: addDays(today, -10),
          endsOn: addDays(today, 6),
          current: true,
        });
        expect(as[1]).toMatchObject({ startsOn: addDays(today, 7), endsOn: null, current: false });
        expect(as[1]!.group.id).toBe(G.B);
        // el grupo vigente HOY sigue siendo el anterior hasta la fecha efectiva (dia inclusivo)
        expect(body(await get(dir, `/school/students/${s.id}`)).currentGroup.id).toBe(G.A);
        const ev = (
          await q(
            `select details from audit_events where event_type = 'group_assignment.transferred' and details->>'enrollmentId' = $1`,
            [e.id],
          )
        )[0]!;
        expect(ev.details).toMatchObject({
          fromGroupId: G.A,
          toGroupId: G.B,
          effectiveOn: addDays(today, 7),
        });
        // el registro anterior conserva id y grupo (solo se cerro)
        const after = await q(`select id, group_id from student_group_assignments where id = $1`, [
          before[0]!.id,
        ]);
        expect(after[0]).toMatchObject({ id: before[0]!.id, group_id: before[0]!.group_id });
      });

      it('traslado con efecto HOY: el alumno cambia de grupo hoy y el dia anterior queda en el grupo previo', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -10));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        const t = await post(dir, `/school/enrollments/${e.id}/transfer`, { groupId: G.C });
        expect(t.statusCode, t.body).toBe(200);
        expect(body(t).assignments[0]).toMatchObject({
          endsOn: addDays(today, -1),
          current: false,
        });
        expect(body(t).assignments[1]).toMatchObject({
          startsOn: today,
          endsOn: null,
          current: true,
        });
        expect(body(await get(dir, `/school/students/${s.id}`)).currentGroup.id).toBe(G.C);
      });

      it('mismo dia: no hay dos grupos el mismo dia (SAME_DAY); mismo grupo (SAME_GROUP); fecha anterior o posterior al ciclo 400', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id); // empieza hoy
        const url = `/school/enrollments/${e.id}/transfer`;
        expect(body(await post(dir, url, { groupId: G.B })).error.code).toBe(
          'NO_CURRENT_ASSIGNMENT',
        );
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A }); // desde hoy
        const same = await post(dir, url, { groupId: G.B });
        expect(same.statusCode).toBe(409);
        expect(body(same).error.code).toBe('SAME_DAY'); // la asignacion vigente empezo hoy
        expect(
          body(await post(dir, url, { groupId: G.A, effectiveOn: addDays(today, 3) })).error.code,
        ).toBe('SAME_GROUP');
        expect(
          body(await post(dir, url, { groupId: G.B, effectiveOn: addDays(today, -1) })).error.code,
        ).toBe('BEFORE_CURRENT_START');
        expect(
          body(await post(dir, url, { groupId: G.B, effectiveOn: addDays(yr.cur.endsOn, 1) })).error
            .code,
        ).toBe('OUT_OF_PERIOD');
        expect(
          (await post(dir, url, { groupId: G.B, effectiveOn: yr.cur.endsOn })).statusCode,
        ).toBe(200); // ultimo dia del ciclo: valido
        expect(
          Number(
            (
              await q(
                `select count(*)::int n from student_group_assignments where enrollment_id = $1`,
                [e.id],
              )
            )[0]!.n,
          ),
        ).toBe(2);
      });

      it('grupo de otro ciclo o inexistente en un traslado: 400; grupo inactivo: 409; cuerpo con campos extra: 400', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -5));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        const url = `/school/enrollments/${e.id}/transfer`;
        expect(body(await post(dir, url, { groupId: G.FA })).error.code).toBe('GROUP_NOT_IN_YEAR');
        expect(
          body(await post(dir, url, { groupId: '00000000-0000-4000-8000-0000000000dd' })).error
            .code,
        ).toBe('GROUP_NOT_IN_YEAR');
        expect(body(await post(dir, url, { groupId: G.off })).error.code).toBe('GROUP_INACTIVE');
        for (const bad of [
          {},
          { groupId: G.B, schoolYearId: Y.cur },
          { groupId: G.B, effectiveOn: '2026-02-30' },
          { groupId: G.B, studentId: s.id },
        ])
          expect((await post(dir, url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
        expect(
          (
            await q(
              `select count(*)::int n from student_group_assignments where enrollment_id = $1`,
              [e.id],
            )
          )[0]!.n,
        ).toBe(1);
        expect(
          (
            await post(dir, '/school/enrollments/00000000-0000-4000-8000-0000000000ee/transfer', {
              groupId: G.B,
            })
          ).statusCode,
        ).toBe(404);
      });

      it('ciclo futuro: asigna al inicio del ciclo y traslada despues; el mismo dia de inicio es SAME_DAY', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'fut');
        const a = await post(dir, `/school/enrollments/${e.id}/group-assignments`, {
          groupId: G.FA,
        });
        expect(a.statusCode, a.body).toBe(201);
        expect(body(a).assignments[0]).toMatchObject({ startsOn: yr.fut.startsOn, current: false });
        const url = `/school/enrollments/${e.id}/transfer`;
        expect(
          body(await post(dir, url, { groupId: G.FB, effectiveOn: yr.fut.startsOn })).error.code,
        ).toBe('SAME_DAY');
        expect(
          (await post(dir, url, { groupId: G.FB, effectiveOn: addDays(yr.fut.startsOn, 30) }))
            .statusCode,
        ).toBe(200);
        expect(body(await get(dir, `/school/students/${s.id}`)).currentGroup).toBeNull(); // aun no empieza
      });

      it('transferencias simultaneas desde la misma matricula: una sola gana; nunca dos grupos vigentes ni traslapes', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -10));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        const rs = await Promise.all(
          Array.from({ length: 8 }, (_v, i) =>
            post(dir, `/school/enrollments/${e.id}/transfer`, {
              groupId: G[`R${i}`],
              effectiveOn: addDays(today, 1),
            }),
          ),
        );
        expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
        for (const r of rs.filter((x) => x.statusCode !== 200))
          expect(['SAME_DAY', 'CONCURRENT']).toContain(body(r).error.code);
        const open = await q(
          `select count(*)::int n from student_group_assignments where enrollment_id = $1 and ends_on is null`,
          [e.id],
        );
        expect(open[0]!.n).toBe(1);
        const rows = await q(
          `select starts_on::text s, ends_on::text e from student_group_assignments where enrollment_id = $1 order by starts_on`,
          [e.id],
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]!.e).toBe(today); // cerro el dia anterior a la fecha efectiva (hoy + 1 - 1)
      });

      it('baja y traslado simultaneos: el resultado es coherente (sin grupo abierto tras la baja)', async () => {
        const s = await newStudent();
        const e = await enrollIn(s.id, 'cur', addDays(today, -10));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        const [w, t] = await Promise.all([
          post(dir, `/school/enrollments/${e.id}/withdraw`, { endsOn: addDays(today, 3) }),
          post(dir, `/school/enrollments/${e.id}/transfer`, {
            groupId: G.B,
            effectiveOn: addDays(today, 8),
          }),
        ]);
        expect([w.statusCode, t.statusCode].filter((c) => c === 200).length).toBeGreaterThanOrEqual(
          1,
        );
        const enr = (await q(`select ends_on::text e from enrollments where id = $1`, [e.id]))[0]!;
        const open = Number(
          (
            await q(
              `select count(*)::int n from student_group_assignments where enrollment_id = $1 and ends_on is null`,
              [e.id],
            )
          )[0]!.n,
        );
        if (enr.e) expect(open).toBe(0);
        else expect(open).toBe(1);
        const bad = await q(
          `select count(*)::int n from student_group_assignments a join enrollments en on en.id = a.enrollment_id
            where en.id = $1 and en.ends_on is not null and (a.ends_on is null or a.ends_on > en.ends_on)`,
          [e.id],
        );
        expect(bad[0]!.n).toBe(0);
      });

      it('el catalogo no puede acortar un ciclo dejando matriculas o grupos fuera: 409; ampliar o renombrar si', async () => {
        const start = addDays(today, 500);
        const end = addDays(today, 800);
        const year = (
          await q(
            `insert into school_years (name, starts_on, ends_on) values ('Ciclo catalogo', $1, $2) returning id`,
            [start, end],
          )
        )[0]!.id as string;
        await q(`insert into groups (school_year_id, grade, code) values ($1, 1, 'K')`, [year]);
        const s = await newStudent();
        const enr = await post(dir, `/school/students/${s.id}/enrollments`, { schoolYearId: year });
        expect(enr.statusCode, enr.body).toBe(201);
        expect(body(enr).startsOn).toBe(start);

        const yearUrl = `/catalog/school-years/${year}`;
        const shrinkStart = await patch(dir, yearUrl, { startsOn: addDays(start, 10) });
        expect(shrinkStart.statusCode, shrinkStart.body).toBe(409);
        expect(body(shrinkStart).error.message).toMatch(/matrículas o periodos de grupo/);
        expect(
          (await q(`select starts_on::text d from school_years where id = $1`, [year]))[0]!.d,
        ).toBe(start);

        // Cerrar la matricula en el dia 100 del ciclo: el fin del ciclo ya no puede quedar antes de esa baja.
        const withdrawn = await post(dir, `/school/enrollments/${body(enr).id}/withdraw`, {
          endsOn: addDays(start, 100),
        });
        expect(withdrawn.statusCode, withdrawn.body).toBe(200);
        const shrinkEnd = await patch(dir, yearUrl, { endsOn: addDays(start, 99 + 61) });
        expect(shrinkEnd.statusCode, shrinkEnd.body).toBe(200); // 160 dias: sigue conteniendo la baja
        const cutsWithdrawal = await patch(dir, yearUrl, { endsOn: addDays(start, 70) });
        expect(cutsWithdrawal.statusCode, cutsWithdrawal.body).toBe(409); // dejaria la baja (dia 100) fuera del ciclo
        expect((await patch(dir, yearUrl, { name: 'Ciclo catalogo 2' })).statusCode).toBe(200);
        expect((await patch(dir, yearUrl, { endsOn: addDays(end, 5) })).statusCode).toBe(200);
      });

      it('lista y filtra por ciclo y grupo (alumnos vigentes en la fecha) y detalla el historial completo del alumno', async () => {
        const s = await newStudent({ givenNames: 'Filtro', familyName: 'Historial' });
        const e = await enrollIn(s.id, 'cur', addDays(today, -20));
        await post(dir, `/school/enrollments/${e.id}/group-assignments`, { groupId: G.A });
        await post(dir, `/school/enrollments/${e.id}/transfer`, {
          groupId: G.B,
          effectiveOn: addDays(today, -5),
        });
        const inB = body(await get(dir, `/school/students?groupId=${G.B}&pageSize=100`));
        expect(inB.items.some((x: Json) => x.id === s.id)).toBe(true);
        expect(inB.items.find((x: Json) => x.id === s.id).currentGroup.id).toBe(G.B);
        const inAToday = body(await get(dir, `/school/students?groupId=${G.A}&pageSize=100`));
        expect(inAToday.items.some((x: Json) => x.id === s.id)).toBe(false); // hoy ya esta en B
        const inAThen = body(
          await get(
            dir,
            `/school/students?groupId=${G.A}&asOf=${addDays(today, -15)}&pageSize=100`,
          ),
        );
        expect(inAThen.items.some((x: Json) => x.id === s.id)).toBe(true); // el historial responde por fecha
        const inYear = body(await get(dir, `/school/students?schoolYearId=${Y.cur}&pageSize=100`));
        expect(inYear.items.some((x: Json) => x.id === s.id)).toBe(true);
        const none = body(await get(dir, `/school/students?schoolYearId=${Y.fut}&q=Filtro`));
        expect(none.total).toBe(0);
        const hist = body(await get(dir, `/school/students/${s.id}/enrollments`));
        expect(hist).toHaveLength(1);
        expect(hist[0].assignments.map((a: Json) => a.group.code)).toEqual(['A', 'B']);
        expect(hist[0].assignments[0].endsOn).toBe(addDays(today, -6));
        expect(hist[0].assignments[1].startsOn).toBe(addDays(today, -5));
      });
    });

    describe('integridad y privacidad', () => {
      it('las respuestas y la auditoria no contienen secretos ni campos no modelados', async () => {
        const bodyList = (await get(dir, '/school/students?pageSize=100')).body;
        expect(bodyList).not.toMatch(
          /password|argon2|token|cookie|curp|birth|tutor|photo|phone|address/i,
        );
        const audit = String(
          (
            await q(
              `select string_agg(details::text, ' ') d from audit_events where event_type like 'student.%' or event_type like 'enrollment.%' or event_type like 'group_assignment.%'`,
            )
          )[0]!.d,
        );
        expect(audit).not.toMatch(/password|argon2|token|cookie/i);
      });

      it('sin borrado fisico: ningun alumno, matricula ni periodo de grupo se perdio durante las pruebas', async () => {
        const c = await q(
          `select (select count(*)::int from students) s, (select count(*)::int from enrollments) e, (select count(*)::int from student_group_assignments) a`,
        );
        expect(c[0]!.s).toBeGreaterThan(10);
        expect(c[0]!.e).toBeGreaterThan(5);
        expect(c[0]!.a).toBeGreaterThan(5);
        // consistencia global: ningun solapamiento ni mas de un periodo abierto por matricula
        const over = await q(
          `select count(*)::int n from student_group_assignments a join student_group_assignments b
             on a.enrollment_id = b.enrollment_id and a.id < b.id
            and daterange(a.starts_on, a.ends_on, '[]') && daterange(b.starts_on, b.ends_on, '[]')`,
        );
        expect(over[0]!.n).toBe(0);
      });
    });
  });
}
