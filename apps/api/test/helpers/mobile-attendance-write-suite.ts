import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import type { SessionStore } from '../../src/modules/auth/session-service.js';
import type { AdminKit, Login } from './admin-http-suite.js';
import { lastDow } from './attendance-suite.js';
import { FakeDevice } from './fake-device.js';
import { addDays, todayIso } from './students-suite.js';

/**
 * ESCRITURA movil de asistencia en SANDBOX (ADR 0006, fase 2; PROPUESTO): solo abrir la lista de hoy y guardar marcas, con
 * cuentas, dispositivos, alumnos y listas FICTICIOS. PGlite y PostgreSQL 18 desechable con la API como rol NO propietario; nunca
 * contra eta15_dev. Lo que NO existe tambien se prueba: finalizar, borrar, capturas historicas. La concurrencia REAL (varias
 * conexiones, caida de la base, rollback, reinicio de la API) corre solo con `realConcurrency` (PostgreSQL desechable).
 */
const BASE = 'http://mobile-write.test';
type Res = LightMyRequestResponse;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (r: Res) => r.json() as Json;
const isodow = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const GENEROUS_MOBILE = {
  enrollIp: 1000,
  challengeIp: 10_000,
  tokenFailIp: 10_000,
  tokenFailKey: 10_000,
  claimFailUser: 10_000,
};

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

export function defineMobileAttendanceWriteTests(
  kit: AdminKit,
  opts: { realConcurrency?: boolean } = {},
): void {
  describe('escritura movil de asistencia (sandbox)', () => {
    const real = todayIso();
    const W = lastDow(3, 10); // miercoles reciente: el "hoy" escolar de casi toda la suite
    const clock = { today: W };
    const mobileCfg = (extra: object) => ({
      publicBaseUrl: BASE,
      limits: GENEROUS_MOBILE,
      ...extra,
    });
    let rw: FastifyInstance; // lectura + escritura
    let ro: FastifyInstance; // solo lectura
    let boss: Login;
    const Y: Record<string, string> = {};
    const G: Record<string, string> = {};
    const S: Record<string, string[]> = {};
    const acc: Record<string, Login> = {};
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await q(sql, params))[0]!.n);
    let n = 0;
    const alpha = (k: number) =>
      [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join('');
    const uuid = () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(700000000000 + n).slice(-12)}`;
    };
    const allTokens: string[] = [];

    // ------------------------------------------------------------------------------------------ dispositivo y sesion
    const rawPost = (app: FastifyInstance, dev: FakeDevice, url: string, nonce?: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          dpop: dev.proof({ method: 'POST', url: BASE + url, ...(nonce ? { nonce } : {}) }),
        },
      });
    const challenge = async (app: FastifyInstance, dev: FakeDevice) => {
      const r = await app.inject({
        method: 'POST',
        url: '/mobile/auth/challenge',
        payload: { keyThumbprint: dev.thumbprint },
        headers: { dpop: dev.proof({ method: 'POST', url: `${BASE}/mobile/auth/challenge` }) },
      });
      expect(r.statusCode, r.body).toBe(200);
      return json(r).nonce as string;
    };
    async function session(
      app: FastifyInstance,
      who: string,
      keepOthers = false,
    ): Promise<Session> {
      const titular = acc[who]!;
      await q(
        `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed', 'approved')`,
        [titular.account.id],
      );
      if (!keepOthers)
        await q(
          `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where user_id = $1 and status = 'active'`,
          [titular.account.id, kit.boss.id],
        );
      const dev = new FakeDevice();
      const r = await app.inject({
        method: 'POST',
        url: '/mobile/enroll/requests',
        payload: { publicKey: dev.jwk, label: 'Tableta de prueba', platform: 'android' },
      });
      expect(r.statusCode, r.body).toBe(201);
      const req = json(r) as { requestId: string; pairingCode: string; fingerprint: string };
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
      const act = await rawPost(
        app,
        dev,
        `/mobile/enroll/requests/${req.requestId}/activate`,
        await challenge(app, dev),
      );
      expect(act.statusCode, act.body).toBe(201);
      const tok = await rawPost(app, dev, '/mobile/auth/token', await challenge(app, dev));
      expect(tok.statusCode, tok.body).toBe(200);
      const tokens = json(tok) as Tokens;
      allTokens.push(tokens.accessToken, tokens.refreshToken);
      return { dev, tokens, deviceId: json(act).deviceId as string };
    }
    /** Peticion autenticada: Authorization DPoP + prueba con `ath` y un jti NUEVO en cada llamada. */
    const call = (
      app: FastifyInstance,
      s: Session,
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      body?: unknown,
      over: { headers?: Record<string, string>; proofToken?: string } = {},
    ) =>
      app.inject({
        method,
        url,
        ...(body === undefined ? {} : { payload: body as object }),
        headers: {
          authorization: `DPoP ${s.tokens.accessToken}`,
          dpop: s.dev.proof({
            method,
            url: BASE + url.split('?')[0],
            accessToken: over.proofToken ?? s.tokens.accessToken,
          }),
          ...(over.headers ?? {}),
        },
      });
    const open = (app: FastifyInstance, s: Session, groupId: string, date = clock.today) =>
      call(app, s, 'POST', '/mobile/school/attendance/days', { groupId, attendanceDate: date });
    const save = (
      app: FastifyInstance,
      s: Session,
      dayId: string,
      expectedRevision: number,
      marks: Array<{ studentId: string; status: string }>,
      requestId = uuid(),
    ) =>
      call(app, s, 'POST', `/mobile/school/attendance/days/${dayId}/marks`, {
        expectedRevision,
        requestId,
        marks,
      });
    const detail = async (app: FastifyInstance, s: Session, dayId: string) => {
      const r = await call(app, s, 'GET', `/mobile/school/attendance/days/${dayId}`);
      expect(r.statusCode, r.body).toBe(200);
      return json(r);
    };
    const marks = (ids: string[], status = 'present') =>
      ids.map((studentId) => ({ studentId, status }));

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
      return st;
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
    /** Prefecta ficticia con su sesion movil y grupo propio de `size` alumnos; la lista de hoy ya abierta por el movil. */
    const fixture = async (who: string, size: number, app: FastifyInstance = rw) => {
      const g = await newGroup(`F${n}`);
      const ids: string[] = [];
      for (let i = 0; i < size; i += 1) ids.push(await newStudent(g));
      const account = await kit.seed({ role: 'prefectura' });
      const key = `${who}#${(n += 1)}`;
      acc[key] = await kit.login(account, rw);
      await assign(account.id, g);
      const s = await session(app, key);
      const o = await open(app, s, g);
      expect(o.statusCode, o.body).toBe(201);
      return { g, ids, s, dayId: json(o).day.day.id as string, account, key };
    };
    const eventsOf = (dayId: string) =>
      count(`select count(*) n from attendance_events where attendance_day_id = $1`, [dayId]);
    const changedEvents = (dayId: string) =>
      count(
        `select count(*) n from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed' and old_status is distinct from new_status`,
        [dayId],
      );
    const webFinalize = (who: string, dayId: string, expectedRevision: number) =>
      kit.call(acc[who]!, 'POST', `/school/attendance/days/${dayId}/finalize`, {
        body: { expectedRevision },
        target: rw,
      });

    // =========================================================================================================== base
    it('preparacion: ciclos, grupos y alumnos ficticios; tres apps sobre la MISMA base (lectura+escritura, solo lectura y movil sin asistencia)', async () => {
      const common = (extra: object) => ({
        schoolToday: () => clock.today,
        mobile: mobileCfg(extra),
      });
      rw = await kit.build({}, common({ attendanceRead: true, attendanceWrite: true }));
      ro = await kit.build({}, common({ attendanceRead: true }));
      await rw.ready();
      await ro.ready();
      boss = await kit.login(kit.boss, rw);
      Y.cur = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo escritura movil', $1, $2) returning id`,
          [addDays(real, -400), addDays(real, 300)],
        )
      )[0]!.id as string;
      Y.old = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo anterior escritura', $1, $2) returning id`,
          [addDays(real, -900), addDays(real, -500)],
        )
      )[0]!.id as string;
      G.A = await newGroup('A'); // P1 y P2 (cobertura compartida)
      G.B = await newGroup('B'); // P3
      G.X = await newGroup('X'); // nadie
      G.off = await newGroup('OFF', Y.cur, false); // inactivo
      G.old = await newGroup('OLD', Y.old);
      for (const [key, size] of [
        ['A', 4],
        ['B', 3],
        ['X', 2],
        ['off', 2],
        ['old', 2],
      ] as const) {
        S[key] = [];
        for (let i = 0; i < size; i += 1)
          S[key]!.push(
            await newStudent(
              G[key]!,
              key === 'old' ? Y.old : Y.cur,
              key === 'old' ? addDays(real, -800) : undefined,
            ),
          );
      }
      for (const k of ['P1', 'P2', 'P3', 'P4', 'P5', 'NOGRP']) {
        acc[k] = await kit.login(await kit.seed({ role: 'prefectura' }), rw);
      }
      await assign(acc.P1!.account.id, G.A!);
      await assign(acc.P2!.account.id, G.A!);
      await assign(acc.P3!.account.id, G.B!);
      await assign(acc.P4!.account.id, G.off!);
      await assign(acc.P5!.account.id, G.old!, Y.old);
      expect(isodow(W)).toBe(3);
    });

    // ================================================================================================ interruptor
    describe('activacion controlada', () => {
      it('con la escritura APAGADA no existe ninguna ruta POST de asistencia y el token no lleva attendance:capture', async () => {
        const s = await session(ro, 'P1');
        const me = json(await call(ro, s, 'GET', '/mobile/me'));
        const perms = me.permissions.map((p: Json) => `${p.permission}:${p.scope}`).sort();
        expect(perms).toContain('attendance:read:assigned_groups');
        expect(perms.some((p: string) => p.startsWith('attendance:capture'))).toBe(false);
        const days = await count(`select count(*) n from attendance_days`);
        for (const [method, url, body] of [
          ['POST', '/mobile/school/attendance/days', { groupId: G.A, attendanceDate: W }],
          ['POST', `/mobile/school/attendance/days/${uuid()}/marks`, { expectedRevision: 1 }],
        ] as const) {
          const r = await call(ro, s, method, url, body);
          expect([url, [403, 404].includes(r.statusCode)]).toEqual([url, true]);
        }
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
      });

      it('con la escritura ENCENDIDA el token lleva attendance:capture SOLO con assigned_groups; un token anterior no escala en la app de solo lectura', async () => {
        const s = await session(rw, 'P1');
        const me = json(await call(rw, s, 'GET', '/mobile/me'));
        const perms = me.permissions as Array<{ permission: string; scope: string }>;
        expect(perms).toContainEqual({
          permission: 'attendance:capture',
          scope: 'assigned_groups',
        });
        expect(perms).toContainEqual({ permission: 'attendance:read', scope: 'assigned_groups' });
        expect(perms.some((p) => p.permission.startsWith('attendance:') && p.scope === 'all')).toBe(
          false,
        );
        // la MISMA credencial usada en la app de solo lectura pierde el permiso (los permisos se calculan por peticion)
        const meRo = json(await call(ro, s, 'GET', '/mobile/me'));
        expect(meRo.permissions.some((p: Json) => p.permission === 'attendance:capture')).toBe(
          false,
        );
        const days = await count(`select count(*) n from attendance_days`);
        const r = await call(ro, s, 'POST', '/mobile/school/attendance/days', {
          groupId: G.A,
          attendanceDate: W,
        });
        expect([403, 404]).toContain(r.statusCode);
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
      });

      it('la escritura exige la lectura: attendanceWrite sin attendanceRead no construye la aplicacion', async () => {
        await expect(
          buildApp(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', HOST: '127.0.0.1' }), {
            auth: {
              store: kit.harness.store,
              mobile: { publicBaseUrl: BASE, attendanceWrite: true },
            },
          }),
        ).rejects.toThrow(/exige mobile\.attendanceRead/);
      });

      it('NODE_ENV=production rechaza el canal movil y la escritura aunque los interruptores esten encendidos', async () => {
        await expect(
          buildApp(loadEnv({ NODE_ENV: 'production', HOST: '127.0.0.1' }), {
            auth: {
              store: kit.harness.store,
              mobile: { publicBaseUrl: BASE, attendanceRead: true, attendanceWrite: true },
            },
          }),
        ).rejects.toThrow(/production/);
      });

      it('`mobile.config` no puede encender la escritura por la puerta de atras', async () => {
        const sneaky = await kit.build(
          {},
          {
            mobile: mobileCfg({
              attendanceRead: true,
              config: { attendanceWrite: true } as never,
            }),
          },
        );
        await sneaky.ready();
        const s = await session(sneaky, 'P1');
        const me = json(await call(sneaky, s, 'GET', '/mobile/me'));
        expect(me.permissions.some((p: Json) => p.permission === 'attendance:capture')).toBe(false);
        const r = await call(sneaky, s, 'POST', '/mobile/school/attendance/days', {
          groupId: G.A,
          attendanceDate: W,
        });
        expect([403, 404]).toContain(r.statusCode);
        await sneaky.close();
      });

      it('NO existen finalizar, borrar, actualizar ni historial por el canal movil, y no cambian nada', async () => {
        const f = await fixture('P3', 3);
        const days = await count(`select count(*) n from attendance_days`);
        const events = await eventsOf(f.dayId);
        for (const [method, url] of [
          ['POST', `/mobile/school/attendance/days/${f.dayId}/finalize`],
          ['PUT', `/mobile/school/attendance/days/${f.dayId}`],
          ['PATCH', `/mobile/school/attendance/days/${f.dayId}`],
          ['DELETE', `/mobile/school/attendance/days/${f.dayId}`],
          ['GET', `/mobile/school/attendance/days/${f.dayId}/events`],
        ] as const) {
          const r = await call(
            rw,
            f.s,
            method,
            url,
            method === 'GET' ? undefined : { expectedRevision: 1 },
          );
          expect([method, [403, 404, 405].includes(r.statusCode)]).toEqual([method, true]);
        }
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
        expect(await eventsOf(f.dayId)).toBe(events);
        expect((await detail(rw, f.s, f.dayId)).day.status).toBe('draft');
      });
    });

    // ============================================================================================ autenticacion
    describe('autenticacion y revocacion de las escrituras', () => {
      it('sin credenciales, sin DPoP, firma o ath ajenos y repeticion de jti: 401 y nada se escribe', async () => {
        const f = await fixture('P3', 3);
        const url = `/mobile/school/attendance/days/${f.dayId}/marks`;
        const body = { expectedRevision: 1, requestId: uuid(), marks: marks([f.ids[0]!]) };
        const before = await eventsOf(f.dayId);
        expect((await rw.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401);
        expect(
          (
            await rw.inject({
              method: 'POST',
              url,
              payload: body,
              headers: { authorization: `DPoP ${f.s.tokens.accessToken}` },
            })
          ).statusCode,
        ).toBe(401);
        const other = new FakeDevice();
        expect(
          (
            await rw.inject({
              method: 'POST',
              url,
              payload: body,
              headers: {
                authorization: `DPoP ${f.s.tokens.accessToken}`,
                dpop: other.proof({
                  method: 'POST',
                  url: BASE + url,
                  accessToken: f.s.tokens.accessToken,
                }),
              },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (await call(rw, f.s, 'POST', url, body, { proofToken: 'x'.repeat(43) })).statusCode,
        ).toBe(401);
        // la MISMA peticion (mismo jti) dos veces: DPoP rechaza la repeticion, y eso es independiente de la idempotencia del requestId
        const headers = {
          authorization: `DPoP ${f.s.tokens.accessToken}`,
          dpop: f.s.dev.proof({
            method: 'POST',
            url: BASE + url,
            accessToken: f.s.tokens.accessToken,
          }),
        };
        const first = await rw.inject({ method: 'POST', url, payload: body, headers });
        expect(first.statusCode, first.body).toBe(200);
        const again = await rw.inject({ method: 'POST', url, payload: body, headers });
        expect([again.statusCode, json(again).error.code]).toEqual([401, 'INVALID_PROOF']);
        expect(await eventsOf(f.dayId)).toBe(before + 1);
      });

      it('token vencido: 401 TOKEN_EXPIRED en la escritura y no se escribe nada', async () => {
        let offsetMs = 0;
        const clockApp = await kit.build(
          {},
          {
            schoolToday: () => clock.today,
            mobile: mobileCfg({
              clock: () => new Date(Date.now() + offsetMs),
              config: { accessTtlSeconds: 60, idleTtlSeconds: 300, absoluteTtlSeconds: 900 },
              attendanceRead: true,
              attendanceWrite: true,
            }),
          },
        );
        await clockApp.ready();
        const account = await kit.seed({ role: 'prefectura' });
        acc.EXP = await kit.login(account, clockApp);
        const bossC = await kit.login(kit.boss, clockApp);
        await assign(account.id, G.B!);
        const dev = new FakeDevice();
        dev.clock = () => Date.now() + offsetMs;
        const r = await clockApp.inject({
          method: 'POST',
          url: '/mobile/enroll/requests',
          payload: { publicKey: dev.jwk, label: 'Tableta', platform: 'android' },
        });
        const req = json(r) as { requestId: string; pairingCode: string; fingerprint: string };
        await kit.call(acc.EXP, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: clockApp,
        });
        await kit.call(bossC, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
          body: { fingerprint: req.fingerprint },
          target: clockApp,
        });
        await rawPost(
          clockApp,
          dev,
          `/mobile/enroll/requests/${req.requestId}/activate`,
          await challenge(clockApp, dev),
        );
        const t0 = json(
          await rawPost(clockApp, dev, '/mobile/auth/token', await challenge(clockApp, dev)),
        ) as Tokens;
        const s: Session = { dev, tokens: t0, deviceId: t0.deviceId };
        const days = await count(`select count(*) n from attendance_days`);
        offsetMs = 61_000;
        const expired = await open(clockApp, s, G.B!);
        expect([expired.statusCode, json(expired).error.code]).toEqual([401, 'TOKEN_EXPIRED']);
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
        await clockApp.close();
      });

      it('dispositivo revocado, cuenta desactivada y rol revocado cortan la escritura de inmediato', async () => {
        const f = await fixture('P3', 3);
        const rev = await kit.call(boss, 'POST', `/mobile-devices/devices/${f.s.deviceId}/revoke`, {
          body: { reason: 'lost' },
          target: rw,
        });
        expect(rev.statusCode, rev.body).toBe(200);
        const dead = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]));
        expect(dead.statusCode).toBe(401);
        const f2 = await fixture('P3', 3);
        await q(`update users set status = 'disabled' where id = $1`, [f2.account.id]);
        expect((await save(rw, f2.s, f2.dayId, 1, marks([f2.ids[0]!]))).statusCode).toBe(401);
        const f3 = await fixture('P3', 3);
        await q(
          `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
          [f3.account.id, kit.boss.id],
        );
        expect((await save(rw, f3.s, f3.dayId, 1, marks([f3.ids[0]!]))).statusCode).toBe(401);
        for (const x of [f, f2, f3])
          expect(
            await count(
              `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
              [x.dayId],
            ),
          ).toBe(0);
      });
    });

    // ========================================================================================== autorizacion
    describe('autorizacion por grupo asignado', () => {
      let s1: Session;
      let s3: Session;
      it('P1 abre la lista de su grupo (201) y la repeticion devuelve la MISMA lista (200); P2 (cobertura) obtiene la misma', async () => {
        s1 = await session(rw, 'P1');
        const a = await open(rw, s1, G.A!);
        expect(a.statusCode, a.body).toBe(201);
        expect(json(a).created).toBe(true);
        const id = json(a).day.day.id as string;
        const again = await open(rw, s1, G.A!);
        expect([again.statusCode, json(again).created, json(again).day.day.id]).toEqual([
          200,
          false,
          id,
        ]);
        const s2 = await session(rw, 'P2');
        const b = await open(rw, s2, G.A!);
        expect([b.statusCode, json(b).created, json(b).day.day.id]).toEqual([200, false, id]);
        expect(
          await count(`select count(*) n from attendance_days where group_id = $1`, [G.A]),
        ).toBe(1);
        // la respuesta es la proyeccion minima: sin nombres ni autores ni editable
        for (const forbidden of [
          'givenNames',
          'familyName',
          'createdBy',
          'finalizedBy',
          'editable',
        ])
          expect(a.body.includes(`"${forbidden}"`)).toBe(false);
        expect(json(a).day.records).toHaveLength(4);
        expect(json(a).day.rosterDigest).toMatch(/^v1:[0-9a-f]{64}$/);
      });

      it('grupo AJENO, sin asignacion, inactivo y de otro ciclo: 404 identico al grupo inexistente; nada se crea', async () => {
        s3 = await session(rw, 'P3');
        const days = await count(`select count(*) n from attendance_days`);
        const missing = await open(rw, s3, uuid());
        const bodies = new Set<string>();
        const strip = (r: Res) => r.body.replace(/"requestId":"[^"]*"/, '');
        bodies.add(strip(missing));
        expect(missing.statusCode).toBe(404);
        for (const [who, group] of [
          ['P3', G.A], // grupo ajeno
          ['NOGRP', G.A], // sin asignaciones
          ['P4', G.off], // grupo inactivo
          ['P5', G.old], // ciclo anterior (asignacion ya no concede acceso)
          ['P3', G.X], // grupo sin prefecta
        ] as const) {
          const s = who === 'P3' ? s3 : await session(rw, who); // otra sesion de P3 revocaria la de s3
          const r = await open(rw, s, group!);
          expect([who, r.statusCode]).toEqual([who, 404]);
          bodies.add(strip(r));
        }
        expect(bodies.size).toBe(1);
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
        // guardar en la lista de OTRO grupo: 404 y nada se escribe
        const dayA = (await q(`select id from attendance_days where group_id = $1`, [G.A]))[0]!
          .id as string;
        const r = await save(rw, s3, dayA, 1, marks([S.A![0]!]));
        expect(r.statusCode).toBe(404);
        expect(
          await count(
            `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
            [dayA],
          ),
        ).toBe(0);
      });

      it('el actor sale del token: ningun cuerpo admite userId, rol, alcance, fecha efectiva ni campos ajenos (400)', async () => {
        const dayA = (await q(`select id from attendance_days where group_id = $1`, [G.A]))[0]!
          .id as string;
        const goodMarks = marks([S.A![0]!]);
        const bad: Array<[string, unknown]> = [
          [
            '/mobile/school/attendance/days',
            { groupId: G.A, attendanceDate: W, userId: acc.P2!.account.id },
          ],
          ['/mobile/school/attendance/days', { groupId: G.A, attendanceDate: W, scope: 'all' }],
          ['/mobile/school/attendance/days', { groupId: G.A }], // la fecha es obligatoria en el movil
          ['/mobile/school/attendance/days', { groupId: 'no-uuid', attendanceDate: W }],
          ['/mobile/school/attendance/days', { groupId: G.A, attendanceDate: 'ayer' }],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            {
              expectedRevision: 1,
              requestId: uuid(),
              marks: goodMarks,
              actorId: acc.P2!.account.id,
            },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            {
              expectedRevision: 1,
              requestId: uuid(),
              marks: goodMarks,
              markedAt: '2020-01-01T00:00:00Z',
            },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            {
              expectedRevision: 1,
              requestId: uuid(),
              marks: [{ studentId: S.A![0], status: 'pending' }],
            },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            {
              expectedRevision: 1,
              requestId: uuid(),
              marks: [{ studentId: S.A![0], status: 'present', name: 'x' }],
            },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            { expectedRevision: 1, requestId: 'no-uuid', marks: goodMarks },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            { expectedRevision: 0, requestId: uuid(), marks: goodMarks },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            { expectedRevision: 1, requestId: uuid(), marks: [] },
          ],
          [
            `/mobile/school/attendance/days/${dayA}/marks`,
            { expectedRevision: 1, requestId: uuid(), marks: [...goodMarks, ...goodMarks] },
          ],
          [
            `/mobile/school/attendance/days/no-uuid/marks`,
            { expectedRevision: 1, requestId: uuid(), marks: goodMarks },
          ],
        ];
        for (const [url, body] of bad)
          expect([
            url,
            JSON.stringify(body).slice(0, 60),
            (await call(rw, s1, 'POST', url, body)).statusCode,
          ]).toEqual([url, JSON.stringify(body).slice(0, 60), 400]);
        expect(
          await count(
            `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
            [dayA],
          ),
        ).toBe(0);
      });

      it('la asignacion REVOCADA corta la escritura en la siguiente peticion y un reintento no la revive (404 sin revelar datos)', async () => {
        const f = await fixture('P3', 3);
        const rid = uuid();
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect(ok.statusCode, ok.body).toBe(200);
        await q(
          `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'prueba' where user_id = $1`,
          [f.account.id, kit.boss.id],
        );
        const events = await eventsOf(f.dayId);
        const retry = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid); // misma operacion, ya sin acceso
        expect(retry.statusCode).toBe(404);
        expect(retry.body).not.toContain('replayed');
        expect((await save(rw, f.s, f.dayId, 2, marks([f.ids[1]!]))).statusCode).toBe(404);
        expect((await open(rw, f.s, f.g)).statusCode).toBe(404);
        expect(await eventsOf(f.dayId)).toBe(events);
      });
    });

    // ============================================================================================== idempotencia
    describe('idempotencia, revision y padron', () => {
      it('guardar: aplica, repite sin duplicar (jti nuevo), rechaza otro contenido y otra cuenta, y detecta revisiones viejas', async () => {
        const f = await fixture('P3', 4);
        const rid = uuid();
        const body = marks([f.ids[0]!, f.ids[1]!]);
        const first = await save(rw, f.s, f.dayId, 1, body, rid);
        expect(first.statusCode, first.body).toBe(200);
        expect(json(first)).toMatchObject({ changed: 2, replayed: false });
        expect(json(first).day.day.revision).toBe(2);
        expect(json(first).day.day.counts).toMatchObject({ present: 2, pending: 2 });
        const events = await eventsOf(f.dayId);
        // respuesta perdida: el movil reintenta la MISMA operacion con una prueba DPoP nueva (otro jti)
        const retry = await save(rw, f.s, f.dayId, 1, [...body].reverse(), rid); // incluso con el orden distinto y la revision vieja
        expect([retry.statusCode, json(retry).replayed, json(retry).changed]).toEqual([
          200,
          true,
          0,
        ]);
        expect(json(retry).day.day.revision).toBe(2);
        expect(await eventsOf(f.dayId)).toBe(events);
        expect(await changedEvents(f.dayId)).toBe(2);
        // mismo requestId, otro contenido: 409 y nada cambia
        const other = await save(rw, f.s, f.dayId, 2, marks([f.ids[2]!]), rid);
        expect([other.statusCode, json(other).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        // revision incompatible: 409 y nada se escribe
        const stale = await save(rw, f.s, f.dayId, 1, marks([f.ids[2]!]));
        expect([stale.statusCode, json(stale).error.code]).toEqual([409, 'REVISION_CONFLICT']);
        expect(await eventsOf(f.dayId)).toBe(events);
        expect(
          (await detail(rw, f.s, f.dayId)).records.find((r: Json) => r.studentId === f.ids[2])!
            .status,
        ).toBe('pending');
        // con la revision vigente SI se aplica; cambiar present <-> absent tambien
        const next = await save(rw, f.s, f.dayId, 2, [
          { studentId: f.ids[0]!, status: 'absent' },
          { studentId: f.ids[2]!, status: 'present' },
        ]);
        expect([next.statusCode, json(next).changed, json(next).day.day.revision]).toEqual([
          200, 2, 3,
        ]);
        // cada evento lleva a la cuenta, la operacion y el contenido; sin duplicados
        const evs = await q(
          `select actor_id, request_id, payload_hash from attendance_events where attendance_day_id = $1 and event_type = 'mark_changed'`,
          [f.dayId],
        );
        expect(evs.every((e) => e.actor_id === f.account.id)).toBe(true);
        expect(evs.every((e) => /^[0-9a-f]{64}$/.test(e.payload_hash as string))).toBe(true);
        expect(evs.filter((e) => e.request_id === rid)).toHaveLength(2);
      });

      it('guardado SIN cambios: recibo durable (un evento), la revision no sube, el reintento se reconoce y el id queda protegido', async () => {
        const f = await fixture('P3', 3);
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!, f.ids[1]!]));
        expect(ok.statusCode).toBe(200);
        const events = await eventsOf(f.dayId);
        const rid = uuid();
        const noop = await save(rw, f.s, f.dayId, 2, marks([f.ids[1]!, f.ids[0]!]), rid);
        expect([noop.statusCode, json(noop).changed, json(noop).replayed]).toEqual([200, 0, false]);
        expect(json(noop).day.day.revision).toBe(2);
        expect(await eventsOf(f.dayId)).toBe(events + 1); // el recibo
        expect(await changedEvents(f.dayId)).toBe(2); // pero NO es un cambio de asistencia
        const again = await save(rw, f.s, f.dayId, 2, marks([f.ids[0]!, f.ids[1]!]), rid);
        expect([again.statusCode, json(again).changed, json(again).replayed]).toEqual([
          200,
          0,
          true,
        ]);
        expect(await eventsOf(f.dayId)).toBe(events + 1);
        const other = await save(rw, f.s, f.dayId, 2, marks([f.ids[2]!]), rid);
        expect([other.statusCode, json(other).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(2);
      });

      it('el requestId de una cuenta no se reconoce desde otra (cobertura compartida): 409 sin revelar nada; en otro grupo es una operacion nueva', async () => {
        const s1 = await session(rw, 'P1');
        const dayA = (await q(`select id from attendance_days where group_id = $1`, [G.A]))[0]!
          .id as string;
        const rid = uuid();
        const rev = (await detail(rw, s1, dayA)).day.revision as number;
        const mine = await save(rw, s1, dayA, rev, marks([S.A![0]!]), rid);
        expect(mine.statusCode, mine.body).toBe(200);
        const s2 = await session(rw, 'P2');
        const theirs = await save(rw, s2, dayA, rev + 1, marks([S.A![0]!]), rid);
        expect([theirs.statusCode, json(theirs).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        expect(theirs.body).not.toContain('replayed');
        // el mismo UUID en la lista de OTRO grupo (otra prefecta) es una operacion distinta
        const f = await fixture('P4', 2);
        const alone = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect([alone.statusCode, json(alone).replayed]).toEqual([200, false]);
      });

      it('padron: alumnos de otro grupo o altas posteriores a la apertura se rechazan por identificador (400) sin aplicar NADA; las marcas validas siguen', async () => {
        const f = await fixture('P3', 3);
        const foreign = S.X![0]!;
        const late = await newStudent(f.g, Y.cur!, W); // llega al grupo ese mismo dia, despues de abrir la lista
        const before = await eventsOf(f.dayId);
        for (const intruder of [foreign, late]) {
          const r = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!, intruder]));
          expect([r.statusCode, json(r).error.code]).toEqual([400, 'STUDENT_NOT_IN_LIST']);
        }
        expect(await eventsOf(f.dayId)).toBe(before);
        const d = await detail(rw, f.s, f.dayId);
        expect(d.records.every((r: Json) => r.status === 'pending')).toBe(true);
        expect(d.discrepancies.addedToRoster).toBe(1); // el cambio se informa; la lista no se modifica
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]));
        expect([ok.statusCode, json(ok).day.rosterDigest]).toEqual([200, d.rosterDigest]);
      });

      it('lista finalizada: no se modifica (409 DAY_FINALIZED) pero la repeticion de una operacion ya aplicada se reconoce sin tocarla', async () => {
        const f = await fixture('P3', 3);
        const rid = uuid();
        const all = await save(rw, f.s, f.dayId, 1, marks(f.ids), rid);
        expect(all.statusCode, all.body).toBe(200);
        const fin = await webFinalize(f.key, f.dayId, 2);
        expect(fin.statusCode, fin.body).toBe(200);
        const events = await eventsOf(f.dayId);
        const edit = await save(rw, f.s, f.dayId, 3, [{ studentId: f.ids[0]!, status: 'absent' }]);
        expect([edit.statusCode, json(edit).error.code]).toEqual([409, 'DAY_FINALIZED']);
        const replay = await save(rw, f.s, f.dayId, 1, marks(f.ids), rid);
        expect([replay.statusCode, json(replay).replayed]).toEqual([200, true]);
        expect(await eventsOf(f.dayId)).toBe(events);
        expect(
          await count(
            `select count(*) n from attendance_events where attendance_day_id = $1 and event_type = 'day_finalized'`,
            [f.dayId],
          ),
        ).toBe(1);
      });
    });

    // ================================================================================================= fecha
    describe('fecha escolar del servidor (America/Mazatlan): solo hoy, nunca historica', () => {
      it('un dispositivo con la fecha equivocada no crea ni etiqueta listas de otro dia (400 DATE_NOT_TODAY)', async () => {
        const s = await session(rw, 'P5');
        const g = await newGroup('FECHA');
        await newStudent(g);
        const account = await kit.seed({ role: 'prefectura' });
        acc.FE = await kit.login(account, rw);
        await assign(account.id, g);
        const sf = await session(rw, 'FE');
        void s;
        const days = await count(`select count(*) n from attendance_days`);
        for (const wrong of [
          addDays(W, -1),
          addDays(W, 1),
          addDays(W, -7),
          '2001-01-01',
          addDays(real, 30),
        ]) {
          const r = await open(rw, sf, g, wrong);
          expect([wrong, r.statusCode, json(r).error.code]).toEqual([wrong, 400, 'DATE_NOT_TODAY']);
        }
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
      });

      it('sabado y domingo: no se abre ninguna lista (409 NOT_SCHOOL_DAY); lunes a viernes si', async () => {
        const g = await newGroup('SEM');
        await newStudent(g);
        const account = await kit.seed({ role: 'prefectura' });
        acc.SEM = await kit.login(account, rw);
        await assign(account.id, g);
        const s = await session(rw, 'SEM');
        const days = await count(`select count(*) n from attendance_days`);
        try {
          for (const day of [addDays(W, 3), addDays(W, 4)]) {
            clock.today = day; // sabado y domingo
            expect(isodow(day)).toBeGreaterThanOrEqual(6);
            const r = await open(rw, s, g, day);
            expect([day, r.statusCode, json(r).error.code]).toEqual([day, 409, 'NOT_SCHOOL_DAY']);
          }
        } finally {
          clock.today = W;
        }
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);
        const monday = addDays(W, -2);
        clock.today = monday;
        try {
          const r = await open(rw, s, g, monday);
          expect([r.statusCode, json(r).created]).toEqual([201, true]);
        } finally {
          clock.today = W;
        }
      });

      it('medianoche: lo capturado ayer no se guarda hoy (DAY_NOT_CURRENT), no se abre con la fecha de ayer ni se convierte en hoy; la repeticion ya aplicada si se reconoce', async () => {
        const f = await fixture('P3', 3);
        const rid = uuid();
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect(ok.statusCode, ok.body).toBe(200);
        clock.today = addDays(W, 1); // pasa la medianoche (jueves)
        try {
          const events = await eventsOf(f.dayId);
          const days = await count(`select count(*) n from attendance_days`);
          const late = await save(rw, f.s, f.dayId, 2, marks([f.ids[1]!]));
          expect([late.statusCode, json(late).error.code]).toEqual([409, 'DAY_NOT_CURRENT']);
          const histOpen = await open(rw, f.s, f.g, W); // fecha de ayer
          expect([histOpen.statusCode, json(histOpen).error.code]).toEqual([400, 'DATE_NOT_TODAY']);
          // la lista de hoy (jueves) es OTRA: no hereda nada de la de ayer
          const today = await open(rw, f.s, f.g, addDays(W, 1));
          expect([today.statusCode, json(today).created]).toEqual([201, true]);
          expect(json(today).day.day.id).not.toBe(f.dayId);
          expect(json(today).day.day.counts.present).toBe(0);
          // la respuesta perdida de ayer se recupera sin ser captura tardia: no cambia nada
          const replay = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
          expect([replay.statusCode, json(replay).replayed]).toEqual([200, true]);
          expect(await eventsOf(f.dayId)).toBe(events);
          expect(await count(`select count(*) n from attendance_days`)).toBe(days + 1);
        } finally {
          clock.today = W;
        }
      });
    });

    // ================================================================================================== auditoria
    describe('auditoria de la escritura', () => {
      it('cada apertura y guardado deja la cuenta, el grupo, la fecha, el resultado, la revision y el requestId; sin tokens ni pruebas; el reintento no duplica eventos', async () => {
        const f = await fixture('P3', 3);
        const rid = uuid();
        await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid); // reintento
        const opened = (
          await q(
            `select actor_user_id, host(ip) ip, details from audit_events where event_type = 'attendance.day_opened' and details->>'dayId' = $1`,
            [f.dayId],
          )
        )[0]!;
        expect(opened.actor_user_id).toBe(f.account.id);
        expect(opened.details).toMatchObject({
          groupId: f.g,
          attendanceDate: W,
          channel: 'mobile',
          deviceId: f.s.deviceId,
        });
        expect(opened.ip).toBe('127.0.0.0'); // IP gruesa
        const saved = (
          await q(
            `select actor_user_id, outcome, details from audit_events where event_type = 'attendance.marks_saved' and details->>'dayId' = $1`,
            [f.dayId],
          )
        )[0]!;
        expect(saved.actor_user_id).toBe(f.account.id);
        expect(saved.outcome).toBe('success');
        expect(saved.details).toMatchObject({
          groupId: f.g,
          attendanceDate: W,
          requestId: rid,
          changed: 1,
          revision: 2,
          channel: 'mobile',
          deviceId: f.s.deviceId,
        });
        const replayed = await count(
          `select count(*) n from audit_events where event_type = 'attendance.marks_replayed' and details->>'dayId' = $1`,
          [f.dayId],
        );
        expect(replayed).toBe(1);
        expect(await changedEvents(f.dayId)).toBe(1); // el reintento no duplico el cambio
        const conflict = await save(rw, f.s, f.dayId, 1, marks([f.ids[1]!]));
        expect(conflict.statusCode).toBe(409);
        expect(
          await count(
            `select count(*) n from audit_events where event_type = 'attendance.save_conflict' and details->>'dayId' = $1 and outcome = 'failure'`,
            [f.dayId],
          ),
        ).toBe(1);
        const auditText = JSON.stringify(await q(`select details from audit_events`));
        for (const t of allTokens) expect(auditText.includes(t)).toBe(false);
        expect(auditText.includes('dpop')).toBe(false);
        const logs = kit.logs.join('\n');
        for (const t of allTokens) expect(logs.includes(t)).toBe(false);
        for (const secret of kit.secrets) expect(logs.includes(secret)).toBe(false);
      });
    });

    // ================================================================================================== concurrencia
    const statuses = (rs: Res[]) => rs.map((r) => r.statusCode).sort((a, b) => a - b);
    /** App con un almacen que ejecuta `hook` ANTES de cada sentencia (fallos inyectados con conexiones reales). */
    const hookedApp = async (
      hook: (sql: string, run: (sql: string) => Promise<unknown>) => Promise<void>,
    ) => {
      const store: SessionStore = {
        transaction: (fn) =>
          kit.harness.store.transaction(async (tx) => {
            await hook('--BEGIN--', (x) => tx.query(x)); // marca el inicio de la transaccion (no es SQL)
            return fn({
              query: async (sql, params) => {
                await hook(sql, (x) => tx.query(x));
                return tx.query(sql, params);
              },
            });
          }),
      };
      const app = await kit.build(
        {},
        {
          schoolToday: () => clock.today,
          store,
          mobile: mobileCfg({ attendanceRead: true, attendanceWrite: true }),
        },
      );
      await app.ready();
      return app;
    };

    // ============================================================================ AUDITORIA DE SEGURIDAD (Prompt 42)
    describe('auditoria de seguridad: recibos, identidad de la operacion, permisos, transacciones y errores', () => {
      const webEvents = async (who: string, dayId: string, query = 'pageSize=100') => {
        const r = await kit.call(
          acc[who]!,
          'GET',
          `/school/attendance/days/${dayId}/events?${query}`,
          {
            target: rw,
          },
        );
        expect(r.statusCode, r.body).toBe(200);
        return json(r);
      };

      it('el recibo de un guardado sin cambios NO es un cambio de asistencia: ni contadores, ni revision, ni resumenes, ni el historial de cambios lo reflejan', async () => {
        const f = await fixture('P3', 4);
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!, f.ids[1]!]));
        expect(ok.statusCode).toBe(200);
        const before = await detail(rw, f.s, f.dayId);
        const todayBefore = json(await call(rw, f.s, 'GET', '/mobile/school/attendance/today'));
        const marksBefore = await q(
          `select id, status, marked_by, marked_at from attendance_records where attendance_day_id = $1 order by id`,
          [f.dayId],
        );
        const rid = uuid();
        for (let i = 0; i < 3; i += 1) {
          const r = await save(rw, f.s, f.dayId, 2, marks([f.ids[0]!, f.ids[1]!]), rid); // 1 recibo + 2 reintentos
          expect(r.statusCode).toBe(200);
        }
        const after = await detail(rw, f.s, f.dayId);
        expect(after.day).toEqual(before.day); // revision, estado y conteos intactos
        expect(after.records).toEqual(before.records); // marcas y fechas de marca intactas
        expect(json(await call(rw, f.s, 'GET', '/mobile/school/attendance/today')).groups).toEqual(
          todayBefore.groups,
        );
        expect(
          await q(
            `select id, status, marked_by, marked_at from attendance_records where attendance_day_id = $1 order by id`,
            [f.dayId],
          ),
        ).toEqual(marksBefore);
        // el recibo existe (un solo evento, old = new), pero el historial de CAMBIOS no lo muestra
        expect(
          await count(
            `select count(*) n from attendance_events where attendance_day_id = $1 and request_id = $2 and old_status is not distinct from new_status`,
            [f.dayId, rid],
          ),
        ).toBe(1);
        const ev = await webEvents(f.key, f.dayId);
        const changes = ev.items.filter((e: Json) => e.eventType === 'mark_changed');
        expect(changes).toHaveLength(2);
        expect(changes.every((e: Json) => e.oldStatus !== e.newStatus)).toBe(true);
        expect(ev.total).toBe(ev.items.length); // el total coincide con lo listado: 1 apertura + 2 cambios
        expect(ev.total).toBe(3);
        // paginado: ninguna pagina muestra recibos y el total es coherente
        const seen: Json[] = [];
        for (let page = 1; page <= 3; page += 1)
          seen.push(...(await webEvents(f.key, f.dayId, `pageSize=1&page=${page}`)).items);
        expect(seen.map((e) => e.id)).toEqual(ev.items.map((e: Json) => e.id));
        // invariante: un cambio REAL nunca tiene old = new (por eso el recibo es inconfundible)
        const realWithEqualStatus = await count(
          `select count(*) n from attendance_events e where e.event_type = 'mark_changed' and e.old_status is not distinct from e.new_status
              and exists (select 1 from attendance_events x where x.attendance_day_id = e.attendance_day_id and x.request_id = e.request_id and x.id <> e.id)`,
        );
        expect(realWithEqualStatus).toBe(0); // un recibo es el UNICO evento de su requestId
      });

      it('identidad logica de la operacion: el orden y las MAYUSCULAS de los identificadores no la eluden (misma huella, mismo recibo)', async () => {
        const f = await fixture('P3', 4);
        const rid = uuid();
        const lower = marks([f.ids[0]!, f.ids[1]!]);
        const upper = lower.map((m) => ({ ...m, studentId: m.studentId.toUpperCase() }));
        const first = await save(rw, f.s, f.dayId, 1, upper, rid); // mayusculas
        expect([first.statusCode, json(first).changed]).toEqual([200, 2]);
        const again = await save(rw, f.s, f.dayId, 1, [...lower].reverse(), rid); // minusculas y otro orden
        expect([again.statusCode, json(again).replayed, json(again).changed]).toEqual([
          200,
          true,
          0,
        ]);
        expect(await changedEvents(f.dayId)).toBe(2);
        // el mismo alumno en dos grafias distintas NO es dos alumnos: duplicado
        const dup = await save(rw, f.s, f.dayId, 2, [
          { studentId: f.ids[2]!, status: 'present' },
          { studentId: f.ids[2]!.toUpperCase(), status: 'absent' },
        ]);
        expect(dup.statusCode).toBe(400);
        expect(
          (await detail(rw, f.s, f.dayId)).records.find((r: Json) => r.studentId === f.ids[2])!
            .status,
        ).toBe('pending');
      });

      it('el reintento desde OTRO dispositivo legitimo de la misma cuenta se reconoce; desde otra cuenta o con otro contenido se rechaza y queda AUDITADO sin contenido', async () => {
        const f = await fixture('P3', 4);
        const rid = uuid();
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect(ok.statusCode).toBe(200);
        const second = await session(rw, f.key, true); // segundo dispositivo de la MISMA persona (sin revocar el primero)
        expect(second.deviceId).not.toBe(f.s.deviceId);
        const viaOther = await save(rw, second, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect([viaOther.statusCode, json(viaOther).replayed]).toEqual([200, true]);
        expect(
          await count(
            `select count(*) n from audit_events where event_type = 'attendance.marks_replayed' and details->>'dayId' = $1 and details->>'deviceId' = $2`,
            [f.dayId, second.deviceId],
          ),
        ).toBe(1);
        // mismo requestId, otro contenido (misma cuenta): rechazado y auditado
        const diff = await save(rw, f.s, f.dayId, 2, marks([f.ids[1]!]), rid);
        expect([diff.statusCode, json(diff).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        // otra cuenta con acceso al mismo grupo (cobertura): se le da de alta una asignacion al mismo grupo
        const other = await kit.seed({ role: 'prefectura' });
        acc.OTH = await kit.login(other, rw);
        await assign(other.id, f.g);
        const so = await session(rw, 'OTH');
        const stolen = await save(rw, so, f.dayId, 2, marks([f.ids[0]!]), rid);
        expect([stolen.statusCode, json(stolen).error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
        expect(stolen.body).not.toContain('replayed');
        const rows = await q(
          `select actor_user_id, outcome, details from audit_events where event_type = 'attendance.idempotency_mismatch' and details->>'dayId' = $1 order by occurred_at`,
          [f.dayId],
        );
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.outcome === 'failure')).toBe(true);
        expect(rows.map((r) => (r.details as Json).sameActor)).toEqual([true, false]);
        expect(rows.map((r) => r.actor_user_id)).toEqual([f.account.id, other.id]);
        expect(JSON.stringify(rows)).not.toMatch(/payload|hash|studentId|marks/i); // sin contenido de la operacion
        expect(await changedEvents(f.dayId)).toBe(1);
      });

      it('combinaciones de interruptores y credenciales: movil apagado, token tras renovar y permisos cambiados despues de emitir el token, sin cookies', async () => {
        // movil totalmente apagado: ni /mobile ni las rutas de asistencia existen
        const none = await kit.build({}, { schoolToday: () => clock.today });
        await none.ready();
        const days = await count(`select count(*) n from attendance_days`);
        for (const [m, url] of [
          ['POST', '/mobile/school/attendance/days'],
          ['POST', `/mobile/school/attendance/days/${uuid()}/marks`],
          ['GET', '/mobile/school/attendance/today'],
          ['GET', '/mobile/me'],
        ] as const) {
          const r = await none.inject({ method: m, url, payload: m === 'POST' ? {} : undefined });
          expect([
            m,
            url.replace(/[0-9a-f-]{36}/, ':id'),
            [403, 404].includes(r.statusCode),
          ]).toEqual([m, url.replace(/[0-9a-f-]{36}/, ':id'), true]);
        }
        await none.close();
        expect(await count(`select count(*) n from attendance_days`)).toBe(days);

        const f = await fixture('P3', 3);
        // una cookie web (con CSRF y Origin validos) no escribe por el canal movil
        const withCookie = await rw.inject({
          method: 'POST',
          url: `/mobile/school/attendance/days/${f.dayId}/marks`,
          headers: { cookie: acc[f.key]!.cookie, 'x-csrf-token': acc[f.key]!.csrf },
          payload: { expectedRevision: 1, requestId: uuid(), marks: marks([f.ids[0]!]) },
        });
        expect(withCookie.statusCode).toBe(401);
        // renovar la sesion invalida el token de acceso anterior tambien para escribir
        const oldTokens = f.s.tokens;
        const nonce = await challenge(rw, f.s.dev);
        const refreshed = await rw.inject({
          method: 'POST',
          url: '/mobile/auth/refresh',
          payload: { refreshToken: oldTokens.refreshToken },
          headers: {
            dpop: f.s.dev.proof({ method: 'POST', url: `${BASE}/mobile/auth/refresh`, nonce }),
          },
        });
        expect(refreshed.statusCode, refreshed.body).toBe(200);
        const fresh = json(refreshed) as Tokens;
        allTokens.push(fresh.accessToken, fresh.refreshToken);
        const stale = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]));
        expect(stale.statusCode).toBe(401);
        const s2: Session = { ...f.s, tokens: fresh };
        expect((await save(rw, s2, f.dayId, 1, marks([f.ids[0]!]))).statusCode).toBe(200);
        // el permiso cambia DESPUES de emitir el token: la siguiente escritura lo refleja (los permisos salen de la base)
        const roleId = `(select id from roles where key = 'prefectura')`;
        const permId = `(select id from permissions where key = 'attendance:capture')`;
        await q(
          `delete from role_permissions where role_id = ${roleId} and permission_id = ${permId}`,
        );
        try {
          const denied = await save(rw, s2, f.dayId, 2, marks([f.ids[1]!]));
          expect(denied.statusCode).toBe(403);
          expect(
            await count(
              `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
              [f.dayId],
            ),
          ).toBe(1);
        } finally {
          await q(
            `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
             select r.id, r.domain, p.id, p.domain, 'assigned_groups' from roles r, permissions p
              where r.key = 'prefectura' and p.key = 'attendance:capture'`,
          );
        }
        expect((await save(rw, s2, f.dayId, 2, marks([f.ids[1]!]))).statusCode).toBe(200);
      });

      it('el canal movil expone EXACTAMENTE las rutas previstas (sin finalizar, borrar ni escrituras alternativas)', () => {
        const routes: Array<{ path: string; methods: string[] }> = [];
        const stack: string[] = [];
        for (const line of rw.printRoutes({ commonPrefix: false }).split('\n')) {
          const m = /^([│ ]*)(?:├|└)── (\S+)(?: \(([^)]*)\))?$/.exec(line);
          if (!m) continue;
          const depth = m[1]!.length / 4;
          const full = (depth === 0 ? '' : stack[depth - 1]!) + m[2]!;
          stack[depth] = full;
          if (m[3])
            routes.push({
              path: full,
              methods: m[3]
                .split(',')
                .map((x) => x.trim())
                .filter((x) => x !== 'HEAD'),
            });
        }
        expect(routes.length).toBeGreaterThan(20);
        const mobileRoutes = routes.filter((r) => r.path.startsWith('/mobile'));
        expect(
          mobileRoutes.some((r) => r.path === '/mobile/school/attendance/days/:id/marks'),
        ).toBe(true);
        const writes = mobileRoutes
          .filter((r) => r.methods.some((m) => m !== 'GET'))
          .map((r) => `${r.methods.filter((m) => m !== 'GET').join('+')} ${r.path}`)
          .sort();
        // las escrituras moviles de asistencia son EXACTAMENTE dos; el resto son de enrolamiento y sesion (sin datos escolares)
        expect(writes.filter((w) => /school/.test(w))).toEqual([
          'POST /mobile/school/attendance/days',
          'POST /mobile/school/attendance/days/:id/marks',
        ]);
        expect(writes.some((w) => /finalize|DELETE|PUT|PATCH/.test(w))).toBe(false);
        expect(
          mobileRoutes.some((r) => r.methods.some((m) => ['DELETE', 'PUT', 'PATCH'].includes(m))),
        ).toBe(false);
      });

      it('aislamiento de transacciones: las LECTURAS fijan la foto REPEATABLE READ como primera sentencia y las ESCRITURAS no la usan', async () => {
        const txs: string[][] = [];
        const spy = await hookedApp(async (sql) => {
          if (sql === '--BEGIN--') txs.push([]);
          else txs.at(-1)!.push(sql);
        });
        const f = await fixture('P3', 3, spy); // abre por el movil
        /** Transacciones de ASISTENCIA (la autenticacion movil tiene las suyas) producidas por una peticion. */
        const attendanceTxs = () =>
          txs.filter((t) => t.some((l) => /attendance_days|attendance_records|groups g/.test(l)));
        for (const url of [
          `/mobile/school/attendance/days/${f.dayId}`,
          '/mobile/school/attendance/today',
          '/mobile/school/attendance/days',
        ]) {
          txs.length = 0;
          const r = await call(spy, f.s, 'GET', url);
          expect(r.statusCode, url).toBe(200);
          const reads = attendanceTxs();
          expect(reads, url).toHaveLength(1);
          // la foto es la PRIMERA sentencia y la unica de aislamiento
          expect(reads[0]![0], url).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          expect(reads[0]!.filter((l) => /ISOLATION LEVEL/.test(l))).toHaveLength(1);
        }
        txs.length = 0;
        const w = await save(spy, f.s, f.dayId, 1, marks([f.ids[0]!]));
        expect(w.statusCode).toBe(200);
        const writes = attendanceTxs();
        expect(writes).toHaveLength(1);
        expect(writes[0]!.some((l) => /ISOLATION LEVEL/.test(l))).toBe(false); // READ COMMITTED
        expect(writes[0]!.some((l) => /FOR UPDATE/.test(l))).toBe(true); // serializada con el bloqueo de la lista
        await spy.close();
      });

      it('errores de la base: conflictos y fallos temporales se distinguen; los desconocidos son 500 sin detalles internos; nada queda a medias y el reintento se aplica una vez', async () => {
        const f = await fixture('P3', 4);
        const internal = 'detalle-interno-ficticio';
        const failing = (code: string | undefined) =>
          Object.assign(new Error(internal), code ? { code } : {});
        const cases: Array<[string | undefined, number, string | null]> = [
          ['40001', 409, 'CONCURRENT'], // fallo de serializacion: reintentable, conflicto
          ['40P01', 409, 'CONCURRENT'], // interbloqueo: reintentable, conflicto
          ['23505', 409, 'CONCURRENT'], // violacion UNIQUE bajo concurrencia
          ['23514', 400, 'INVALID'], // regla de integridad (sin restriccion conocida)
          ['57P01', 503, 'DATABASE_UNAVAILABLE'], // base apagada
          ['ECONNRESET', 503, 'DATABASE_UNAVAILABLE'], // conexion cortada
          ['22012', 500, 'INTERNAL_ERROR'], // fallo de programacion: NO se disfraza de 503
          [undefined, 500, 'INTERNAL_ERROR'], // error sin codigo: tampoco
        ];
        let rev = 1;
        for (const [code, status, reason] of cases) {
          let armed = true;
          const flaky = await hookedApp(async (sql) => {
            if (armed && sql.includes('UPDATE attendance_records r SET status')) {
              armed = false;
              throw failing(code);
            }
          });
          const rid = uuid();
          const before = await eventsOf(f.dayId);
          const r = await save(
            flaky,
            f.s,
            f.dayId,
            rev,
            marks([f.ids[0]!], rev % 2 ? 'present' : 'absent'),
            rid,
          );
          expect([String(code), r.statusCode, json(r).error.code]).toEqual([
            String(code),
            status,
            reason,
          ]);
          expect(r.body).not.toContain(internal); // sin detalles internos
          expect(r.body).not.toMatch(/stack|at .*\.ts|\.js:/);
          expect(await eventsOf(f.dayId)).toBe(before); // transaccion revertida completa
          expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(rev);
          const retry = await save(
            flaky,
            f.s,
            f.dayId,
            rev,
            marks([f.ids[0]!], rev % 2 ? 'present' : 'absent'),
            rid,
          );
          expect([retry.statusCode, json(retry).replayed]).toEqual([200, false]); // se aplica UNA vez
          rev += 1;
          await flaky.close();
        }
        expect(kit.logs.join('\n')).not.toContain('Bearer'); // los registros no llevan credenciales
      });
    });

    if (!opts.realConcurrency) return;
    describe('concurrencia REAL con varias conexiones PostgreSQL', () => {
      it('lectura con foto REPEATABLE READ: que la fila de la cuenta cambie entre la foto y la auditoria (clave foranea) NO produce un fallo de serializacion', async () => {
        const f = await fixture('P3', 3);
        let armed = false;
        const app = await hookedApp(async (sql) => {
          if (armed && sql.includes('INSERT INTO audit_events')) {
            armed = false;
            await q(`update users set display_name = display_name || '.' where id = $1`, [
              f.account.id,
            ]);
          }
        });
        armed = true;
        const r = await call(app, f.s, 'GET', `/mobile/school/attendance/days/${f.dayId}`);
        expect(r.statusCode, r.body).toBe(200);
        await app.close();
      });

      it('1. abrir a la vez la misma lista (dos prefectas y varias peticiones): una sola lista, un solo 201', async () => {
        const g = await newGroup('C1');
        for (let i = 0; i < 4; i += 1) await newStudent(g);
        const a = await kit.seed({ role: 'prefectura' });
        const b = await kit.seed({ role: 'prefectura' });
        acc.C1a = await kit.login(a, rw);
        acc.C1b = await kit.login(b, rw);
        await assign(a.id, g);
        await assign(b.id, g);
        const sa = await session(rw, 'C1a');
        const sb = await session(rw, 'C1b');
        const rs = await Promise.all([
          open(rw, sa, g),
          open(rw, sb, g),
          open(rw, sa, g),
          open(rw, sb, g),
          open(rw, sa, g),
          open(rw, sb, g),
        ]);
        expect(statuses(rs)).toEqual([200, 200, 200, 200, 200, 201]);
        expect(new Set(rs.map((r) => json(r).day.day.id)).size).toBe(1);
        expect(await count(`select count(*) n from attendance_days where group_id = $1`, [g])).toBe(
          1,
        );
        expect(
          await count(
            `select count(*) n from attendance_records r join attendance_days d on d.id = r.attendance_day_id where d.group_id = $1`,
            [g],
          ),
        ).toBe(4);
        expect(
          await count(
            `select count(*) n from attendance_events e join attendance_days d on d.id = e.attendance_day_id where d.group_id = $1 and e.event_type = 'day_opened'`,
            [g],
          ),
        ).toBe(1);
      });

      it('2 y 13. la MISMA operacion recibida por varias conexiones a la vez (20 peticiones, 20 jti): se aplica UNA vez; el resto la reconoce', async () => {
        const f = await fixture('R2', 6);
        const rid = uuid();
        const rs = await Promise.all(
          Array.from({ length: 20 }, () => save(rw, f.s, f.dayId, 1, marks(f.ids), rid)),
        );
        expect(rs.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
        expect(rs.filter((r) => json(r).replayed === false)).toHaveLength(1);
        expect(rs.filter((r) => json(r).replayed === true)).toHaveLength(19);
        expect(await changedEvents(f.dayId)).toBe(6);
        expect(await eventsOf(f.dayId)).toBe(1 + 6); // day_opened + 6 cambios
        expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(2);
      });

      it('3. el mismo requestId con contenidos distintos a la vez: uno se aplica y el otro recibe IDEMPOTENCY_MISMATCH', async () => {
        const f = await fixture('R3', 4);
        const rid = uuid();
        const rs = await Promise.all([
          save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid),
          save(rw, f.s, f.dayId, 1, marks([f.ids[1]!]), rid),
          save(rw, f.s, f.dayId, 1, marks([f.ids[2]!]), rid),
        ]);
        expect(statuses(rs)).toEqual([200, 409, 409]);
        expect(
          rs
            .filter((r) => r.statusCode === 409)
            .every((r) => json(r).error.code === 'IDEMPOTENCY_MISMATCH'),
        ).toBe(true);
        expect(await changedEvents(f.dayId)).toBe(1);
        expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(2);
      });

      it('4. dos prefectas modifican la MISMA revision: una gana, la otra recibe REVISION_CONFLICT y su marca no se escribe ni sobrescribe', async () => {
        const g = await newGroup('C4');
        const ids: string[] = [];
        for (let i = 0; i < 4; i += 1) ids.push(await newStudent(g));
        const a = await kit.seed({ role: 'prefectura' });
        const b = await kit.seed({ role: 'prefectura' });
        acc.C4a = await kit.login(a, rw);
        acc.C4b = await kit.login(b, rw);
        await assign(a.id, g);
        await assign(b.id, g);
        const sa = await session(rw, 'C4a');
        const sb = await session(rw, 'C4b');
        const day = json(await open(rw, sa, g)).day.day.id as string;
        for (let round = 0; round < 4; round += 1) {
          const rev = (await detail(rw, sa, day)).day.revision as number;
          const rs = await Promise.all([
            save(rw, sa, day, rev, [{ studentId: ids[round]!, status: 'present' }]),
            save(rw, sb, day, rev, [{ studentId: ids[round]!, status: 'absent' }]),
          ]);
          expect(statuses(rs)).toEqual([200, 409]);
          expect(json(rs.find((r) => r.statusCode === 409)!).error.code).toBe('REVISION_CONFLICT');
          const d = await detail(rw, sa, day);
          expect(d.day.revision).toBe(rev + 1);
          const winner = rs.find((r) => r.statusCode === 200)!;
          const expectStatus = json(winner).day.records.find(
            (r: Json) => r.studentId === ids[round],
          ).status;
          expect(d.records.find((r: Json) => r.studentId === ids[round]).status).toBe(expectStatus);
        }
        // marked_by identifica a una sola persona por marca (nadie sobrescribio a nadie)
        const marked = await q(
          `select marked_by from attendance_records where attendance_day_id = $1 and status is not null`,
          [day],
        );
        expect(marked).toHaveLength(4);
      });

      it('5 y 6. se guarda pero se pierde la respuesta: el reintento (mismo requestId, jti nuevo) la reconoce; tambien si no cambio nada', async () => {
        const f = await fixture('R5', 3);
        const rid = uuid();
        await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid); // la respuesta "se pierde": se ignora
        const retry = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect([retry.statusCode, json(retry).replayed]).toEqual([200, true]);
        const rid2 = uuid();
        await save(rw, f.s, f.dayId, 2, marks([f.ids[0]!]), rid2); // no-op cuya respuesta se pierde
        const retry2 = await save(rw, f.s, f.dayId, 2, marks([f.ids[0]!]), rid2);
        expect([retry2.statusCode, json(retry2).replayed, json(retry2).changed]).toEqual([
          200,
          true,
          0,
        ]);
        expect(await changedEvents(f.dayId)).toBe(1);
        expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(2);
      });

      it('7. el guardado sin cambios repetido en paralelo deja UN solo recibo y no sube la revision', async () => {
        const f = await fixture('R7', 3);
        await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!, f.ids[1]!]));
        const before = await eventsOf(f.dayId);
        const rid = uuid();
        const rs = await Promise.all(
          Array.from({ length: 12 }, () =>
            save(rw, f.s, f.dayId, 2, marks([f.ids[0]!, f.ids[1]!]), rid),
          ),
        );
        expect(rs.every((r) => r.statusCode === 200)).toBe(true);
        expect(rs.filter((r) => json(r).replayed === false)).toHaveLength(1);
        expect(await eventsOf(f.dayId)).toBe(before + 1);
        expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(2);
      });

      it('8. dos operaciones llegan en orden inverso: la adelantada recibe REVISION_CONFLICT, la primera se aplica y la segunda se reenvia con la revision vigente', async () => {
        const f = await fixture('R8', 4);
        const op1 = { id: uuid(), marks: marks([f.ids[0]!]) };
        const op2 = { id: uuid(), marks: marks([f.ids[1]!], 'absent') };
        const early = await save(rw, f.s, f.dayId, 2, op2.marks, op2.id); // espera la revision que dejaria op1
        expect([early.statusCode, json(early).error.code]).toEqual([409, 'REVISION_CONFLICT']);
        const first = await save(rw, f.s, f.dayId, 1, op1.marks, op1.id);
        expect([first.statusCode, json(first).day.day.revision]).toEqual([200, 2]);
        const second = await save(rw, f.s, f.dayId, 2, op2.marks, op2.id); // el MISMO requestId: el conflicto no lo gasto
        expect([second.statusCode, json(second).replayed, json(second).day.day.revision]).toEqual([
          200,
          false,
          3,
        ]);
        const d = await detail(rw, f.s, f.dayId);
        expect(d.records.filter((r: Json) => r.status !== 'pending')).toHaveLength(2);
        expect(await changedEvents(f.dayId)).toBe(2);
      });

      it('9. revocacion contra guardado: la respuesta siempre coincide con la base y despues de revocar nada se acepta', async () => {
        for (let round = 0; round < 6; round += 1) {
          const f = await fixture('R9', 3);
          const [saved] = await Promise.all([
            save(rw, f.s, f.dayId, 1, marks(f.ids)),
            q(
              `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'carrera' where user_id = $1`,
              [f.account.id, kit.boss.id],
            ),
          ]);
          const marked = await count(
            `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
            [f.dayId],
          );
          expect([200, 404]).toContain(saved.statusCode);
          expect(marked).toBe(saved.statusCode === 200 ? 3 : 0); // todo o nada, y coherente con lo que se respondio
          const after = await save(
            rw,
            f.s,
            f.dayId,
            saved.statusCode === 200 ? 2 : 1,
            marks([f.ids[0]!], 'absent'),
          );
          expect(after.statusCode).toBe(404); // ya revocada: ningun guardado se acepta
        }
      });

      it('10. finalizacion web contra guardado movil: exactamente uno gana y la lista finalizada nunca cambia despues', async () => {
        for (let round = 0; round < 6; round += 1) {
          const f = await fixture('R10', 3);
          const ok = await save(rw, f.s, f.dayId, 1, marks(f.ids));
          expect(ok.statusCode).toBe(200);
          const [fin, edit] = await Promise.all([
            webFinalize(f.key, f.dayId, 2),
            save(rw, f.s, f.dayId, 2, [{ studentId: f.ids[0]!, status: 'absent' }]),
          ]);
          expect([fin.statusCode === 200, edit.statusCode === 200].filter(Boolean)).toHaveLength(1);
          const final = await q(`select status, revision from attendance_days where id = $1`, [
            f.dayId,
          ]);
          if (fin.statusCode === 200) {
            expect(json(edit).error.code).toBe('DAY_FINALIZED');
            expect(final[0]).toMatchObject({ status: 'finalized', revision: 3 });
            expect(await changedEvents(f.dayId)).toBe(3); // ninguna marca cambio tras finalizar
          } else {
            expect(json(fin).error.code).toBe('REVISION_CONFLICT');
            expect(final[0]).toMatchObject({ status: 'draft', revision: 3 });
          }
        }
      });

      it('11. cambio de padron durante la operacion: nunca una lista duplicada ni renglones de alumnos que no estaban vigentes', async () => {
        for (let round = 0; round < 4; round += 1) {
          const g = await newGroup(`C11${round}`);
          const ids: string[] = [];
          for (let i = 0; i < 4; i += 1) ids.push(await newStudent(g));
          const account = await kit.seed({ role: 'prefectura' });
          acc.C11 = await kit.login(account, rw);
          await assign(account.id, g);
          const s = await session(rw, 'C11');
          const [o] = await Promise.all([
            open(rw, s, g),
            q(
              `update student_group_assignments set ends_on = $2 where enrollment_id in (select id from enrollments where student_id = $1)`,
              [ids[3], addDays(W, -1)],
            ),
          ]);
          expect([201, 409]).toContain(o.statusCode);
          if (o.statusCode === 409) expect(json(o).error.code).toBe('ROSTER_CHANGED');
          expect(
            await count(`select count(*) n from attendance_days where group_id = $1`, [g]),
          ).toBe(o.statusCode === 201 ? 1 : 0);
          const bad = await count(
            `select count(*) n from attendance_records r join attendance_days d on d.id = r.attendance_day_id
               join student_group_assignments a on a.id = r.group_assignment_id
              where d.group_id = $1 and a.ends_on is not null and a.ends_on < d.attendance_date`,
            [g],
          );
          expect(bad).toBe(0);
        }
      });

      it('12. reinicio de la API antes del reintento: la idempotencia es durable (no vive en memoria)', async () => {
        const f = await fixture('R12', 3);
        const rid = uuid();
        const ok = await save(rw, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect(ok.statusCode).toBe(200);
        const noopId = uuid();
        await save(rw, f.s, f.dayId, 2, marks([f.ids[0]!]), noopId);
        const restarted = await kit.build(
          {},
          {
            schoolToday: () => clock.today,
            mobile: mobileCfg({ attendanceRead: true, attendanceWrite: true }),
          },
        ); // "proceso nuevo": ninguna Map ni cache de la instancia anterior
        await restarted.ready();
        const retry = await save(restarted, f.s, f.dayId, 1, marks([f.ids[0]!]), rid);
        expect([retry.statusCode, json(retry).replayed]).toEqual([200, true]);
        const retryNoop = await save(restarted, f.s, f.dayId, 2, marks([f.ids[0]!]), noopId);
        expect([retryNoop.statusCode, json(retryNoop).replayed]).toEqual([200, true]);
        expect(await changedEvents(f.dayId)).toBe(1);
        await restarted.close();
      });

      it('14. PostgreSQL deja de responder durante el guardado: 503 reintentable, NADA aplicado, y el reintento con el mismo requestId se aplica una vez', async () => {
        const f = await fixture('R14', 3);
        let kill = true;
        const flaky = await hookedApp(async (sql, run) => {
          if (kill && sql.includes('UPDATE attendance_records r SET status')) {
            kill = false;
            await run('select pg_terminate_backend(pg_backend_pid())').catch(() => undefined);
          }
        });
        const rid = uuid();
        const events = await eventsOf(f.dayId);
        const failed = await save(flaky, f.s, f.dayId, 1, marks(f.ids), rid);
        expect([failed.statusCode, json(failed).error.code]).toEqual([503, 'DATABASE_UNAVAILABLE']);
        expect(
          await count(
            `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
            [f.dayId],
          ),
        ).toBe(0);
        expect(await eventsOf(f.dayId)).toBe(events);
        expect((await detail(rw, f.s, f.dayId)).day.revision).toBe(1);
        const retry = await save(flaky, f.s, f.dayId, 1, marks(f.ids), rid);
        expect([retry.statusCode, json(retry).replayed, json(retry).changed]).toEqual([
          200,
          false,
          3,
        ]);
        expect(await changedEvents(f.dayId)).toBe(3);
        await flaky.close();
      });

      it('15. una transaccion que falla a mitad se revierte completa (marcas, revision y eventos) y el reintento se aplica limpio', async () => {
        const f = await fixture('R15', 3);
        let boom = true;
        const broken = await hookedApp(async (sql) => {
          if (boom && sql.includes('INSERT INTO attendance_events (attendance_day_id, record_id')) {
            boom = false;
            throw new Error('fallo simulado a mitad de la transaccion');
          }
        });
        const rid = uuid();
        const failed = await save(broken, f.s, f.dayId, 1, marks(f.ids), rid);
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('fallo simulado'); // sin detalles internos
        expect(
          await count(
            `select count(*) n from attendance_records where attendance_day_id = $1 and status is not null`,
            [f.dayId],
          ),
        ).toBe(0);
        expect(
          (await q(`select revision from attendance_days where id = $1`, [f.dayId]))[0]!.revision,
        ).toBe(1);
        expect(await changedEvents(f.dayId)).toBe(0);
        const retry = await save(broken, f.s, f.dayId, 1, marks(f.ids), rid);
        expect([retry.statusCode, json(retry).changed]).toEqual([200, 3]);
        await broken.close();
      });
    });
  });
}
