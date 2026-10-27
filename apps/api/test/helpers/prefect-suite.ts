import { describe, expect, it } from 'vitest';
import type { AdminKit, Login } from './admin-http-suite.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * Pruebas HTTP de asignaciones de grupos a prefectura y del alcance `assigned_groups` sobre alumnos, con Fastify `inject` y un
 * rol de ejecucion NO propietario (PGlite o clúster desechable). Datos, cuentas y contrasenas FICTICIOS; nunca contra eta15_dev.
 * `mode: 'unavailable'` reproduce una base SIN los privilegios 0004: la administracion responde 503 y la prefectura ve cero filas.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function definePrefectTests(
  kit: AdminKit,
  opts: { mode: 'full' | 'unavailable' } = { mode: 'full' },
): void {
  describe(`asignaciones de prefectura (${opts.mode === 'full' ? 'con privilegios 0004' : 'sin privilegios: modulo no habilitado'})`, () => {
    const today = todayIso();
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string[]> = {};
    let dir: Login;
    let tecnico: Login;
    let pA: Login;
    let pB: Login;
    let social: Login;
    let acceso: Login;
    let pC: Login;
    let rvUser = '';
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const get = (login: Login | null, url: string) => kit.call(login, 'GET', url);
    const post = (login: Login | null, url: string, body?: unknown, extra = {}) =>
      kit.call(login, 'POST', url, { body, ...extra });
    const body = (r: { json: () => unknown }) => r.json() as Json;
    const auditCount = async (type: string) =>
      Number(
        (await q(`select count(*)::int n from audit_events where event_type = $1`, [type]))[0]!.n,
      );
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const assign = async (login: Login, userId: string, groupId: string, extra = {}) =>
      post(login, '/school/prefect-assignments', { userId, groupId, ...extra });
    const create = async (userId: string, groupId: string, extra = {}) => {
      const r = await assign(dir, userId, groupId, extra);
      expect(r.statusCode, r.body).toBe(201);
      return body(r);
    };
    const names = async (login: Login, url = '/school/students?pageSize=100') =>
      (body(await get(login, url)).items as Json[]).map((s) => `${s.givenNames} ${s.familyName}`);

    it('preparacion: ciclo, grupos, alumnos ficticios y cuentas de cada rol', async () => {
      dir = await kit.login(kit.boss);
      tecnico = await kit.login(kit.techBoss);
      pA = await kit.login(await kit.seed({ role: 'prefectura' }));
      pB = await kit.login(await kit.seed({ role: 'prefectura' }));
      pC = await kit.login(await kit.seed({ role: 'prefectura' }));
      social = await kit.login(await kit.seed({ role: 'trabajo_social' }));
      acceso = await kit.login(await kit.seed({ role: 'control_acceso' }));
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo pref', $1, $2) returning id`,
          [addDays(today, -100), addDays(today, 200)],
        )
      )[0]!.id as string;
      const grp = async (key: string, code: string, active = true) => {
        G[key] = (
          await q(
            `insert into groups (school_year_id, grade, code, is_active) values ($1, 1, $2, $3) returning id`,
            [Y.cur, code, active],
          )
        )[0]!.id as string;
      };
      await grp('A', 'A');
      await grp('B', 'B');
      await grp('C', 'C');
      await grp('off', 'OFF', false);
      for (const key of ['A', 'B', 'C']) {
        S[key] = [];
        for (let i = 0; i < 3; i += 1) {
          n += 1;
          const st = (
            await q(
              `insert into students (given_names, family_name, school_code) values ($1, $2, $3) returning id`,
              [`Alumno${alpha(n)}`, `Grupo${key}`, `PF-${key}${i}`],
            )
          )[0]!.id as string;
          const e = (
            await q(
              `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
              [st, Y.cur, addDays(today, -50)],
            )
          )[0]!.id as string;
          await q(
            `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
            [e, Y.cur, G[key], addDays(today, -50)],
          );
          S[key]!.push(st);
        }
      }
    });

    describe('autorizacion y proteccion de la API', () => {
      it('sin sesion: 401 en todas las rutas', async () => {
        for (const [m, url] of [
          ['GET', '/school/prefect-candidates'],
          ['GET', '/school/prefect-assignments'],
          ['POST', '/school/prefect-assignments'],
          ['GET', '/school/prefect-assignments/00000000-0000-4000-8000-000000000001'],
          ['POST', '/school/prefect-assignments/00000000-0000-4000-8000-000000000001/close'],
          ['POST', '/school/prefect-assignments/00000000-0000-4000-8000-000000000001/revoke'],
          ['GET', '/school/me/groups'],
          ['GET', `/school/groups/${G.A}/roster`],
        ] as const)
          expect((await kit.call(null, m, url)).statusCode, `${m} ${url}`).toBe(401);
      });

      it('mutaciones sin CSRF o sin Origin permitido: 403 y sin cambios', async () => {
        const before = Number(
          (await q(`select count(*)::int n from prefect_group_assignments`))[0]!.n,
        );
        const payload = { userId: pA.account.id, groupId: G.A };
        expect(
          (await post(dir, '/school/prefect-assignments', payload, { csrf: false })).statusCode,
        ).toBe(403);
        expect(
          (await post(dir, '/school/prefect-assignments', payload, { csrf: 'incorrecto' }))
            .statusCode,
        ).toBe(403);
        expect(
          (await post(dir, '/school/prefect-assignments', payload, { origin: false })).statusCode,
        ).toBe(403);
        expect(
          Number((await q(`select count(*)::int n from prefect_group_assignments`))[0]!.n),
        ).toBe(before);
      });

      it('admin_tecnico, trabajo social y control de acceso: 403 en todo y queda auditado; la prefectura no administra', async () => {
        const denied0 = await auditCount('authz.denied');
        const payload = { userId: pA.account.id, groupId: G.A };
        for (const who of [tecnico, social, acceso, pA]) {
          expect((await get(who, '/school/prefect-candidates')).statusCode).toBe(403);
          expect((await post(who, '/school/prefect-assignments', payload)).statusCode).toBe(403);
          expect(
            (
              await post(
                who,
                '/school/prefect-assignments/00000000-0000-4000-8000-000000000001/revoke',
                { reason: 'intento' },
              )
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await post(
                who,
                '/school/prefect-assignments/00000000-0000-4000-8000-000000000001/close',
                {},
              )
            ).statusCode,
          ).toBe(403);
        }
        for (const who of [tecnico, social, acceso])
          expect((await get(who, '/school/prefect-assignments')).statusCode).toBe(403);
        expect(await auditCount('authz.denied')).toBeGreaterThan(denied0);
        expect(
          Number((await q(`select count(*)::int n from prefect_group_assignments`))[0]!.n),
        ).toBe(0);
      });

      it('cuerpos estrictos: campos extra (p. ej. un actorId), identificadores mal formados y fechas invalidas: 400', async () => {
        const base = { userId: pA.account.id, groupId: G.A };
        for (const bad of [
          { ...base, actorId: pA.account.id },
          { ...base, createdBy: pA.account.id },
          { ...base, schoolYearId: Y.cur },
          { ...base, startsOn: '2026-13-40' },
          { ...base, endsOn: 'manana' },
          { userId: 'no-es-uuid', groupId: G.A },
          { groupId: G.A },
        ])
          expect(
            (await post(dir, '/school/prefect-assignments', bad)).statusCode,
            JSON.stringify(bad),
          ).toBe(400);
        expect((await get(dir, '/school/prefect-assignments?page=0')).statusCode).toBe(400);
        expect((await get(dir, '/school/prefect-assignments?status=otra')).statusCode).toBe(400);
        expect((await get(dir, '/school/prefect-assignments?userId=1')).statusCode).toBe(400);
        expect((await get(dir, '/school/prefect-assignments/no-es-uuid')).statusCode).toBe(400);
        expect((await get(pA, `/school/me/groups?userId=${pB.account.id}`)).statusCode).toBe(400); // jamas por parametro
        expect(
          (
            await kit.call(
              dir,
              'DELETE',
              '/school/prefect-assignments/00000000-0000-4000-8000-000000000001',
            )
          ).statusCode,
        ).toBe(404);
      });
    });

    if (opts.mode === 'unavailable') {
      it('sin privilegios 0004: la administracion responde 503 sin detalles y la prefectura ve CERO alumnos (nunca "sin filtro")', async () => {
        const r = await get(dir, '/school/prefect-assignments');
        expect(r.statusCode).toBe(503);
        expect(body(r).error.code).toBe('PREFECT_ASSIGNMENTS_UNAVAILABLE');
        expect(r.body).not.toMatch(/permission denied|prefect_group_assignments|SQLSTATE/i);
        expect((await assign(dir, pA.account.id, G.A!)).statusCode).toBe(503);
        expect((await get(pA, '/school/me/groups')).statusCode).toBe(503);
        // la consulta de alumnos sigue funcionando para Direccion y para la prefectura devuelve 0 filas
        const list = await get(pA, '/school/students');
        expect(list.statusCode).toBe(200);
        expect(body(list)).toMatchObject({ items: [], total: 0 });
        expect((await get(pA, `/school/groups/${G.A}/roster`)).statusCode).toBe(404);
        expect((await get(dir, '/school/students')).statusCode).toBe(200);
      });
      return;
    }

    describe('prefectas elegibles', () => {
      it('lista solo cuentas escolares activas con el rol de prefectura vigente; busca por nombre o correo', async () => {
        const all = body(await get(dir, '/school/prefect-candidates')) as Json[];
        const ids = all.map((c) => c.id);
        expect(ids).toEqual(expect.arrayContaining([pA.account.id, pB.account.id, pC.account.id]));
        expect(ids).not.toContain(kit.boss.id);
        expect(ids).not.toContain(kit.techBoss.id);
        expect(Object.keys(all[0]!).sort()).toEqual(['displayName', 'email', 'id']);
        const one = body(
          await get(
            dir,
            `/school/prefect-candidates?q=${encodeURIComponent(pA.account.email.slice(0, 8))}`,
          ),
        ) as Json[];
        expect(one.length).toBeGreaterThan(0);
        expect((await get(dir, '/school/prefect-candidates?q=a')).statusCode).toBe(400); // minimo 2 caracteres
      });
    });

    describe('crear asignaciones', () => {
      it('crea (201): el ciclo sale del grupo, empieza hoy y da acceso; queda auditada con IDs', async () => {
        const a = await create(pA.account.id, G.A!);
        expect(a).toMatchObject({
          status: 'active',
          grantsAccess: true,
          startsOn: today,
          endsOn: null,
          revokedAt: null,
          createdBy: kit.boss.id,
        });
        expect(a.group).toMatchObject({ id: G.A, schoolYearId: Y.cur });
        expect(await auditCount('prefect_assignment.created')).toBe(1);
        const ev = (
          await q(
            `select details from audit_events where event_type = 'prefect_assignment.created'`,
          )
        )[0]!.details as Json;
        expect(Object.keys(ev).sort()).toEqual(
          ['assignmentId', 'endsOn', 'groupId', 'schoolYearId', 'startsOn', 'userId'].sort(),
        );
      });

      it('una prefecta con varios grupos, un grupo con varias prefectas (cobertura) y una asignacion temporal', async () => {
        await create(pA.account.id, G.B!); // pA: A y B
        await create(pB.account.id, G.A!, { endsOn: addDays(today, 30) }); // cobertura temporal de A
        await create(pB.account.id, G.C!, { startsOn: addDays(today, 5) }); // futura
        const list = body(await get(dir, `/school/prefect-assignments?groupId=${G.A}`));
        expect(list.total).toBe(2);
        const statuses = body(
          await get(dir, `/school/prefect-assignments?userId=${pB.account.id}`),
        ).items.map((x: Json) => x.status);
        expect(statuses.sort()).toEqual(['active', 'upcoming']);
      });

      it('rechaza lo no elegible o invalido con el codigo correcto y sin cambios', async () => {
        const before = Number(
          (await q(`select count(*)::int n from prefect_group_assignments`))[0]!.n,
        );
        const code = async (userId: string, groupId: string, extra = {}) => {
          const r = await assign(dir, userId, groupId, extra);
          return [r.statusCode, body(r).error?.code];
        };
        expect(await code(kit.boss.id, G.C!)).toEqual([409, 'USER_NOT_ELIGIBLE']); // Direccion no es prefecta
        expect(await code(kit.techBoss.id, G.C!)).toEqual([409, 'USER_NOT_ELIGIBLE']);
        expect(await code(pC.account.id, G.off!)).toEqual([409, 'GROUP_INACTIVE']);
        expect(await code(pC.account.id, G.C!, { startsOn: addDays(today, -1) })).toEqual([
          400,
          'PAST_START',
        ]);
        expect(await code(pC.account.id, G.C!, { startsOn: addDays(today, 201) })).toEqual([
          400,
          'OUT_OF_YEAR',
        ]);
        expect(await code(pC.account.id, G.C!, { endsOn: addDays(today, 201) })).toEqual([
          400,
          'OUT_OF_YEAR',
        ]);
        expect(
          await code(pC.account.id, G.C!, {
            startsOn: addDays(today, 5),
            endsOn: addDays(today, 4),
          }),
        ).toEqual([400, 'DATES_ORDER']);
        expect(await code(pC.account.id, '00000000-0000-4000-8000-0000000000aa')).toEqual([
          400,
          'UNKNOWN_REFERENCE',
        ]);
        expect(await code('00000000-0000-4000-8000-0000000000aa', G.C!)).toEqual([
          400,
          'UNKNOWN_REFERENCE',
        ]);
        expect(await code(pA.account.id, G.A!)).toEqual([409, 'OVERLAPS_EXISTING']); // duplicado
        expect(
          await code(pA.account.id, G.A!, {
            startsOn: addDays(today, 3),
            endsOn: addDays(today, 9),
          }),
        ).toEqual([409, 'OVERLAPS_EXISTING']);
        expect(
          Number((await q(`select count(*)::int n from prefect_group_assignments`))[0]!.n),
        ).toBe(before);
      });

      it('periodos consecutivos (inclusivos) del mismo par: fin 10, inicio 11 si', async () => {
        await create(pC.account.id, G.C!, {
          startsOn: addDays(today, 10),
          endsOn: addDays(today, 19),
        });
        await create(pC.account.id, G.C!, {
          startsOn: addDays(today, 20),
          endsOn: addDays(today, 29),
        });
        const r = await assign(dir, pC.account.id, G.C!, {
          startsOn: addDays(today, 29),
          endsOn: addDays(today, 35),
        });
        expect(r.statusCode).toBe(409);
      });
    });

    describe('alcance assigned_groups en alumnos', () => {
      it('"mis grupos": solo los de HOY de quien consulta; la prefecta sin asignaciones vigentes no recibe ninguno', async () => {
        const a = body(await get(pA, '/school/me/groups'));
        expect(a.asOf).toBe(today);
        expect(a.groups.map((x: Json) => x.group.code).sort()).toEqual(['A', 'B']);
        expect(Object.keys(a.groups[0]).sort()).toEqual([
          'assignmentId',
          'endsOn',
          'group',
          'startsOn',
        ]);
        const b = body(await get(pB, '/school/me/groups'));
        expect(b.groups.map((x: Json) => x.group.code)).toEqual(['A']); // C empieza en 5 dias; A es cobertura
        const c = body(await get(pC, '/school/me/groups'));
        expect(c.groups).toEqual([]); // sus periodos empiezan en el futuro
      });

      it('lista, busqueda, paginacion y total salen filtrados en la consulta; prefecta sin grupos: cero resultados', async () => {
        const a = await names(pA);
        expect(a).toHaveLength(6);
        expect(a.every((x) => /Grupo[AB]$/.test(x))).toBe(true);
        expect(body(await get(pA, '/school/students?pageSize=100')).total).toBe(6);
        const page = body(await get(pA, '/school/students?pageSize=4&page=2'));
        expect(page.total).toBe(6);
        expect(page.items).toHaveLength(2);
        expect(await names(pB)).toHaveLength(3); // solo A (la C futura no cuenta)
        // buscar un alumno de un grupo ajeno no lo revela ni cambia el total
        const foreign = body(await get(pB, '/school/students?q=GrupoC')).total;
        expect(foreign).toBe(0);
        expect(body(await get(pA, '/school/students?q=GrupoA')).total).toBe(3);
        const none = body(await get(pC, '/school/students'));
        expect(none).toMatchObject({ items: [], total: 0 });
      });

      it('el filtro groupId solo acota dentro del alcance; ciclo y fecha pasada no estan disponibles con alcance limitado', async () => {
        expect(body(await get(pB, `/school/students?groupId=${G.B}`))).toMatchObject({
          items: [],
          total: 0,
        });
        expect(body(await get(pA, `/school/students?groupId=${G.B}`)).total).toBe(3);
        const r = await get(pA, `/school/students?schoolYearId=${Y.cur}`);
        expect([r.statusCode, body(r).error.code]).toEqual([400, 'FILTER_NOT_ALLOWED']);
        const r2 = await get(pA, `/school/students?asOf=${addDays(today, -10)}`);
        expect([r2.statusCode, body(r2).error.code]).toEqual([400, 'FILTER_NOT_ALLOWED']);
        // Direccion conserva sus filtros
        expect((await get(dir, `/school/students?schoolYearId=${Y.cur}`)).statusCode).toBe(200);
      });

      it('proyeccion minima: nombre, estado y grupo vigente; sin codigo escolar, sellos ni expediente', async () => {
        const item = body(await get(pA, '/school/students?pageSize=1')).items[0];
        expect(Object.keys(item).sort()).toEqual([
          'currentGroup',
          'familyName',
          'givenNames',
          'id',
          'isActive',
        ]);
        const detail = body(await get(pA, `/school/students/${S.A![0]}`));
        expect(Object.keys(detail).sort()).toEqual([
          'currentGroup',
          'familyName',
          'givenNames',
          'id',
          'isActive',
        ]);
        // buscar por codigo equivale a leerlo: la prefecta no puede; Direccion si
        expect(body(await get(pA, '/school/students?q=PF-A0')).total).toBe(0);
        expect(body(await get(dir, '/school/students?q=PF-A0')).total).toBe(1);
        expect(Object.keys(body(await get(dir, '/school/students?pageSize=1')).items[0])).toContain(
          'schoolCode',
        );
      });

      it('detalle ajeno: 404 identico al de un alumno inexistente; expediente y matriculas no expuestos (403 por permiso)', async () => {
        const foreign = await get(pA, `/school/students/${S.C![0]}`);
        const missing = await get(pA, '/school/students/00000000-0000-4000-8000-0000000000bb');
        expect(foreign.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        expect(foreign.body.replace(/"requestId":"[^"]*"/, '')).toBe(
          missing.body.replace(/"requestId":"[^"]*"/, ''),
        );
        for (const sid of [S.A![0], S.C![0]]) {
          expect((await get(pA, `/school/students/${sid}/enrollments`)).statusCode).toBe(403);
        }
        const enr = (await q(`select id from enrollments where student_id = $1`, [S.A![0]]))[0]!.id;
        expect((await get(pA, `/school/enrollments/${enr}`)).statusCode).toBe(403);
        // sin escritura
        expect(
          (await post(pA, '/school/students', { givenNames: 'X', familyName: 'Y' })).statusCode,
        ).toBe(403);
        expect(
          (await post(pA, `/school/enrollments/${enr}/transfer`, { groupId: G.B })).statusCode,
        ).toBe(403);
      });

      it('horizontal: dos prefectas con grupos distintos no se ven; la cobertura compartida ve lo mismo', async () => {
        const onlyA = await names(pA);
        const onlyB = await names(pB);
        const shared = onlyA.filter((x) => onlyB.includes(x));
        expect(shared).toHaveLength(3); // grupo A, atendido por ambas
        expect(onlyB.every((x) => /GrupoA$/.test(x))).toBe(true);
        expect((await get(pB, `/school/students/${S.B![0]}`)).statusCode).toBe(404);
        expect((await get(pA, `/school/students/${S.A![0]}`)).statusCode).toBe(200);
        expect((await get(pB, `/school/students/${S.A![0]}`)).statusCode).toBe(200);
      });
    });

    describe('lista de grupo para Android (contrato minimo)', () => {
      it('devuelve solo id y nombre de los alumnos de HOY de un grupo autorizado, filtrados en el servidor', async () => {
        const r = await get(pA, `/school/groups/${G.B}/roster`);
        expect(r.statusCode).toBe(200);
        const j = body(r);
        expect(j.asOf).toBe(today);
        expect(j.group).toMatchObject({ id: G.B, code: 'B' });
        expect(j.students).toHaveLength(3);
        expect(Object.keys(j.students[0]).sort()).toEqual(['familyName', 'givenNames', 'id']);
        expect(r.body).not.toMatch(/PF-|schoolCode|createdAt|enrollment/i);
        expect(await auditCount('roster.viewed')).toBeGreaterThan(0);
      });

      it('grupo no asignado, futuro o inexistente: 404 indistinguible; prefecta sin grupos: 404; Direccion: cualquier grupo', async () => {
        const a = await get(pB, `/school/groups/${G.B}/roster`); // no asignado a pB
        const b = await get(pB, `/school/groups/${G.C}/roster`); // asignacion futura
        const c = await get(pB, '/school/groups/00000000-0000-4000-8000-0000000000cc/roster');
        const d = await get(pC, `/school/groups/${G.A}/roster`);
        for (const r of [a, b, c, d]) expect(r.statusCode).toBe(404);
        const norm = (x: { body: string }) => x.body.replace(/"requestId":"[^"]*"/, '');
        expect(norm(a)).toBe(norm(c));
        expect(norm(d)).toBe(norm(c));
        expect(body(await get(dir, `/school/groups/${G.C}/roster`)).students).toHaveLength(3);
        expect((await get(tecnico, `/school/groups/${G.A}/roster`)).statusCode).toBe(403);
        expect((await get(social, `/school/groups/${G.A}/roster`)).statusCode).toBe(403);
      });

      it('un alumno trasladado deja de aparecer en el grupo anterior y aparece en el nuevo (hoy)', async () => {
        // el traslado lo hace Direccion: la lista de hoy cambia para quien tenga cada grupo
        const sid = S.C![2]!;
        const enr = (await q(`select id from enrollments where student_id = $1`, [sid]))[0]!
          .id as string;
        const r = await post(dir, `/school/enrollments/${enr}/transfer`, {
          groupId: G.A,
          effectiveOn: addDays(today, 1),
        });
        expect(r.statusCode, r.body).toBe(200);
        // hoy sigue en C; manana estara en A (el modelo trabaja con dias)
        expect(body(await get(pA, `/school/groups/${G.A}/roster`)).students).toHaveLength(3);
        expect(body(await get(dir, `/school/groups/${G.C}/roster`)).students).toHaveLength(3);
      });
    });

    describe('cierre, revocacion e historial', () => {
      it('cierre programado: hoy sigue vigente (fin inclusivo); extender o cerrar antes de hoy no', async () => {
        const a = await create(pC.account.id, G.B!, { startsOn: today });
        expect(
          body(await get(pC, '/school/me/groups')).groups.map((x: Json) => x.group.code),
        ).toEqual(['B']);
        const closed = await post(dir, `/school/prefect-assignments/${a.id}/close`, {
          endsOn: today,
        });
        expect(closed.statusCode, closed.body).toBe(200);
        expect(body(closed)).toMatchObject({ endsOn: today, status: 'active', grantsAccess: true });
        expect(body(await get(pC, '/school/me/groups')).groups).toHaveLength(1); // hoy aun cuenta
        const ext = await post(dir, `/school/prefect-assignments/${a.id}/close`, {
          endsOn: addDays(today, 5),
        });
        expect([ext.statusCode, body(ext).error.code]).toEqual([409, 'CANNOT_EXTEND']);
        const past = await post(dir, `/school/prefect-assignments/${a.id}/close`, {
          endsOn: addDays(today, -1),
        });
        expect(past.statusCode).toBe(400);
        expect(
          (await post(dir, `/school/prefect-assignments/${a.id}/close`, { endsOn: today }))
            .statusCode,
        ).toBe(200); // idempotente
        const wrong = await post(dir, `/school/prefect-assignments/${a.id}/close`, {
          endsOn: 'ayer',
        });
        expect(wrong.statusCode).toBe(400);
      });

      it('revocacion inmediata: el acceso se pierde en la siguiente peticion, el historial se conserva y no se reabre', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        rvUser = acc.id;
        const pR = await kit.login(acc);
        const a = await create(acc.id, G.A!, { startsOn: today });
        expect((await names(pR)).length).toBe(3);
        expect((await get(pR, `/school/groups/${G.A}/roster`)).statusCode).toBe(200);
        const r = await post(dir, `/school/prefect-assignments/${a.id}/revoke`, {
          reason: 'Cambio de comision',
        });
        expect(r.statusCode, r.body).toBe(200);
        expect(body(r)).toMatchObject({
          status: 'revoked',
          grantsAccess: false,
          revokedBy: kit.boss.id,
        });
        expect(body(r).revokedAt).toBeTruthy();
        // inmediato
        expect(await names(pR)).toEqual([]);
        expect((await get(pR, `/school/groups/${G.A}/roster`)).statusCode).toBe(404);
        expect((await get(pR, `/school/students/${S.A![0]}`)).statusCode).toBe(404);
        // historial conservado y no se reabre ni se vuelve a revocar ni a cerrar
        expect(
          (await post(dir, `/school/prefect-assignments/${a.id}/revoke`, { reason: 'otra vez' }))
            .statusCode,
        ).toBe(409);
        expect(
          (await post(dir, `/school/prefect-assignments/${a.id}/close`, { endsOn: today }))
            .statusCode,
        ).toBe(409);
        const hist = body(
          await get(dir, `/school/prefect-assignments?userId=${acc.id}&status=revoked`),
        );
        expect(hist.items.map((x: Json) => x.id)).toContain(a.id);
        // la fila revocada no bloquea una asignacion nueva del mismo par (es una decision nueva)
        const again = await create(acc.id, G.A!, { startsOn: today });
        expect(again.id).not.toBe(a.id);
        expect((await names(pR)).length).toBe(3);
        await post(dir, `/school/prefect-assignments/${again.id}/revoke`, {
          reason: 'Fin de la prueba',
        });
        // auditoria con IDs, sin el texto del motivo
        const ev = (
          await q(
            `select details from audit_events where event_type = 'prefect_assignment.revoked' order by occurred_at desc limit 1`,
          )
        )[0]!.details as Json;
        expect(Object.keys(ev).sort()).toEqual([
          'assignmentId',
          'groupId',
          'reasonLength',
          'userId',
        ]);
        expect(JSON.stringify(ev)).not.toContain('Fin de la prueba');
      });

      it('motivo obligatorio y limpio; la prefecta (alcance propio) ve sus asignaciones sin quien asigno ni el motivo', async () => {
        const list = body(
          await get(dir, `/school/prefect-assignments?userId=${pA.account.id}&status=active`),
        );
        const id = list.items[0].id as string;
        for (const reason of [undefined, '', 'ab', 'x'.repeat(201), 'con\nsalto'])
          expect(
            (await post(dir, `/school/prefect-assignments/${id}/revoke`, { reason })).statusCode,
          ).toBe(400);
        expect(
          (
            await post(dir, `/school/prefect-assignments/${id}/revoke`, {
              reason: 'valido',
              otro: 1,
            })
          ).statusCode,
        ).toBe(400);
        const own = body(await get(pA, '/school/prefect-assignments'));
        expect(own.total).toBeGreaterThan(0);
        expect(own.items.every((x: Json) => x.user.id === pA.account.id)).toBe(true);
        expect(
          own.items.every(
            (x: Json) =>
              x.createdBy === null && x.revokedBy === null && x.revocationReason === null,
          ),
        ).toBe(true);
        // no puede ampliar el alcance con userId, ni ver una ajena por id
        expect(
          body(await get(pA, `/school/prefect-assignments?userId=${pB.account.id}`)).total,
        ).toBe(0);
        const others = body(await get(dir, `/school/prefect-assignments?userId=${pB.account.id}`))
          .items[0].id;
        expect((await get(pA, `/school/prefect-assignments/${others}`)).statusCode).toBe(404);
        expect((await get(pA, `/school/prefect-assignments/${id}`)).statusCode).toBe(200);
        // Direccion ve el motivo
        const revoked = body(
          await get(dir, `/school/prefect-assignments?userId=${rvUser}&status=revoked`),
        ).items[0];
        expect(revoked.revocationReason).toBeTruthy();
      });

      it('listado de Direccion: filtros por ciclo, grupo y estado, paginacion y orden estable', async () => {
        const all = body(await get(dir, '/school/prefect-assignments?pageSize=2'));
        expect(all.items).toHaveLength(2);
        expect(all.total).toBeGreaterThan(4);
        const p2 = body(await get(dir, '/school/prefect-assignments?pageSize=2&page=2'));
        expect(p2.items.map((x: Json) => x.id)).not.toEqual(
          expect.arrayContaining(all.items.map((x: Json) => x.id)),
        );
        expect(
          body(
            await get(dir, `/school/prefect-assignments?schoolYearId=${Y.cur}&status=upcoming`),
          ).items.every((x: Json) => x.status === 'upcoming'),
        ).toBe(true);
        expect(body(await get(dir, `/school/prefect-assignments?groupId=${G.off}`)).total).toBe(0);
      });
    });

    describe('estado actual de la cuenta, del rol y del grupo (se evalua en cada peticion)', () => {
      it('grupo desactivado: la asignacion sigue en el historial pero deja de dar acceso', async () => {
        const g = (
          await q(
            `insert into groups (school_year_id, grade, code) values ($1, 3, 'TMP') returning id`,
            [Y.cur],
          )
        )[0]!.id as string;
        const a = await create(pC.account.id, g, { startsOn: today });
        expect(
          body(await get(pC, '/school/me/groups')).groups.map((x: Json) => x.group.code),
        ).toContain('TMP');
        await q(`update groups set is_active = false where id = $1`, [g]);
        expect(
          body(await get(pC, '/school/me/groups')).groups.map((x: Json) => x.group.code),
        ).not.toContain('TMP');
        const row = body(await get(dir, `/school/prefect-assignments/${a.id}`));
        expect(row).toMatchObject({ status: 'active', grantsAccess: false });
      });

      it('rol de prefectura revocado: pierde sesiones y acceso; el historial queda; reasignar el rol NO revive asignaciones previas', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const lg = await kit.login(acc);
        const a = await create(acc.id, G.A!, { startsOn: today });
        expect((await names(lg)).length).toBe(3);
        await q(
          `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
          [acc.id, kit.boss.id],
        );
        expect((await get(lg, '/school/students')).statusCode).toBe(401); // sesiones revocadas por el trigger
        const stillThere = body(await get(dir, `/school/prefect-assignments/${a.id}`));
        expect(stillThere).toMatchObject({ status: 'active', grantsAccess: false });
        // se le vuelve a conceder el rol: las asignaciones anteriores no reviven, hay que asignar de nuevo
        await q(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source) select $1, id, 'school', $2, 'grant' from roles where key = 'prefectura'`,
          [acc.id, kit.boss.id],
        );
        const lg2 = await kit.login(acc);
        expect(await names(lg2)).toEqual([]);
        expect(body(await get(lg2, '/school/me/groups')).groups).toEqual([]);
        expect(body(await get(dir, `/school/prefect-assignments/${a.id}`)).grantsAccess).toBe(
          false,
        );
        // y ya vuelve a ser elegible: una asignacion NUEVA si da acceso
        await post(dir, `/school/prefect-assignments/${a.id}/revoke`, {
          reason: 'Reasignar tras volver a conceder el rol',
        });
        await create(acc.id, G.A!, { startsOn: today });
        expect((await names(lg2)).length).toBe(3);
      });

      it('cuenta desactivada o bloqueada: sin acceso inmediato, sin tocar el historial', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const lg = await kit.login(acc);
        const a = await create(acc.id, G.B!, { startsOn: today });
        expect((await names(lg)).length).toBe(3);
        await q(`update users set status = 'disabled' where id = $1`, [acc.id]);
        expect((await get(lg, '/school/students')).statusCode).toBe(401);
        expect(body(await get(dir, `/school/prefect-assignments/${a.id}`))).toMatchObject({
          grantsAccess: false,
        });
        // una cuenta inactiva deja de ser elegible
        const ids = (body(await get(dir, '/school/prefect-candidates')) as Json[]).map((c) => c.id);
        expect(ids).not.toContain(acc.id);
        expect((await assign(dir, acc.id, G.C!)).statusCode).toBe(409);
      });

      it('sesion revocada: 401 inmediato', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const lg = await kit.login(acc);
        await create(acc.id, G.B!, { startsOn: today });
        expect((await get(lg, '/school/me/groups')).statusCode).toBe(200);
        await q(
          `update sessions set revoked_at = now(), revoked_reason = 'admin' where user_id = $1`,
          [acc.id],
        );
        expect((await get(lg, '/school/me/groups')).statusCode).toBe(401);
      });
    });

    describe('integridad con el catalogo', () => {
      it('el catalogo no puede acortar un ciclo dejando asignaciones de prefectura fuera: 409; ampliar o renombrar si', async () => {
        const start = addDays(today, 500);
        const year = (
          await q(
            `insert into school_years (name, starts_on, ends_on) values ('Ciclo pref catalogo', $1, $2) returning id`,
            [start, addDays(today, 800)],
          )
        )[0]!.id as string;
        const g = (
          await q(
            `insert into groups (school_year_id, grade, code) values ($1, 3, 'K') returning id`,
            [year],
          )
        )[0]!.id as string;
        const acc = await kit.seed({ role: 'prefectura' });
        const a = await create(acc.id, g, {
          startsOn: addDays(start, 10),
          endsOn: addDays(start, 100),
        });
        const url = `/catalog/school-years/${year}`;
        const patch = (b: unknown) => kit.call(dir, 'PATCH', url, { body: b });
        const early = await patch({ startsOn: addDays(start, 11) }); // la asignacion empieza el dia 10
        expect([early.statusCode, body(early).error.message]).toEqual([
          409,
          expect.stringMatching(/asignaciones de prefectura/),
        ]);
        const late = await patch({ endsOn: addDays(start, 90) }); // la asignacion termina el dia 100
        expect(late.statusCode, late.body).toBe(409);
        expect((await patch({ name: 'Ciclo pref catalogo 2' })).statusCode).toBe(200);
        expect((await patch({ endsOn: addDays(start, 120) })).statusCode).toBe(200); // acortar sin dejar fuera
        // la asignacion revocada sigue siendo historia: tambien impide dejarla fuera del ciclo
        await post(dir, `/school/prefect-assignments/${a.id}/revoke`, {
          reason: 'Prueba de integridad',
        });
        expect((await patch({ endsOn: addDays(start, 99) })).statusCode).toBe(409);
      });
    });

    describe('privacidad y auditoria', () => {
      it('las respuestas y los registros no contienen secretos ni campos no modelados', async () => {
        const text = JSON.stringify(
          body(await get(dir, '/school/prefect-assignments?pageSize=100')),
        );
        expect(text).not.toMatch(/password|hash|token|cookie|csrf/i);
        for (const secret of kit.secrets) expect(text).not.toContain(secret);
        for (const line of kit.logs)
          for (const secret of kit.secrets) expect(line).not.toContain(secret);
        const events = await q(
          `select details from audit_events where event_type like 'prefect_assignment.%' or event_type = 'roster.viewed'`,
        );
        const dump = JSON.stringify(events);
        expect(dump).not.toMatch(/Alumno|Grupo[ABC]|Persona de prueba|PF-/);
      });

      it('sin borrado fisico: ninguna asignacion se perdio durante las pruebas', async () => {
        const total = Number(
          (await q(`select count(*)::int n from prefect_group_assignments`))[0]!.n,
        );
        const viaApi = body(await get(dir, '/school/prefect-assignments?pageSize=100')).total;
        expect(viaApi).toBe(total);
        expect(total).toBeGreaterThan(10);
      });
    });
  });
}
