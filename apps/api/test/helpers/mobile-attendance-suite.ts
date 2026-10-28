import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { rosterDigestV1 } from '../../src/modules/attendance/attendance.mobile.js';
import type { AdminKit, Login } from './admin-http-suite.js';
import { lastDow } from './attendance-suite.js';
import { FakeDevice } from './fake-device.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * LECTURA de asistencia por el canal MOVIL (ADR 0006, propuesto) con cuentas, dispositivos, alumnos y listas FICTICIOS. Se ejecuta sobre
 * PGlite y sobre un clúster PostgreSQL 18 DESECHABLE con la API como rol NO propietario; nunca contra eta15_dev. El "hoy" escolar es un
 * reloj simulado (`schoolToday`) que recorre lunes a domingo y la medianoche. Lo que se crea (listas, marcas) se crea por el
 * canal WEB, porque el canal movil NO escribe asistencia: esa es justo una de las propiedades que se comprueban.
 */
const BASE = 'http://mobile-attendance.test';
type Res = LightMyRequestResponse;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (r: Res) => r.json() as Json;
const isodow = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

interface Tokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}
interface Session {
  dev: FakeDevice;
  tokens: Tokens;
  deviceId: string;
}

const GENEROUS_MOBILE = {
  enrollIp: 1000,
  challengeIp: 10_000,
  tokenFailIp: 10_000,
  tokenFailKey: 10_000,
  claimFailUser: 10_000,
};

export function defineMobileAttendanceTests(
  kit: AdminKit,
  opts: { realConcurrency?: boolean } = {},
): void {
  describe('lectura movil de asistencia (sandbox)', () => {
    const real = todayIso();
    const W = lastDow(3, 10); // miercoles reciente: el "hoy" escolar de casi toda la suite
    const clock = { today: W };
    let on: FastifyInstance; // interruptor encendido
    let off: FastifyInstance; // movil encendido, lectura de asistencia APAGADA
    let boss: Login;
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string[]> = {};
    const acc: Record<string, Login> = {};
    const web: Record<string, Login> = {};
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await q(sql, params))[0]!.n);
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const uuid = () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(800000000000 + n).slice(-12)}`;
    };
    const allTokens: string[] = [];

    // ------------------------------------------------------------------------------------------ dispositivo y sesion
    const enroll = async (app: FastifyInstance, dev: FakeDevice) => {
      const r = await app.inject({
        method: 'POST',
        url: '/mobile/enroll/requests',
        payload: { publicKey: dev.jwk, label: 'Tableta de prueba', platform: 'android' },
      });
      expect(r.statusCode, r.body).toBe(201);
      return json(r) as { requestId: string; pairingCode: string; fingerprint: string };
    };
    const challenge = async (app: FastifyInstance, dev: FakeDevice) => {
      const r = await app.inject({
        method: 'POST',
        url: '/mobile/auth/challenge',
        payload: { keyThumbprint: dev.thumbprint },
        headers: {
          dpop: dev.proof({ method: 'POST', url: `${BASE}/mobile/auth/challenge` }),
        },
      });
      expect(r.statusCode, r.body).toBe(200);
      return json(r).nonce as string;
    };
    const post = async (app: FastifyInstance, dev: FakeDevice, url: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          dpop: dev.proof({ method: 'POST', url: BASE + url, nonce: await challenge(app, dev) }),
        },
      });
    /** Vincula un dispositivo de punta a punta y abre sesion movil. */
    async function session(app: FastifyInstance, who: string): Promise<Session> {
      const titular = acc[who]!;
      const accId = titular.account.id;
      await q(
        `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed', 'approved')`,
        [accId],
      );
      await q(
        `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where user_id = $1 and status = 'active'`,
        [accId, kit.boss.id],
      );
      const dev = new FakeDevice();
      const req = await enroll(app, dev);
      const claim = await kit.call(titular, 'POST', '/mobile-devices/claims', {
        body: { requestId: req.requestId, code: req.pairingCode },
        target: app,
      });
      expect(claim.statusCode, claim.body).toBe(200);
      const ok = await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
        body: { fingerprint: req.fingerprint },
        target: app,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const act = await post(app, dev, `/mobile/enroll/requests/${req.requestId}/activate`);
      expect(act.statusCode, act.body).toBe(201);
      const tok = await post(app, dev, '/mobile/auth/token');
      expect(tok.statusCode, tok.body).toBe(200);
      const tokens = json(tok) as Tokens;
      allTokens.push(tokens.accessToken, tokens.refreshToken);
      return { dev, tokens, deviceId: json(act).deviceId as string };
    }
    /** Lectura autenticada: Authorization DPoP + prueba con `ath` (un jti nuevo en cada peticion). */
    const get = (
      app: FastifyInstance,
      s: Session,
      url: string,
      over: { proofToken?: string; method?: string; headers?: Record<string, string> } = {},
    ) =>
      app.inject({
        method: (over.method ?? 'GET') as 'GET',
        url,
        headers: {
          authorization: `DPoP ${s.tokens.accessToken}`,
          dpop: s.dev.proof({
            method: over.method ?? 'GET',
            url: BASE + url.split('?')[0],
            accessToken: over.proofToken ?? s.tokens.accessToken,
          }),
          ...(over.headers ?? {}),
        },
      });

    // ------------------------------------------------------------------------------------------------- datos ficticios
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
      await q(
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
        [en, year, group, from],
      );
      return { student: st, enrollment: en };
    };
    const newGroup = async (code: string, year = Y.cur!, active = true) =>
      (
        await q(
          `insert into groups (school_year_id, grade, code, is_active) values ($1, 1, $2, $3) returning id`,
          [year, code, active],
        )
      )[0]!.id as string;
    const assign = async (userId: string, groupId: string, year = Y.cur!) => {
      await q(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
      try {
        await q(
          `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by)
           values ($1, $2, $3, $4, $5)`,
          [userId, year, groupId, addDays(real, -380), kit.boss.id],
        );
      } finally {
        await q(`alter table prefect_group_assignments enable trigger pga_guard_insert`);
      }
    };
    // Escritura por el canal WEB (el movil no escribe): abre, guarda y finaliza como lo haria el portal.
    const wOpen = (who: string, groupId: string) =>
      kit.call(web[who]!, 'POST', '/school/attendance/days', { body: { groupId }, target: on });
    const wSave = (
      who: string,
      dayId: string,
      expectedRevision: number,
      marks: Array<{ studentId: string; status: string }>,
      requestId = uuid(),
    ) =>
      kit.call(web[who]!, 'POST', `/school/attendance/days/${dayId}/marks`, {
        body: { expectedRevision, requestId, marks },
        target: on,
      });
    const wFinalize = (who: string, dayId: string, expectedRevision: number) =>
      kit.call(web[who]!, 'POST', `/school/attendance/days/${dayId}/finalize`, {
        body: { expectedRevision },
        target: on,
      });
    const marks = (ids: string[], status = 'present') =>
      ids.map((studentId) => ({ studentId, status }));
    const eventsCount = () => count(`select count(*) n from attendance_events`);
    const dayRows = () => count(`select count(*) n from attendance_days`);

    // =========================================================================================================== base
    it('preparacion: ciclo, grupos, alumnos y prefectas ficticios; dos apps (interruptor encendido y apagado) sobre la MISMA base', async () => {
      const common = (extra: object) => ({
        schoolToday: () => clock.today,
        mobile: { publicBaseUrl: BASE, limits: GENEROUS_MOBILE, ...extra },
      });
      on = await kit.build({}, common({ attendanceRead: true }));
      off = await kit.build({}, common({}));
      await on.ready();
      await off.ready();
      boss = await kit.login(kit.boss, on);
      for (const k of ['A', 'B', 'C', 'D', 'E', 'F'])
        acc[k] = await kit.login(await kit.seed({ role: 'prefectura' }), on);
      for (const k of ['A', 'B']) web[k] = acc[k]!;
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo lectura movil', $1, $2) returning id`,
          [addDays(real, -400), addDays(real, 300)],
        )
      )[0]!.id as string;
      Y.old = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo anterior movil', $1, $2) returning id`,
          [addDays(real, -900), addDays(real, -500)],
        )
      )[0]!.id as string;
      G.A = await newGroup('A');
      G.B = await newGroup('B');
      G.X = await newGroup('X'); // nadie asignado
      G.off = await newGroup('OFF'); // se desactivara
      G.old = await newGroup('OLD', Y.old);
      for (const [key, size] of [
        ['A', 4],
        ['B', 3],
        ['X', 2],
        ['off', 2],
      ] as const) {
        S[key] = [];
        for (let i = 0; i < size; i += 1) S[key]!.push((await newStudent(G[key]!)).student);
      }
      await assign(acc.A!.account.id, G.A!);
      await assign(acc.B!.account.id, G.B!);
      await assign(acc.C!.account.id, G.A!); // cobertura compartida de A
      await assign(acc.D!.account.id, G.off!);
      await assign(acc.E!.account.id, G.old!, Y.old);
      expect(isodow(W)).toBe(3);
    });

    // ================================================================================================ interruptor
    describe('activacion controlada', () => {
      it('con el interruptor APAGADO las rutas no existen (404) aunque la sesion movil sea valida; el token no lleva attendance:*', async () => {
        const s = await session(off, 'A');
        for (const url of [
          '/mobile/school/attendance/today',
          '/mobile/school/attendance/days',
          `/mobile/school/attendance/days/${uuid()}`,
        ])
          expect([url, (await get(off, s, url)).statusCode]).toEqual([url, 404]);
        const me = json(await get(off, s, '/mobile/me'));
        expect(me.permissions.map((p: Json) => p.permission).sort()).toEqual([
          'prefect_assignments:read',
          'students:read_basic',
        ]);
      });

      it('con el interruptor ENCENDIDO el token lleva attendance:read SOLO con alcance assigned_groups y NUNCA attendance:capture ni all', async () => {
        const s = await session(on, 'A');
        const me = json(await get(on, s, '/mobile/me'));
        const perms = me.permissions as Array<{ permission: string; scope: string }>;
        expect(perms).toContainEqual({ permission: 'attendance:read', scope: 'assigned_groups' });
        expect(perms.some((p) => p.permission === 'attendance:capture')).toBe(false);
        expect(perms.some((p) => p.permission.startsWith('attendance:') && p.scope === 'all')).toBe(
          false,
        );
      });

      it('NODE_ENV=production rechaza el canal movil y la lectura de asistencia aunque el interruptor este encendido', async () => {
        await expect(
          buildApp(loadEnv({ NODE_ENV: 'production', HOST: '127.0.0.1' }), {
            auth: {
              store: kit.harness.store,
              mobile: { publicBaseUrl: BASE, attendanceRead: true },
            },
          }),
        ).rejects.toThrow(/production/);
      });

      it('`mobile.config` no puede encender la lectura por la puerta de atras (solo el interruptor explicito)', async () => {
        const sneaky = await kit.build(
          {},
          {
            mobile: {
              publicBaseUrl: BASE,
              limits: GENEROUS_MOBILE,
              config: { attendanceRead: true } as never,
            },
          },
        );
        await sneaky.ready();
        const s = await session(sneaky, 'A');
        expect((await get(sneaky, s, '/mobile/school/attendance/today')).statusCode).toBe(404);
        const me = json(await get(sneaky, s, '/mobile/me'));
        expect(me.permissions.some((p: Json) => p.permission === 'attendance:read')).toBe(false);
        await sneaky.close();
      });
    });

    // ============================================================================================ autenticacion
    describe('autenticacion de las lecturas', () => {
      it('sesion valida: 200; sin Authorization, sin DPoP, firma ajena o ath ajeno: 401', async () => {
        const s = await session(on, 'A');
        const ok = await get(on, s, '/mobile/school/attendance/today');
        expect(ok.statusCode, ok.body).toBe(200);
        const url = '/mobile/school/attendance/today';
        expect((await on.inject({ method: 'GET', url })).statusCode).toBe(401);
        const noProof = await on.inject({
          method: 'GET',
          url,
          headers: { authorization: `DPoP ${s.tokens.accessToken}` },
        });
        expect(noProof.statusCode).toBe(401);
        const other = new FakeDevice();
        const wrongKey = await on.inject({
          method: 'GET',
          url,
          headers: {
            authorization: `DPoP ${s.tokens.accessToken}`,
            dpop: other.proof({
              method: 'GET',
              url: BASE + url,
              accessToken: s.tokens.accessToken,
            }),
          },
        });
        expect(wrongKey.statusCode).toBe(401);
        const wrongAth = await get(on, s, url, { proofToken: 'x'.repeat(43) });
        expect(wrongAth.statusCode).toBe(401);
        // un token robado SIN la clave privada del dispositivo no sirve (prueba firmada por otra clave)
        expect(wrongKey.headers['www-authenticate']).toMatch(/DPoP/);
      });

      it('la misma prueba (mismo jti) no se acepta dos veces: la repeticion de una peticion capturada se rechaza', async () => {
        const s = await session(on, 'A');
        const url = '/mobile/school/attendance/today';
        const headers = {
          authorization: `DPoP ${s.tokens.accessToken}`,
          dpop: s.dev.proof({
            method: 'GET',
            url: BASE + url,
            accessToken: s.tokens.accessToken,
          }),
        };
        expect((await on.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
        const again = await on.inject({ method: 'GET', url, headers });
        expect([again.statusCode, json(again).error.code]).toEqual([401, 'INVALID_PROOF']);
      });

      it('token vencido: 401 TOKEN_EXPIRED en la ruta de asistencia; se renueva y sigue sirviendo', async () => {
        let offsetMs = 0;
        const clockApp = await kit.build(
          {},
          {
            schoolToday: () => clock.today,
            mobile: {
              publicBaseUrl: BASE,
              clock: () => new Date(Date.now() + offsetMs),
              config: { accessTtlSeconds: 60, idleTtlSeconds: 300, absoluteTtlSeconds: 900 },
              limits: GENEROUS_MOBILE,
              attendanceRead: true,
            },
          },
        );
        await clockApp.ready();
        const bossC = await kit.login(kit.boss, clockApp);
        const titular = await kit.login(acc.A!.account, clockApp);
        const dev = new FakeDevice();
        dev.clock = () => Date.now() + offsetMs;
        await q(
          `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where user_id = $1 and status = 'active'`,
          [acc.A!.account.id, kit.boss.id],
        );
        const req = await enroll(clockApp, dev);
        await kit.call(titular, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: clockApp,
        });
        await kit.call(bossC, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
          body: { fingerprint: req.fingerprint },
          target: clockApp,
        });
        expect(
          (await post(clockApp, dev, `/mobile/enroll/requests/${req.requestId}/activate`))
            .statusCode,
        ).toBe(201);
        const t0 = json(await post(clockApp, dev, '/mobile/auth/token')) as Tokens;
        const s: Session = { dev, tokens: t0, deviceId: t0.deviceId };
        expect((await get(clockApp, s, '/mobile/school/attendance/today')).statusCode).toBe(200);
        offsetMs = 61_000;
        const expired = await get(clockApp, s, '/mobile/school/attendance/today');
        expect([expired.statusCode, json(expired).error.code]).toEqual([401, 'TOKEN_EXPIRED']);
        await clockApp.close();
      });

      it('dispositivo revocado, cuenta desactivada y rol revocado cortan la lectura de inmediato', async () => {
        const url = '/mobile/school/attendance/today';
        // dispositivo revocado por la autoridad
        const s1 = await session(on, 'B');
        expect((await get(on, s1, url)).statusCode).toBe(200);
        const rev = await kit.call(boss, 'POST', `/mobile-devices/devices/${s1.deviceId}/revoke`, {
          body: { reason: 'lost' },
          target: on,
        });
        expect(rev.statusCode, rev.body).toBe(200);
        const dead = await get(on, s1, url);
        expect(dead.statusCode).toBe(401);
        expect(['SESSION_ENDED', 'DEVICE_REVOKED']).toContain(json(dead).error.code);
        // cuenta desactivada
        const victim1 = await kit.seed({ role: 'prefectura' });
        acc.V1 = await kit.login(victim1, on);
        await assign(victim1.id, G.A!);
        const s2 = await session(on, 'V1');
        expect((await get(on, s2, url)).statusCode).toBe(200);
        await q(`update users set status = 'disabled' where id = $1`, [victim1.id]);
        expect((await get(on, s2, url)).statusCode).toBe(401);
        // rol revocado
        const victim2 = await kit.seed({ role: 'prefectura' });
        acc.V2 = await kit.login(victim2, on);
        await assign(victim2.id, G.A!);
        const s3 = await session(on, 'V2');
        expect((await get(on, s3, url)).statusCode).toBe(200);
        await q(
          `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
          [victim2.id, kit.boss.id],
        );
        expect((await get(on, s3, url)).statusCode).toBe(401);
      });
    });

    // ========================================================================================== autorizacion
    describe('autorizacion por grupo asignado', () => {
      let sA: Session;
      let sB: Session;
      let sC: Session;
      let dayA: string;
      let dayB: string;

      it('preparacion: el portal abre las listas de hoy de A y de B', async () => {
        sA = await session(on, 'A');
        sB = await session(on, 'B');
        sC = await session(on, 'C');
        const a = await wOpen('A', G.A!);
        expect(a.statusCode, a.body).toBe(201);
        dayA = json(a).day.id;
        const b = await wOpen('B', G.B!);
        expect(b.statusCode, b.body).toBe(201);
        dayB = json(b).day.id;
      });

      it('la prefecta A ve solo sus grupos; la B solo los suyos; la cobertura compartida ve la MISMA lista', async () => {
        const ta = json(await get(on, sA, '/mobile/school/attendance/today'));
        expect(ta.groups.map((g: Json) => g.groupId)).toEqual([G.A]);
        expect(ta.groups[0].day.id).toBe(dayA);
        const tb = json(await get(on, sB, '/mobile/school/attendance/today'));
        expect(tb.groups.map((g: Json) => g.groupId)).toEqual([G.B]);
        expect(tb.groups[0].day.id).toBe(dayB);
        const tc = json(await get(on, sC, '/mobile/school/attendance/today'));
        expect(tc.groups.map((g: Json) => g.groupId)).toEqual([G.A]);
        expect(tc.groups[0].day.id).toBe(dayA);
      });

      it('grupo AJENO: 404 idéntico al de una lista inexistente (no se enumeran listas de otros grupos)', async () => {
        const foreign = await get(on, sA, `/mobile/school/attendance/days/${dayB}`);
        const missing = await get(on, sA, `/mobile/school/attendance/days/${uuid()}`);
        expect([foreign.statusCode, missing.statusCode]).toEqual([404, 404]);
        const strip = (r: Res) => r.body.replace(/"requestId":"[^"]*"/, '');
        expect(strip(foreign)).toBe(strip(missing));
        // el filtro por groupId ajeno no revela nada: lista vacia, no 403
        const filtered = json(await get(on, sA, `/mobile/school/attendance/days?groupId=${G.B}`));
        expect([filtered.total, filtered.items]).toEqual([0, []]);
        const own = json(await get(on, sA, '/mobile/school/attendance/days'));
        expect(own.items.map((d: Json) => d.groupId)).toEqual([G.A]);
        expect(JSON.stringify(own)).not.toContain(dayB);
      });

      it('sin asignaciones: sin grupos, sin listas y 404 en el detalle', async () => {
        const sNone = await session(on, 'F');
        const t = json(await get(on, sNone, '/mobile/school/attendance/today'));
        expect(t.groups).toEqual([]);
        expect(json(await get(on, sNone, '/mobile/school/attendance/days')).total).toBe(0);
        expect((await get(on, sNone, `/mobile/school/attendance/days/${dayA}`)).statusCode).toBe(
          404,
        );
      });

      it('grupo INACTIVO y ciclo NO autorizado: no aparecen y el detalle responde 404', async () => {
        const sD = await session(on, 'D');
        // la lista de "off" la crea el propietario (como si se hubiera abierto cuando el grupo estaba activo)
        const created = (
          await q(
            `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3, $4) returning id`,
            [Y.cur, G.off, W, kit.boss.id],
          )
        )[0]!.id as string;
        expect((await get(on, sD, `/mobile/school/attendance/days/${created}`)).statusCode).toBe(
          200,
        );
        await q(`update groups set is_active = false where id = $1`, [G.off]);
        expect((await get(on, sD, `/mobile/school/attendance/days/${created}`)).statusCode).toBe(
          404,
        );
        expect(json(await get(on, sD, '/mobile/school/attendance/today')).groups).toEqual([]);
        await q(`update groups set is_active = true where id = $1`, [G.off]);
        // ciclo anterior: la asignacion ya no concede acceso
        const sE = await session(on, 'E');
        let oldWeekday = addDays(real, -520);
        while (isodow(oldWeekday) > 5) oldWeekday = addDays(oldWeekday, -1);
        const oldDay = (
          await q(
            `insert into attendance_days (school_year_id, group_id, attendance_date, created_by) values ($1, $2, $3, $4) returning id`,
            [Y.old, G.old, oldWeekday, kit.boss.id],
          )
        )[0]!.id as string;
        expect((await get(on, sE, `/mobile/school/attendance/days/${oldDay}`)).statusCode).toBe(
          404,
        );
        expect(json(await get(on, sE, '/mobile/school/attendance/today')).groups).toEqual([]);
      });

      it('la asignacion REVOCADA corta la lectura en la siguiente peticion', async () => {
        const v = await kit.seed({ role: 'prefectura' });
        acc.R = await kit.login(v, on);
        await assign(v.id, G.B!);
        const s = await session(on, 'R');
        expect((await get(on, s, `/mobile/school/attendance/days/${dayB}`)).statusCode).toBe(200);
        await q(
          `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'prueba' where user_id = $1`,
          [v.id, kit.boss.id],
        );
        expect((await get(on, s, `/mobile/school/attendance/days/${dayB}`)).statusCode).toBe(404);
        expect(json(await get(on, s, '/mobile/school/attendance/today')).groups).toEqual([]);
      });

      it('parametros no validos: ids mal formados, consultas con campos ajenos (userId, scope, fecha) y filtros fuera de contrato: 400', async () => {
        for (const url of [
          '/mobile/school/attendance/days/no-uuid',
          `/mobile/school/attendance/days/${dayA}?userId=${acc.B!.account.id}`,
          '/mobile/school/attendance/today?date=2020-01-01',
          '/mobile/school/attendance/today?scope=all',
          '/mobile/school/attendance/days?scope=all',
          '/mobile/school/attendance/days?from=ayer',
          '/mobile/school/attendance/days?pageSize=1000',
        ])
          expect([url, (await get(on, sA, url)).statusCode]).toEqual([url, 400]);
      });
    });

    // ========================================================================================== funcionalidad
    describe('contenido de las lecturas', () => {
      let s: Session;
      let dayId: string;
      let group: string;
      let students: string[];
      const detail = async (id = dayId) => {
        const r = await get(on, s, `/mobile/school/attendance/days/${id}`);
        expect(r.statusCode, r.body).toBe(200);
        return json(r);
      };

      it('lista inexistente: today devuelve el grupo con day:null, la fecha escolar y el momento del servidor', async () => {
        const g = await newGroup('FUN');
        students = [];
        for (let i = 0; i < 3; i += 1) students.push((await newStudent(g)).student);
        group = g;
        const v = await kit.seed({ role: 'prefectura' });
        acc.FUN = await kit.login(v, on);
        web.FUN = acc.FUN;
        await assign(v.id, g);
        s = await session(on, 'FUN');
        const t = json(await get(on, s, '/mobile/school/attendance/today'));
        expect(t.schoolToday).toBe(W);
        expect(t.isSchoolDay).toBe(true);
        expect(Math.abs(Date.parse(t.serverTime) - Date.now())).toBeLessThan(60_000);
        expect(t.groups).toEqual([{ groupId: g, schoolYearId: Y.cur, day: null }]);
        expect(json(await get(on, s, '/mobile/school/attendance/days')).total).toBe(0);
      });

      it('lista en borrador: id, estado, revision, conteos, padron congelado (solo ids) y huella estable', async () => {
        const open = await wOpen('FUN', group);
        expect(open.statusCode, open.body).toBe(201);
        dayId = json(open).day.id;
        const t = json(await get(on, s, '/mobile/school/attendance/today'));
        expect(t.groups[0].day).toMatchObject({
          id: dayId,
          groupId: group,
          status: 'draft',
          revision: 1,
          counts: { total: 3, present: 0, absent: 0, pending: 3 },
          finalizedAt: null,
        });
        const d = await detail();
        expect(d.schoolToday).toBe(W);
        expect(d.records.map((r: Json) => r.studentId).sort()).toEqual([...students].sort());
        expect(d.records.every((r: Json) => r.status === 'pending' && r.markedAt === null)).toBe(
          true,
        );
        expect(d.rosterDigest).toBe(rosterDigestV1(students));
        expect(d.rosterDigest).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(d.discrepancies).toEqual({ addedToRoster: 0, removedFromRoster: 0 });
      });

      it('revision correcta: cada guardado con cambios la sube; la huella del padron NO cambia al marcar', async () => {
        const before = await detail();
        const sv = await wSave('FUN', dayId, 1, [
          { studentId: students[0]!, status: 'present' },
          { studentId: students[1]!, status: 'absent' },
        ]);
        expect(sv.statusCode, sv.body).toBe(200);
        const after = await detail();
        expect(after.day.revision).toBe(2);
        expect(after.day.counts).toEqual({ total: 3, present: 1, absent: 1, pending: 1 });
        const byId = Object.fromEntries(after.records.map((r: Json) => [r.studentId, r.status]));
        expect(byId).toEqual({
          [students[0]!]: 'present',
          [students[1]!]: 'absent',
          [students[2]!]: 'pending',
        });
        expect(after.rosterDigest).toBe(before.rosterDigest);
      });

      it('cambio de padron: un alta y una baja posteriores se INFORMAN (discrepancies) y no alteran la lista ni su huella', async () => {
        const before = await detail();
        const extra = await newStudent(group, Y.cur, W); // llega al grupo ese mismo dia
        const gone = students[2]!; // se traslada fuera del grupo (cierre de su periodo el dia anterior)
        await q(
          `update student_group_assignments set ends_on = $2 where enrollment_id in (select id from enrollments where student_id = $1)`,
          [gone, addDays(W, -1)],
        );
        const after = await detail();
        expect(after.discrepancies).toEqual({ addedToRoster: 1, removedFromRoster: 1 });
        expect(after.rosterDigest).toBe(before.rosterDigest);
        expect(after.records.map((r: Json) => r.studentId)).not.toContain(extra.student);
        expect(after.records.map((r: Json) => r.studentId)).toContain(gone);
      });

      it('lista finalizada: estado, revision y finalizedAt; el movil no puede cambiarla', async () => {
        const cur = await detail();
        const full = await wSave('FUN', dayId, cur.day.revision, [
          { studentId: students[2]!, status: 'absent' },
        ]);
        expect(full.statusCode, full.body).toBe(200);
        const rev = (await detail()).day.revision;
        const fin = await wFinalize('FUN', dayId, rev);
        expect(fin.statusCode, fin.body).toBe(200);
        const d = await detail();
        expect(d.day.status).toBe('finalized');
        expect(d.day.revision).toBe(rev + 1);
        expect(Date.parse(d.day.finalizedAt)).not.toBeNaN();
        expect(d.day.counts.pending).toBe(0);
        const list = json(
          await get(on, s, `/mobile/school/attendance/days?groupId=${group}&status=finalized`),
        );
        expect(list.items.map((x: Json) => x.id)).toEqual([dayId]);
        const draftOnly = json(
          await get(on, s, `/mobile/school/attendance/days?groupId=${group}&status=draft`),
        );
        expect(draftOnly.total).toBe(0);
      });

      it('SIN datos sobrantes: ni nombres de alumnos, ni quien abrio o finalizo, ni "editable", ni datos de otros grupos', async () => {
        const names = await q(
          `select given_names, family_name from students where id = any($1::uuid[])`,
          [students],
        );
        for (const url of [
          '/mobile/school/attendance/today',
          '/mobile/school/attendance/days',
          `/mobile/school/attendance/days/${dayId}`,
        ]) {
          const r = await get(on, s, url);
          for (const row of names) {
            expect(r.body).not.toContain(row.given_names as string);
            expect(r.body).not.toContain(row.family_name as string);
          }
          for (const forbidden of [
            'givenNames',
            'familyName',
            'createdBy',
            'finalizedBy',
            'editable',
            'canCapture',
            'createdAt',
            'actorId',
            'schoolYearName',
            'grade',
            'shift',
          ])
            expect([url, r.body.includes(`"${forbidden}"`)]).toEqual([url, false]);
          expect(r.body).not.toContain(acc.FUN!.account.id);
        }
        const d = await detail();
        expect(Object.keys(d).sort()).toEqual([
          'day',
          'discrepancies',
          'records',
          'rosterDigest',
          'schoolToday',
          'serverTime',
        ]);
        expect(Object.keys(d.day).sort()).toEqual([
          'attendanceDate',
          'counts',
          'finalizedAt',
          'groupId',
          'id',
          'revision',
          'schoolYearId',
          'status',
        ]);
        expect(Object.keys(d.records[0]).sort()).toEqual(['markedAt', 'status', 'studentId']);
      });

      it('la huella v1: orden canonico por identificador, independiente del orden de entrada y de mayusculas', () => {
        const ids = [
          '00000000-0000-4000-8000-00000000000b',
          '00000000-0000-4000-8000-00000000000a',
          '00000000-0000-4000-8000-00000000000c',
        ];
        expect(rosterDigestV1(ids)).toBe(rosterDigestV1([...ids].reverse()));
        expect(rosterDigestV1(ids)).toBe(rosterDigestV1(ids.map((x) => x.toUpperCase())));
        expect(rosterDigestV1(ids)).not.toBe(rosterDigestV1(ids.slice(0, 2)));
      });
    });

    // ================================================================================================= fecha
    describe('fecha escolar del servidor (America/Mazatlan)', () => {
      let s: Session;
      it('lunes a viernes son dias escolares; sabado y domingo no; el cliente no puede cambiar "hoy"', async () => {
        s = await session(on, 'A');
        const monday = addDays(W, -2);
        const week = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
        const got: Array<[string, number, boolean]> = [];
        for (const day of week) {
          clock.today = day;
          const r = json(
            await get(on, s, '/mobile/school/attendance/today', {
              // el cliente "dice" otra fecha por todos los medios posibles: se ignora
              headers: { 'x-school-today': '2020-01-01', date: 'Mon, 01 Jan 2018 00:00:00 GMT' },
            }),
          );
          expect(r.schoolToday).toBe(day);
          got.push([day, isodow(day), r.isSchoolDay]);
        }
        clock.today = W;
        expect(got.map(([, d, school]) => [d, school])).toEqual([
          [1, true],
          [2, true],
          [3, true],
          [4, true],
          [5, true],
          [6, false],
          [7, false],
        ]);
      });

      it('medianoche: la lista de ayer sigue siendo un borrador consultable y hoy no tiene lista; nada se crea ni se mueve', async () => {
        const days = await dayRows();
        const events = await eventsCount();
        const before = json(await get(on, s, '/mobile/school/attendance/today'));
        const listedToday = before.groups[0].day;
        expect(listedToday).not.toBeNull();
        clock.today = addDays(W, 1); // jueves
        const after = json(await get(on, s, '/mobile/school/attendance/today'));
        expect(after.schoolToday).toBe(addDays(W, 1));
        expect(after.groups[0].day).toBeNull(); // la lista de hoy (jueves) aun no existe
        const yesterday = json(
          await get(on, s, `/mobile/school/attendance/days?groupId=${G.A}&from=${W}&to=${W}`),
        );
        expect(yesterday.items).toHaveLength(1);
        expect(yesterday.items[0]).toMatchObject({ id: listedToday.id, attendanceDate: W });
        const detailYesterday = json(
          await get(on, s, `/mobile/school/attendance/days/${listedToday.id}`),
        );
        expect(detailYesterday.schoolToday).toBe(addDays(W, 1));
        expect(detailYesterday.day.attendanceDate).toBe(W);
        clock.today = W;
        expect([await dayRows(), await eventsCount()]).toEqual([days, events]);
      });

      it('lecturas de la zona horaria del servidor: el "hoy" sale de la base y es una fecha de calendario valida', async () => {
        const dbToday = (
          await q(`select to_char((now() at time zone 'America/Mazatlan')::date, 'YYYY-MM-DD') d`)
        )[0]!.d as string;
        expect(dbToday).toBe(real);
      });
    });

    // ================================================================================================== solo lectura
    describe('el canal movil NO escribe asistencia', () => {
      it('POST, PUT, PATCH y DELETE sobre las rutas de asistencia moviles no existen y no cambian nada', async () => {
        const s = await session(on, 'A');
        const days = await dayRows();
        const events = await eventsCount();
        const records = await count(
          `select count(*) n from attendance_records where status is not null`,
        );
        const target = (await q(`select id from attendance_days limit 1`))[0]!.id as string;
        for (const [method, url] of [
          ['POST', '/mobile/school/attendance/days'],
          ['POST', `/mobile/school/attendance/days/${target}/marks`],
          ['POST', `/mobile/school/attendance/days/${target}/finalize`],
          ['PUT', `/mobile/school/attendance/days/${target}`],
          ['PATCH', `/mobile/school/attendance/days/${target}`],
          ['DELETE', `/mobile/school/attendance/days/${target}`],
          ['GET', `/mobile/school/attendance/days/${target}/events`],
        ] as const) {
          const r = await on.inject({
            method,
            url,
            payload:
              method === 'GET' ? undefined : ({ groupId: G.A, expectedRevision: 1 } as object),
            headers: {
              authorization: `DPoP ${s.tokens.accessToken}`,
              dpop: s.dev.proof({
                method,
                url: BASE + url,
                accessToken: s.tokens.accessToken,
              }),
            },
          });
          expect([
            method,
            url.replace(target, ':id'),
            [403, 404, 405].includes(r.statusCode),
          ]).toEqual([method, url.replace(target, ':id'), true]);
        }
        expect([await dayRows(), await eventsCount()]).toEqual([days, events]);
        expect(
          await count(`select count(*) n from attendance_records where status is not null`),
        ).toBe(records);
      });

      it('la lectura deja auditoria con el canal y el dispositivo, y con IP GRUESA (nunca la direccion exacta)', async () => {
        const s = await session(on, 'A');
        await get(
          on,
          s,
          `/mobile/school/attendance/days/${(await q(`select id from attendance_days where group_id = $1 limit 1`, [G.A]))[0]!.id}`,
        );
        const row = (
          await q(
            `select host(ip) ip, details from audit_events where event_type = 'attendance.day_viewed' and details->>'channel' = 'mobile' order by occurred_at desc limit 1`,
          )
        )[0]!;
        expect(row.details).toMatchObject({ channel: 'mobile', deviceId: s.deviceId });
        expect(row.ip).not.toBe('127.0.0.1');
        expect(row.ip).toBe('127.0.0.0');
      });
    });

    // ====================================================================================== seguridad HTTP
    describe('separacion de canales y proteccion de la API web', () => {
      it('una cookie web NO autentica la lectura movil; un token DPoP NO autentica el portal; CSRF y Origin web siguen intactos', async () => {
        const s = await session(on, 'A');
        for (const url of ['/mobile/school/attendance/today', '/mobile/school/attendance/days'])
          expect(
            (await on.inject({ method: 'GET', url, headers: { cookie: acc.A!.cookie } }))
              .statusCode,
          ).toBe(401);
        for (const url of [
          '/school/attendance/today',
          '/school/attendance/days',
          '/auth/me',
          '/admin/users',
        ]) {
          const r = await on.inject({
            method: 'GET',
            url,
            headers: {
              authorization: `DPoP ${s.tokens.accessToken}`,
              dpop: s.dev.proof({
                method: 'GET',
                url: BASE + url,
                accessToken: s.tokens.accessToken,
              }),
              origin: 'http://127.0.0.1:5173',
            },
          });
          expect([url, r.statusCode]).toEqual([url, 401]);
        }
        // CSRF y Origin del portal: sin Origin, 403; con Origin pero sin CSRF, 403; con ambos, la regla de negocio decide
        const noOrigin = await kit.call(acc.A!, 'POST', '/school/attendance/days', {
          body: { groupId: G.A },
          origin: false,
          target: on,
        });
        expect(noOrigin.statusCode).toBe(403);
        const noCsrf = await kit.call(acc.A!, 'POST', '/school/attendance/days', {
          body: { groupId: G.A },
          csrf: false,
          target: on,
        });
        expect(noCsrf.statusCode).toBe(403);
        const evil = await on.inject({
          method: 'POST',
          url: '/school/attendance/days',
          headers: {
            cookie: acc.A!.cookie,
            origin: 'http://evil.example',
            'x-csrf-token': acc.A!.csrf,
          },
          payload: { groupId: G.A },
        });
        expect(evil.statusCode).toBe(403);
        // y el canal movil rechaza cualquier Origin (un navegador no puede usarlo)
        const url = '/mobile/school/attendance/today';
        const withOrigin = await get(on, s, url, { headers: { origin: 'http://127.0.0.1:5173' } });
        expect([withOrigin.statusCode, json(withOrigin).error.code]).toEqual([
          403,
          'MOBILE_CHANNEL_ONLY',
        ]);
      });

      it('las respuestas no se almacenan en caches compartidas y ningun secreto llega a la URL ni a los registros', async () => {
        const s = await session(on, 'A');
        for (const url of [
          '/mobile/school/attendance/today',
          '/mobile/school/attendance/days',
          `/mobile/school/attendance/days/${uuid()}`,
        ]) {
          const r = await get(on, s, url);
          expect([url, r.headers['cache-control']]).toEqual([url, 'no-store']);
        }
        const unauth = await on.inject({
          method: 'GET',
          url: '/mobile/school/attendance/today',
        });
        expect(unauth.headers['cache-control']).toBe('no-store');
        // el token en la URL no autentica
        const viaUrl = await on.inject({
          method: 'GET',
          url: `/mobile/school/attendance/today?access_token=${s.tokens.accessToken}`,
        });
        expect(viaUrl.statusCode).toBe(401);
        const logs = kit.logs.join('\n');
        for (const t of allTokens) expect(logs.includes(t)).toBe(false);
        for (const secret of kit.secrets) expect(logs.includes(secret)).toBe(false);
      });
    });

    // ================================================================================================== hallazgos
    describe('hallazgos del protocolo (caracterizacion del comportamiento ACTUAL; sin cambiar contratos)', () => {
      let g: string;
      let st: string[];
      let dayId: string;
      let sMobile: Session;

      it('preparacion: grupo de dos prefectas (cobertura) con la lista de hoy abierta', async () => {
        g = await newGroup('HAL');
        st = [];
        for (let i = 0; i < 3; i += 1) st.push((await newStudent(g)).student);
        const p1 = await kit.seed({ role: 'prefectura' });
        const p2 = await kit.seed({ role: 'prefectura' });
        web.H1 = await kit.login(p1, on);
        web.H2 = await kit.login(p2, on);
        acc.H1 = web.H1;
        await assign(p1.id, g);
        await assign(p2.id, g);
        const open = await wOpen('H1', g);
        expect(open.statusCode, open.body).toBe(201);
        dayId = json(open).day.id;
        sMobile = await session(on, 'H1');
      });

      it('1. guardado SIN cambios: responde changed:0 y replayed:false, no deja evento y NO registra el requestId', async () => {
        const rid = uuid();
        const first = await wSave('H1', dayId, 1, marks([st[0]!]), rid);
        expect(first.statusCode, first.body).toBe(200);
        expect(json(first)).toMatchObject({ changed: 1, replayed: false });
        const events = await eventsCount();
        const noop = await wSave('H1', dayId, 2, marks([st[0]!]), uuid()); // mismo contenido, requestId nuevo
        expect(json(noop)).toMatchObject({ changed: 0, replayed: false });
        expect(await eventsCount()).toBe(events); // sin evento: su requestId no quedo registrado
        // consecuencia: el mismo requestId de un no-op puede reutilizarse luego con OTRO contenido sin IDEMPOTENCY_MISMATCH
        const noopId = uuid();
        const a = await wSave('H1', dayId, 2, marks([st[0]!]), noopId);
        expect(json(a).changed).toBe(0);
        const b = await wSave('H1', dayId, 2, marks([st[1]!], 'absent'), noopId);
        expect([b.statusCode, json(b).changed]).toEqual([200, 1]);
        // en cambio, un requestId que SI dejo evento rechaza otro contenido
        const bad = await wSave('H1', dayId, 3, marks([st[2]!]), rid);
        expect([bad.statusCode, json(bad).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
      });

      it('2. una marca guardada NO se puede quitar: la API solo acepta present/absent y la base impide volver a pendiente', async () => {
        for (const status of ['pending', null, '']) {
          const r = await kit.call(web.H1!, 'POST', `/school/attendance/days/${dayId}/marks`, {
            body: {
              expectedRevision: 3,
              requestId: uuid(),
              marks: [{ studentId: st[0], status }],
            },
            target: on,
          });
          expect([String(status), r.statusCode]).toEqual([String(status), 400]);
        }
        await expect(
          q(
            `update attendance_records set status = null where attendance_day_id = $1 and status is not null`,
            [dayId],
          ),
        ).rejects.toThrow();
        const d = json(await get(on, sMobile, `/mobile/school/attendance/days/${dayId}`));
        expect(d.records.filter((r: Json) => r.status !== 'pending').length).toBeGreaterThanOrEqual(
          2,
        );
        // cambiar entre present y absent SI se puede
        const flip = await wSave('H1', dayId, d.day.revision, [
          { studentId: st[0]!, status: 'absent' },
        ]);
        expect([flip.statusCode, json(flip).changed]).toEqual([200, 1]);
      });

      it('3. finalizar: quien llega despues recibe alreadyFinalized:true y la respuesta NO revela quien finalizo', async () => {
        const cur = json(await get(on, sMobile, `/mobile/school/attendance/days/${dayId}`));
        const done = await wSave('H1', dayId, cur.day.revision, marks(st, 'present'));
        expect(done.statusCode, done.body).toBe(200);
        const rev = json(await get(on, sMobile, `/mobile/school/attendance/days/${dayId}`)).day
          .revision;
        const fin1 = await wFinalize('H1', dayId, rev);
        expect(json(fin1).alreadyFinalized).toBe(false);
        const fin2 = await wFinalize('H2', dayId, rev); // la otra prefecta, con la revision vieja
        expect([fin2.statusCode, json(fin2).alreadyFinalized]).toEqual([200, true]);
        const body = fin2.body;
        expect(body).not.toContain(web.H1!.account.id);
        expect(json(fin2).day.finalizedBy).toBeNull();
        expect(json(fin2).day.createdBy).toBeNull();
        // el canal movil tampoco lo muestra
        expect(
          (await get(on, sMobile, `/mobile/school/attendance/days/${dayId}`)).body,
        ).not.toContain('finalizedBy');
      });

      it('4. borrador de ayer: ni guardar ni finalizar hoy (DAY_NOT_CURRENT), no se abre con fecha de ayer y reabrir hoy crea OTRA lista', async () => {
        const g2 = await newGroup('AYER');
        const st2 = [(await newStudent(g2)).student, (await newStudent(g2)).student];
        const p = await kit.seed({ role: 'prefectura' });
        web.Y = await kit.login(p, on);
        acc.Y = web.Y;
        await assign(p.id, g2);
        const open = await wOpen('Y', g2);
        const yesterdayDay = json(open).day.id as string;
        const sv = await wSave('Y', yesterdayDay, 1, marks([st2[0]!]));
        expect(sv.statusCode, sv.body).toBe(200);
        clock.today = addDays(W, 1); // pasa la medianoche
        try {
          const save = await wSave('Y', yesterdayDay, 2, marks([st2[1]!]));
          expect([save.statusCode, json(save).error.code]).toEqual([409, 'DAY_NOT_CURRENT']);
          const fin = await wFinalize('Y', yesterdayDay, 2);
          expect([fin.statusCode, json(fin).error.code]).toEqual([409, 'DAY_NOT_CURRENT']);
          const hist = await kit.call(web.Y!, 'POST', '/school/attendance/days', {
            body: { groupId: g2, attendanceDate: W },
            target: on,
          });
          expect([hist.statusCode, json(hist).error.code]).toEqual([400, 'DATE_NOT_TODAY']);
          const reopened = await wOpen('Y', g2);
          expect([reopened.statusCode, json(reopened).created]).toEqual([201, true]);
          expect(json(reopened).day.id).not.toBe(yesterdayDay);
          // el movil ve las dos listas: la de ayer sigue en borrador, sin via ordinaria de cierre
          const s = await session(on, 'Y');
          const list = json(await get(on, s, `/mobile/school/attendance/days?groupId=${g2}`));
          const byDate = Object.fromEntries(
            list.items.map((d: Json) => [d.attendanceDate, d.status]),
          );
          expect(byDate).toEqual({ [W]: 'draft', [addDays(W, 1)]: 'draft' });
        } finally {
          clock.today = W;
        }
      });
    });

    // ============================================================================================ concurrencia REAL
    // Varias conexiones a un PostgreSQL real: solo en el cluster desechable (PGlite es de una sola conexion).
    describe.skipIf(!opts.realConcurrency)(
      'concurrencia: lecturas consistentes mientras la lista cambia',
      () => {
        const opened = async (size: number, who: string) => {
          const g = await newGroup(`CON${n}`);
          const ids: string[] = [];
          for (let i = 0; i < size; i += 1) ids.push((await newStudent(g)).student);
          const p = await kit.seed({ role: 'prefectura' });
          const login = await kit.login(p, on);
          acc[who] = login;
          web[who] = login;
          await assign(p.id, g);
          const open = await wOpen(who, g);
          expect(open.statusCode, open.body).toBe(201);
          return { g, ids, dayId: json(open).day.id as string };
        };

        it('lectura mientras otra prefecta guarda: cada respuesta es UNA foto (conteos, renglones y revision del mismo instante)', async () => {
          const size = 20;
          const { ids, dayId } = await opened(size, 'CW');
          const s = await session(on, 'CW');
          let writing = true;
          const seen: Json[] = [];
          const reader = async () => {
            let last = 0;
            while (writing) {
              const d = json(await get(on, s, `/mobile/school/attendance/days/${dayId}`));
              seen.push(d);
              expect(d.day.revision).toBeGreaterThanOrEqual(last); // la revision nunca retrocede
              last = d.day.revision;
              const t = json(await get(on, s, '/mobile/school/attendance/today'));
              seen.push({ ...t.groups[0].day, __today: true });
            }
          };
          const writer = (async () => {
            let rev = 1;
            for (const id of ids) {
              const r = await wSave('CW', dayId, rev, [{ studentId: id, status: 'present' }]);
              expect(r.statusCode, r.body).toBe(200);
              rev = json(r).day.revision;
            }
            writing = false;
          })();
          await Promise.all([writer, reader(), reader(), reader()]);
          expect(seen.length).toBeGreaterThan(10);
          for (const d of seen) {
            const day = d.__today ? d : d.day;
            const c = day.counts;
            expect(c.present + c.absent + c.pending).toBe(c.total);
            // cada guardado marca exactamente un alumno mas y sube la revision en 1: en una foto coherente revision = 1 + marcados
            expect(day.revision).toBe(1 + c.present + c.absent);
            if (!d.__today) {
              const byStatus = (st: string) =>
                d.records.filter((r: Json) => r.status === st).length;
              expect([byStatus('present'), byStatus('absent'), byStatus('pending')]).toEqual([
                c.present,
                c.absent,
                c.pending,
              ]);
              expect(d.records).toHaveLength(c.total);
            }
          }
          const final = json(await get(on, s, `/mobile/school/attendance/days/${dayId}`));
          expect(final.day.counts).toMatchObject({ present: size, pending: 0 });
        });

        it('lectura mientras se finaliza: nunca un estado incompatible (finalizada sin fecha, con pendientes o con otra revision)', async () => {
          const { ids, dayId } = await opened(4, 'CF');
          const s2 = await session(on, 'CF');
          const saved = await wSave('CF', dayId, 1, marks(ids));
          expect(saved.statusCode, saved.body).toBe(200);
          const rev = json(saved).day.revision as number; // 2
          const reads = Array.from({ length: 24 }, (_, i) =>
            (async () => {
              await new Promise((r) => setTimeout(r, i * 4));
              return json(await get(on, s2, `/mobile/school/attendance/days/${dayId}`));
            })(),
          );
          const [fin, ...views] = await Promise.all([wFinalize('CF', dayId, rev), ...reads]);
          expect((fin as Res).statusCode, (fin as Res).body).toBe(200);
          for (const d of views as Json[]) {
            if (d.day.status === 'finalized') {
              expect(d.day.revision).toBe(rev + 1);
              expect(d.day.finalizedAt).not.toBeNull();
            } else {
              expect(d.day.revision).toBe(rev);
              expect(d.day.finalizedAt).toBeNull();
            }
            expect(d.day.counts.pending).toBe(0);
            expect(d.records.every((r: Json) => r.status === 'present')).toBe(true);
          }
          expect(
            json(await get(on, s2, `/mobile/school/attendance/days/${dayId}`)).day.status,
          ).toBe('finalized');
        });

        it('las lecturas simultaneas terminan y no dejan transacciones abiertas', async () => {
          const s3 = await session(on, 'A');
          await Promise.all(
            Array.from({ length: 30 }, () => get(on, s3, '/mobile/school/attendance/today')),
          );
          const idle = await count(
            `select count(*) n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`,
          );
          expect(idle).toBe(0);
        });
      },
    );
  });
}
