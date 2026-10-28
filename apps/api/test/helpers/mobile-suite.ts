import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import type { AdminKit, Login } from './admin-http-suite.js';
import { FakeDevice } from './fake-device.js';
import type { SessionStore } from '../../src/modules/auth/session-service.js';

/**
 * Pruebas HTTP de la autenticacion movil AISLADA (prototipo de sandbox) con cuentas, dispositivos y datos ficticios. Se ejecutan
 * sobre PGlite con un rol de API NO propietario. Reloj real salvo en las pruebas de caducidad (`clockApp`).
 */
const BASE = 'http://mobile.test';
type Res = LightMyRequestResponse;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (r: Res) => r.json() as Json;

interface Tokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

export function defineMobileTests(kit: AdminKit): void {
  describe('autenticacion movil aislada (sandbox)', () => {
    let app: FastifyInstance;
    let boss: Login;
    let prefA: Login;
    let prefB: Login;
    let accA: { id: string; email: string; password: string };
    let accB: { id: string; email: string; password: string };
    let tecnico: Login;
    let noRole: Login;
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const n = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0]!.n);

    // -------------------------------------------------------------------------------------------- utilidades del "dispositivo"
    const rawPost = (
      target: FastifyInstance,
      url: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) => target.inject({ method: 'POST', url, payload: body as object, headers });
    const rawGet = (target: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
      target.inject({ method: 'GET', url, headers });

    const enroll = async (
      device: FastifyInstance,
      dev: FakeDevice,
      label = 'Tableta de prueba',
    ) => {
      const r = await rawPost(device, '/mobile/enroll/requests', {
        publicKey: dev.jwk,
        label,
        platform: 'android',
      });
      expect(r.statusCode, r.body).toBe(201);
      return json(r) as {
        requestId: string;
        pairingCode: string;
        fingerprint: string;
        expiresAt: string;
      };
    };
    /** Desafio: lo firma la clave (prueba DPoP sin nonce); solo una clave ligada a una solicitud o a un dispositivo lo obtiene. */
    const challengeRaw = (target: FastifyInstance, dev: FakeDevice, over: { jti?: string } = {}) =>
      target.inject({
        method: 'POST',
        url: '/mobile/auth/challenge',
        payload: { keyThumbprint: dev.thumbprint },
        headers: {
          dpop: dev.proof({
            method: 'POST',
            url: `${BASE}/mobile/auth/challenge`,
            ...(over.jti ? { jti: over.jti } : {}),
          }),
        },
      });
    const challenge = async (target: FastifyInstance, dev: FakeDevice) => {
      const r = await challengeRaw(target, dev);
      expect(r.statusCode, r.body).toBe(200);
      return json(r).nonce as string;
    };
    const activate = async (target: FastifyInstance, dev: FakeDevice, requestId: string) => {
      const url = `/mobile/enroll/requests/${requestId}/activate`;
      const nonce = await challenge(target, dev);
      return target.inject({
        method: 'POST',
        url,
        headers: { dpop: dev.proof({ method: 'POST', url: BASE + url, nonce }) },
      });
    };
    const token = async (target: FastifyInstance, dev: FakeDevice) => {
      const nonce = await challenge(target, dev);
      return target.inject({
        method: 'POST',
        url: '/mobile/auth/token',
        headers: { dpop: dev.proof({ method: 'POST', url: `${BASE}/mobile/auth/token`, nonce }) },
      });
    };
    const refresh = async (target: FastifyInstance, dev: FakeDevice, refreshToken: string) => {
      const nonce = await challenge(target, dev);
      return target.inject({
        method: 'POST',
        url: '/mobile/auth/refresh',
        payload: { refreshToken },
        headers: { dpop: dev.proof({ method: 'POST', url: `${BASE}/mobile/auth/refresh`, nonce }) },
      });
    };
    /** Peticion autenticada: Authorization DPoP + prueba con `ath`. */
    const api = (
      target: FastifyInstance,
      dev: FakeDevice,
      t: Tokens | string,
      method: 'GET' | 'POST',
      url: string,
      over: { proofToken?: string; htu?: string; jti?: string; iat?: number; body?: unknown } = {},
    ) => {
      const access = typeof t === 'string' ? t : t.accessToken;
      return target.inject({
        method,
        url,
        ...(over.body === undefined ? {} : { payload: over.body as object }),
        headers: {
          authorization: `DPoP ${access}`,
          dpop: dev.proof({
            method,
            url: over.htu ?? BASE + url.split('?')[0],
            accessToken: over.proofToken ?? access,
            ...(over.jti ? { jti: over.jti } : {}),
            ...(over.iat !== undefined ? { iat: over.iat } : {}),
          }),
        },
      });
    };

    /** Vincula un dispositivo de punta a punta: solicitud -> reclamo web -> aprobacion -> activacion. */
    async function link(target: FastifyInstance, titular: Login, label = 'Tableta de prueba') {
      // Una persona solo puede tener una vinculacion en curso: se cierran las que dejaron otras pruebas.
      await q(
        `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed', 'approved')`,
        [titular.account.id],
      ); // ... y se retiran los dispositivos anteriores (el limite es de 3 activos por persona; se prueba aparte).
      await q(
        `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where user_id = $1 and status = 'active'`,
        [titular.account.id, kit.boss.id],
      );
      const dev = new FakeDevice();
      const req = await enroll(target, dev, label);
      const claim = await kit.call(titular, 'POST', '/mobile-devices/claims', {
        body: { requestId: req.requestId, code: req.pairingCode },
        target,
      });
      expect(claim.statusCode, claim.body).toBe(200);
      const ok = await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
        body: { fingerprint: req.fingerprint },
        target,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const act = await activate(target, dev, req.requestId);
      expect(act.statusCode, act.body).toBe(201);
      return { dev, deviceId: json(act).deviceId as string, requestId: req.requestId };
    }
    async function linkedSession(target: FastifyInstance, titular: Login) {
      const l = await link(target, titular);
      const t = await token(target, l.dev);
      expect(t.statusCode, t.body).toBe(200);
      return { ...l, tokens: json(t) as Tokens & Json };
    }

    // -------------------------------------------------------------------------------------------- datos escolares ficticios
    const ids: Record<string, string> = {};
    async function schoolData() {
      const day = (offset: number) =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      ids.year = (
        await q(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo ficticio movil', $1, $2) returning id`,
          [day(-120), day(240)],
        )
      )[0]!.id as string;
      const group = async (code: string) =>
        (
          await q(
            `insert into groups (school_year_id, grade, code) values ($1, 1, $2) returning id`,
            [ids.year, code],
          )
        )[0]!.id as string;
      ids.gA = await group('A');
      ids.gB = await group('B');
      const pupil = async (g: string, k: number) => {
        const st = (
          await q(
            `insert into students (given_names, family_name) values ($1, 'Ficticia') returning id`,
            [`Alumno${k}`],
          )
        )[0]!.id as string;
        const en = (
          await q(
            `insert into enrollments (student_id, school_year_id, starts_on) values ($1, $2, $3) returning id`,
            [st, ids.year, day(-100)],
          )
        )[0]!.id as string;
        await q(
          `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ($1, $2, $3, $4)`,
          [en, ids.year, g, day(-100)],
        );
      };
      for (let i = 0; i < 3; i += 1) await pupil(ids.gA, i);
      for (let i = 3; i < 5; i += 1) await pupil(ids.gB, i);
      const assign = async (userId: string, g: string) => {
        await q(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
        try {
          await q(
            `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, $4, $5)`,
            [userId, ids.year, g, day(-110), kit.boss.id],
          );
        } finally {
          await q(`alter table prefect_group_assignments enable trigger pga_guard_insert`);
        }
      };
      await assign(accA.id, ids.gA);
      await assign(accB.id, ids.gB);
    }

    const setup = async () => {
      app = await kit.build(
        {},
        {
          mobile: {
            publicBaseUrl: BASE,
            limits: {
              enrollIp: 1000,
              challengeIp: 10_000,
              tokenFailIp: 10_000,
              tokenFailKey: 10_000,
              claimFailUser: 10_000,
            },
          },
        },
      );
      await app.ready();
      boss = await kit.login(kit.boss, app);
      accA = await kit.seed({ role: 'prefectura' });
      accB = await kit.seed({ role: 'prefectura' });
      prefA = await kit.login(accA, app);
      prefB = await kit.login(accB, app);
      tecnico = await kit.login(
        await kit.seed({ role: 'admin_tecnico', domain: 'technical' }),
        app,
      );
      noRole = await kit.login(await kit.seed({ role: 'trabajo_social' }), app);
      await schoolData();
    };

    // ================================================================================================ enrolamiento
    describe('enrolamiento: solicitud anonima, reclamo de la persona titular y aprobacion de la autoridad', () => {
      it('preparacion', async () => {
        await setup();
      });

      it('el dispositivo crea una solicitud solo con su clave PUBLICA; el codigo no se guarda en claro', async () => {
        const dev = new FakeDevice();
        const req = await enroll(app, dev);
        expect(req.pairingCode).toMatch(/^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/);
        expect(req.fingerprint).toBe(dev.fingerprint);
        const row = (
          await q(
            `select status, user_id, public_key_jwk, pairing_code_hash, key_thumbprint from mobile_device_requests where id = $1`,
            [req.requestId],
          )
        )[0]!;
        expect(row.status).toBe('pending');
        expect(row.user_id).toBeNull();
        expect(row.key_thumbprint).toBe(dev.thumbprint);
        expect(JSON.stringify(row.public_key_jwk)).not.toContain('"d"');
        expect(Buffer.from(row.pairing_code_hash as Uint8Array).toString('utf8')).not.toContain(
          req.pairingCode,
        );
        expect(Buffer.from(row.pairing_code_hash as Uint8Array).length).toBe(32);
      });

      it('cuerpos invalidos: clave con componente privado, campos extra, etiqueta con control, plataforma o formato erroneo: 400', async () => {
        const dev = new FakeDevice();
        const bad: unknown[] = [
          { publicKey: { ...dev.jwk, d: 'A'.repeat(43) }, label: 'x', platform: 'android' },
          { publicKey: dev.jwk, label: 'x', platform: 'android', userId: accA.id },
          { publicKey: dev.jwk, label: 'x', platform: 'android', role: 'direccion' },
          { publicKey: dev.jwk, label: 'a\nb', platform: 'android' },
          { publicKey: dev.jwk, label: '', platform: 'android' },
          { publicKey: dev.jwk, label: 'x'.repeat(61), platform: 'android' },
          { publicKey: dev.jwk, label: 'x', platform: 'ios' },
          {
            publicKey: { ...dev.jwk, x: 'A'.repeat(43), y: 'A'.repeat(43) },
            label: 'x',
            platform: 'android',
          },
          { label: 'x', platform: 'android' },
        ];
        for (const body of bad) {
          const r = await rawPost(app, '/mobile/enroll/requests', body);
          expect(r.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
        }
      });

      it('el canal movil rechaza cualquier Origin (un navegador no puede usarlo) y la exencion es solo de esas rutas', async () => {
        const dev = new FakeDevice();
        const r = await rawPost(
          app,
          '/mobile/enroll/requests',
          { publicKey: dev.jwk, label: 'x', platform: 'android' },
          { origin: 'http://127.0.0.1:5173' },
        );
        expect([r.statusCode, json(r).error.code]).toEqual([403, 'MOBILE_CHANNEL_ONLY']);
        const evil = await rawPost(
          app,
          '/mobile/enroll/requests',
          { publicKey: dev.jwk, label: 'x', platform: 'android' },
          { origin: 'http://evil.example' },
        );
        expect(evil.statusCode).toBe(403);
        // las rutas WEB siguen exigiendo Origin permitido (sin Origin: 403) y las de otros modulos tambien
        for (const url of [
          '/auth/login',
          '/mobile-devices/claims',
          '/school/attendance/days',
          '/admin/users',
        ]) {
          const w = await rawPost(app, url, {});
          expect([url, w.statusCode, json(w).error?.code]).toEqual([url, 403, 'FORBIDDEN_ORIGIN']);
        }
      });

      it('una clave tiene una sola solicitud abierta: la repeticion es 409', async () => {
        const dev = new FakeDevice();
        await enroll(app, dev);
        const again = await rawPost(app, '/mobile/enroll/requests', {
          publicKey: dev.jwk,
          label: 'x',
          platform: 'android',
        });
        expect([again.statusCode, json(again).error.code]).toEqual([409, 'REQUEST_ALREADY_OPEN']);
      });

      it('RECLAMO: la persona titular (sesion web + CSRF + permiso) liga la solicitud a SU cuenta', async () => {
        const dev = new FakeDevice();
        const req = await enroll(app, dev, 'Tableta de A');
        // sin sesion, sin CSRF, sin Origin
        expect(
          (
            await kit.call(null, 'POST', '/mobile-devices/claims', {
              body: { requestId: req.requestId, code: req.pairingCode },
              target: app,
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await kit.call(prefA, 'POST', '/mobile-devices/claims', {
              body: { requestId: req.requestId, code: req.pairingCode },
              csrf: false,
              target: app,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await kit.call(prefA, 'POST', '/mobile-devices/claims', {
              body: { requestId: req.requestId, code: req.pairingCode },
              origin: false,
              target: app,
            })
          ).statusCode,
        ).toBe(403);
        const ok = await kit.call(prefA, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode.toLowerCase() },
          target: app,
        });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(json(ok)).toMatchObject({
          id: req.requestId,
          status: 'claimed',
          fingerprint: dev.fingerprint,
          titular: { id: accA.id },
        });
        const row = (
          await q(`select status, user_id from mobile_device_requests where id = $1`, [
            req.requestId,
          ])
        )[0]!;
        expect(row).toMatchObject({ status: 'claimed', user_id: accA.id });
        // otra persona ya no puede reclamarla (aunque conozca el codigo)
        const late = await kit.call(prefB, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: app,
        });
        expect([late.statusCode, json(late).error.code]).toEqual([400, 'CLAIM_INVALID']);
        // el dispositivo ve QUIEN reclamo su solicitud (para detectar un reclamo ajeno)
        const status = await rawGet(app, `/mobile/enroll/requests/${req.requestId}`, {
          dpop: dev.proof({
            method: 'GET',
            url: `${BASE}/mobile/enroll/requests/${req.requestId}`,
          }),
        });
        expect(json(status)).toMatchObject({
          status: 'claimed',
          claimedBy: { displayName: 'Persona de prueba' },
        });
        await kit.call(prefA, 'POST', `/mobile-devices/mine/requests/${req.requestId}/cancel`, {
          target: app,
        });
      });

      it('RECLAMO: codigo equivocado cuenta intentos y a los 5 la solicitud se cancela (ya no sirve ni el codigo correcto)', async () => {
        const req = await enroll(app, new FakeDevice());
        for (let i = 0; i < 4; i += 1) {
          const r = await kit.call(prefA, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: 'ZZZZ-ZZZZ' },
            target: app,
          });
          expect([r.statusCode, json(r).error.code]).toEqual([400, 'CLAIM_INVALID']);
        }
        expect(
          await n(`select claim_failures n from mobile_device_requests where id = $1`, [
            req.requestId,
          ]),
        ).toBe(4);
        await kit.call(prefA, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: 'ZZZZ-ZZZZ' },
          target: app,
        });
        expect(
          (await q(`select status from mobile_device_requests where id = $1`, [req.requestId]))[0]!
            .status,
        ).toBe('cancelled');
        const good = await kit.call(prefA, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: app,
        });
        expect([good.statusCode, json(good).error.code]).toEqual([400, 'CLAIM_INVALID']);
        expect(
          await n(
            `select count(*) n from audit_events where event_type = 'mobile.device_claim_failed' and outcome = 'denied'`,
          ),
        ).toBeGreaterThanOrEqual(5);
      });

      it('RECLAMO: cuentas sin el permiso (admin_tecnico, trabajo social, Direccion) reciben 403; formatos invalidos 400', async () => {
        const req = await enroll(app, new FakeDevice());
        for (const who of [tecnico, noRole, boss]) {
          const r = await kit.call(who, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: req.pairingCode },
            target: app,
          });
          expect([r.statusCode, who.account.email], 'sin permiso').toEqual([
            403,
            who.account.email,
          ]);
        }
        for (const body of [
          {},
          { requestId: 'no-uuid', code: req.pairingCode },
          { requestId: req.requestId, code: 'abc' },
          { requestId: req.requestId, code: req.pairingCode, userId: accB.id },
        ]) {
          expect(
            (await kit.call(prefA, 'POST', '/mobile-devices/claims', { body, target: app }))
              .statusCode,
          ).toBe(400);
        }
      });

      it('RECLAMO: una solicitud vencida no se puede reclamar', async () => {
        const dev = new FakeDevice();
        const created = (
          await q(
            `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, created_at, expires_at)
             values ($1, $2::jsonb, 'Vencida', $3, now() - interval '2 hours', now() - interval '90 minutes') returning id`,
            [dev.thumbprint, JSON.stringify(dev.jwk), Buffer.alloc(32, 1)],
          )
        )[0]!.id as string;
        const r = await kit.call(prefA, 'POST', '/mobile-devices/claims', {
          body: { requestId: created, code: 'AAAA-AAAA' },
          target: app,
        });
        expect(r.statusCode).toBe(400);
        // y una nueva solicitud con la misma clave cierra la vencida y funciona
        const again = await enroll(app, dev);
        expect(again.requestId).not.toBe(created);
        expect(
          (await q(`select status from mobile_device_requests where id = $1`, [created]))[0]!
            .status,
        ).toBe('cancelled');
      });

      it('APROBACION: exige permiso de autoridad, solicitud reclamada y la huella de la pantalla del dispositivo', async () => {
        const dev = new FakeDevice();
        const req = await enroll(app, dev);
        // aun sin reclamar
        const early = await kit.call(
          boss,
          'POST',
          `/mobile-devices/requests/${req.requestId}/approve`,
          { body: { fingerprint: req.fingerprint }, target: app },
        );
        expect([early.statusCode, json(early).error.code]).toEqual([409, 'NOT_CLAIMED']);
        await kit.call(prefB, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: app,
        });
        // la propia persona titular, otra prefecta, tecnico: 403
        for (const who of [prefB, prefA, tecnico, noRole]) {
          const r = await kit.call(
            who,
            'POST',
            `/mobile-devices/requests/${req.requestId}/approve`,
            { body: { fingerprint: req.fingerprint }, target: app },
          );
          expect(r.statusCode, who.account.email).toBe(403);
        }
        // huella equivocada o con formato invalido
        const bad = await kit.call(
          boss,
          'POST',
          `/mobile-devices/requests/${req.requestId}/approve`,
          { body: { fingerprint: '0000-0000-0000' }, target: app },
        );
        expect([bad.statusCode, json(bad).error.code]).toEqual([400, 'FINGERPRINT_MISMATCH']);
        expect(
          (
            await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
              body: { fingerprint: 'xyz' },
              target: app,
            })
          ).statusCode,
        ).toBe(400);
        // sin CSRF
        expect(
          (
            await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
              body: { fingerprint: req.fingerprint },
              csrf: false,
              target: app,
            })
          ).statusCode,
        ).toBe(403);
        const ok = await kit.call(
          boss,
          'POST',
          `/mobile-devices/requests/${req.requestId}/approve`,
          { body: { fingerprint: req.fingerprint.toLowerCase() }, target: app },
        );
        expect(ok.statusCode, ok.body).toBe(200);
        const row = (
          await q(`select status, approved_by, user_id from mobile_device_requests where id = $1`, [
            req.requestId,
          ])
        )[0]!;
        expect(row).toMatchObject({
          status: 'approved',
          approved_by: kit.boss.id,
          user_id: accB.id,
        });
        const twice = await kit.call(
          boss,
          'POST',
          `/mobile-devices/requests/${req.requestId}/approve`,
          { body: { fingerprint: req.fingerprint }, target: app },
        );
        expect(twice.statusCode).toBe(409);
        await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/reject`, {
          target: app,
        });
        expect(
          (await q(`select status from mobile_device_requests where id = $1`, [req.requestId]))[0]!
            .status,
        ).toBe('rejected');
      });

      it('ACTIVACION: exige aprobacion, nonce de un solo uso y la firma de la MISMA clave; no se repite', async () => {
        const dev = new FakeDevice();
        const req = await enroll(app, dev);
        const url = `/mobile/enroll/requests/${req.requestId}/activate`;
        // antes de reclamar/aprobar
        expect((await activate(app, dev, req.requestId)).statusCode).toBe(409);
        await kit.call(prefA, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: app,
        });
        expect(json(await activate(app, dev, req.requestId)).error.code).toBe('NOT_APPROVED');
        await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
          body: { fingerprint: req.fingerprint },
          target: app,
        });

        // sin nonce, nonce inventado, nonce reutilizado, prueba repetida, clave ajena
        const noNonce = await app.inject({
          method: 'POST',
          url,
          headers: { dpop: dev.proof({ method: 'POST', url: BASE + url }) },
        });
        expect([noNonce.statusCode, json(noNonce).error.code]).toEqual([401, 'NONCE_INVALID']);
        const fake = await app.inject({
          method: 'POST',
          url,
          headers: { dpop: dev.proof({ method: 'POST', url: BASE + url, nonce: 'N'.repeat(32) }) },
        });
        expect(json(fake).error.code).toBe('NONCE_INVALID');
        const nonce = await challenge(app, dev);
        const proof = dev.proof({ method: 'POST', url: BASE + url, nonce });
        const intruder = new FakeDevice();
        // una clave sin solicitud ni dispositivo ni siquiera obtiene un desafio, y no deja NINGUN estado en la base
        const asked = await challengeRaw(app, intruder);
        expect([asked.statusCode, json(asked).error.code]).toEqual([401, 'INVALID_PROOF']);
        const stolen = await app.inject({
          method: 'POST',
          url,
          headers: {
            dpop: intruder.proof({ method: 'POST', url: BASE + url, nonce: 'N'.repeat(32) }),
          },
        });
        expect([stolen.statusCode, json(stolen).error.code]).toEqual([404, 'REQUEST_NOT_FOUND']); // otra clave no ve la solicitud
        for (const table of ['mobile_proof_jtis', 'mobile_nonces'])
          expect(
            await n(`select count(*) n from ${table} where key_thumbprint = $1`, [
              intruder.thumbprint,
            ]),
            table,
          ).toBe(0);
        const ok = await app.inject({ method: 'POST', url, headers: { dpop: proof } });
        expect(ok.statusCode, ok.body).toBe(201);
        const replay = await app.inject({ method: 'POST', url, headers: { dpop: proof } });
        expect(replay.statusCode).toBe(401);
        const again = await activate(app, dev, req.requestId);
        expect([again.statusCode, json(again).error.code]).toEqual([409, 'ALREADY_ACTIVATED']);
        const d = (
          await q(
            `select status, user_id, key_thumbprint, approved_by from mobile_devices where request_id = $1`,
            [req.requestId],
          )
        )[0]!;
        expect(d).toMatchObject({
          status: 'active',
          user_id: accA.id,
          key_thumbprint: dev.thumbprint,
          approved_by: kit.boss.id,
        });
        // el dispositivo nunca envio ni guardo la clave privada
        expect(
          JSON.stringify(
            await q(`select * from mobile_devices where request_id = $1`, [req.requestId]),
          ),
        ).not.toContain('"d":');
      });

      it('SOLICITUDES CONCURRENTES: dos personas reclaman a la vez la misma solicitud: solo una gana', async () => {
        const req = await enroll(app, new FakeDevice());
        const [a, b] = await Promise.all([
          kit.call(prefA, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: req.pairingCode },
            target: app,
          }),
          kit.call(prefB, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: req.pairingCode },
            target: app,
          }),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
        const row = (
          await q(`select user_id from mobile_device_requests where id = $1`, [req.requestId])
        )[0]!;
        expect([accA.id, accB.id]).toContain(row.user_id);
      });

      it('LIMITE: una persona tiene como maximo 3 dispositivos activos; revocar uno libera el cupo', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const login = await kit.login(acc, app);
        const doOne = async () => {
          const dev = new FakeDevice();
          const req = await enroll(app, dev);
          await kit.call(login, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: req.pairingCode },
            target: app,
          });
          await kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
            body: { fingerprint: req.fingerprint },
            target: app,
          });
          return activate(app, dev, req.requestId);
        };
        const first = await doOne();
        for (let i = 0; i < 2; i += 1) expect((await doOne()).statusCode).toBe(201);
        const over = await doOne();
        expect([over.statusCode, json(over).error.code]).toEqual([409, 'DEVICE_LIMIT']);
        await kit.call(boss, 'POST', `/mobile-devices/devices/${json(first).deviceId}/revoke`, {
          body: { reason: 'authority' },
          target: app,
        });
        expect((await doOne()).statusCode).toBe(409); // la solicitud del intento anterior sigue aprobada y su clave se uso: no se reutiliza
      });
      it('una persona con una solicitud abierta no puede abrir otra (frena la acumulacion de aprobaciones)', async () => {
        const open = await q(
          `select status from mobile_device_requests where user_id = $1 and status in ('claimed','approved')`,
          [accB.id],
        );
        const first = await enroll(app, new FakeDevice());
        const claimFirst = await kit.call(prefB, 'POST', '/mobile-devices/claims', {
          body: { requestId: first.requestId, code: first.pairingCode },
          target: app,
        });
        const second = await enroll(app, new FakeDevice());
        const claimSecond = await kit.call(prefB, 'POST', '/mobile-devices/claims', {
          body: { requestId: second.requestId, code: second.pairingCode },
          target: app,
        });
        if (claimFirst.statusCode === 200 || open.length > 0)
          expect([claimSecond.statusCode, json(claimSecond).error.code]).toEqual([
            409,
            'REQUEST_ALREADY_OPEN',
          ]);
        for (const r of [first, second])
          await kit.call(boss, 'POST', `/mobile-devices/requests/${r.requestId}/reject`, {
            target: app,
          });
      });
    });

    // ================================================================================================ sesiones
    describe('sesiones moviles ligadas al dispositivo (DPoP)', () => {
      it('emite tokens SOLO a un dispositivo activo con nonce y firma; solo se guardan hashes', async () => {
        const l = await link(app, prefA);
        // sin nonce, clave desconocida
        const url = `${BASE}/mobile/auth/token`;
        const noNonce = await app.inject({
          method: 'POST',
          url: '/mobile/auth/token',
          headers: { dpop: l.dev.proof({ method: 'POST', url }) },
        });
        expect([noNonce.statusCode, json(noNonce).error.code]).toEqual([401, 'NONCE_INVALID']);
        const stranger = new FakeDevice();
        const asked = await challengeRaw(app, stranger); // sin dispositivo ni solicitud: ni desafio
        expect([asked.statusCode, json(asked).error.code]).toEqual([401, 'INVALID_PROOF']);
        const unknown = await app.inject({
          method: 'POST',
          url: '/mobile/auth/token',
          headers: { dpop: stranger.proof({ method: 'POST', url, nonce: 'N'.repeat(32) }) },
        });
        expect([unknown.statusCode, json(unknown).error.code]).toEqual([401, 'UNKNOWN_DEVICE']);
        for (const table of ['mobile_proof_jtis', 'mobile_nonces'])
          expect(
            await n(`select count(*) n from ${table} where key_thumbprint = $1`, [
              stranger.thumbprint,
            ]),
            table,
          ).toBe(0);
        const ok = await token(app, l.dev);
        expect(ok.statusCode, ok.body).toBe(200);
        const t = json(ok) as Tokens & Json;
        expect(t.tokenType).toBe('DPoP');
        expect(t.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(t.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(t.refreshToken).not.toBe(t.accessToken);
        expect(t.deviceId).toBe(l.deviceId);
        expect(Date.parse(t.accessExpiresAt)).toBeLessThan(Date.parse(t.sessionExpiresAt));
        const dump = JSON.stringify(
          await q(`select * from mobile_sessions where device_id = $1`, [l.deviceId]),
        );
        expect(dump).not.toContain(t.accessToken);
        expect(dump).not.toContain(t.refreshToken);
        // una sola sesion activa por dispositivo: la anterior se revoca 'replaced'
        const second = await token(app, l.dev);
        expect(second.statusCode).toBe(200);
        expect(
          await n(
            `select count(*) n from mobile_sessions where device_id = $1 and revoked_at is null`,
            [l.deviceId],
          ),
        ).toBe(1);
        expect(
          (
            await q(
              `select revoked_reason from mobile_sessions where device_id = $1 and revoked_at is not null`,
              [l.deviceId],
            )
          )[0]!.revoked_reason,
        ).toBe('replaced');
        const old = await api(app, l.dev, t.accessToken, 'GET', '/mobile/me');
        expect(old.statusCode).toBe(401);
      });

      it('/mobile/me: roles y permisos LIMITADOS a los moviles (no attendance, no mobile_devices)', async () => {
        const s = await linkedSession(app, prefA);
        const me = await api(app, s.dev, s.tokens, 'GET', '/mobile/me');
        expect(me.statusCode, me.body).toBe(200);
        const body = json(me);
        expect(body.deviceId).toBe(s.deviceId);
        expect(body.roles).toEqual(['prefectura']);
        const perms = (body.permissions as Array<{ permission: string }>)
          .map((p) => p.permission)
          .sort();
        expect(perms).toEqual(['prefect_assignments:read', 'students:read_basic']);
        expect(JSON.stringify(body)).not.toMatch(/email|password|display/i);
      });

      it('un token robado SIN la clave privada no sirve: otra clave, prueba ajena, ath erroneo, sin prueba, repeticion, metodo y URL', async () => {
        const s = await linkedSession(app, prefA);
        const thief = new FakeDevice();
        // el ladron tiene el token pero firma con SU clave
        expect((await api(app, thief, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(401);
        // sin prueba, solo Authorization
        const bare = await app.inject({
          method: 'GET',
          url: '/mobile/me',
          headers: { authorization: `DPoP ${s.tokens.accessToken}` },
        });
        expect(bare.statusCode).toBe(401);
        // esquema Bearer (cualquier token sin DPoP)
        const bearer = await app.inject({
          method: 'GET',
          url: '/mobile/me',
          headers: { authorization: `Bearer ${s.tokens.accessToken}` },
        });
        expect(bearer.statusCode).toBe(401);
        // ath de otro token
        expect(
          (await api(app, s.dev, s.tokens, 'GET', '/mobile/me', { proofToken: 'A'.repeat(43) }))
            .statusCode,
        ).toBe(401);
        // htu de otra ruta / metodo equivocado / prueba vieja o del futuro
        expect(
          (await api(app, s.dev, s.tokens, 'GET', '/mobile/me', { htu: `${BASE}/mobile/other` }))
            .statusCode,
        ).toBe(401);
        const wrongMethod = await app.inject({
          method: 'GET',
          url: '/mobile/me',
          headers: {
            authorization: `DPoP ${s.tokens.accessToken}`,
            dpop: s.dev.proof({
              method: 'POST',
              url: `${BASE}/mobile/me`,
              accessToken: s.tokens.accessToken,
            }),
          },
        });
        expect(wrongMethod.statusCode).toBe(401);
        const now = Math.floor(Date.now() / 1000);
        expect(
          (await api(app, s.dev, s.tokens, 'GET', '/mobile/me', { iat: now - 300 })).statusCode,
        ).toBe(401);
        expect(
          (await api(app, s.dev, s.tokens, 'GET', '/mobile/me', { iat: now + 300 })).statusCode,
        ).toBe(401);
        // repeticion de la MISMA prueba (jti): la primera pasa, la segunda no
        const proof = s.dev.proof({
          method: 'GET',
          url: `${BASE}/mobile/me`,
          accessToken: s.tokens.accessToken,
        });
        const headers = { authorization: `DPoP ${s.tokens.accessToken}`, dpop: proof };
        expect((await app.inject({ method: 'GET', url: '/mobile/me', headers })).statusCode).toBe(
          200,
        );
        expect((await app.inject({ method: 'GET', url: '/mobile/me', headers })).statusCode).toBe(
          401,
        );
        // token en la URL o en el cuerpo: no existe ese camino
        const inUrl = await app.inject({
          method: 'GET',
          url: `/mobile/me?access_token=${s.tokens.accessToken}`,
        });
        expect(inUrl.statusCode).toBe(401);
        // dos cabeceras DPoP (arreglo) y proofs mal formados
        const junk = await app.inject({
          method: 'GET',
          url: '/mobile/me',
          headers: { authorization: `DPoP ${s.tokens.accessToken}`, dpop: 'x.y.z' },
        });
        expect(junk.statusCode).toBe(401);
      });

      it('SEPARACION de canales: una cookie web no autentica rutas moviles y un token movil no autentica rutas web ni administrativas', async () => {
        const s = await linkedSession(app, prefA);
        // cookie web valida en una ruta movil
        const withCookie = await app.inject({
          method: 'GET',
          url: '/mobile/me',
          headers: { cookie: prefA.cookie },
        });
        expect(withCookie.statusCode).toBe(401);
        const schoolWithCookie = await app.inject({
          method: 'GET',
          url: '/mobile/school/me/groups',
          headers: { cookie: prefA.cookie },
        });
        expect(schoolWithCookie.statusCode).toBe(401);
        // token movil (con prueba correcta) en rutas web: no hay cookie => 401; ni siquiera con Origin web valido
        for (const url of [
          '/school/me/groups',
          '/auth/me',
          '/admin/users',
          '/school/attendance/today',
          `/school/groups/${ids.gA}/roster`,
          '/mobile-devices/mine',
          '/mobile-devices',
        ]) {
          const r = await app.inject({
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
        // las rutas moviles administrativas NO existen: 404
        for (const [m, url] of [
          ['GET', '/mobile/admin/users'],
          ['GET', '/mobile/school/attendance/today'],
          ['POST', '/mobile/school/attendance/days'],
          ['GET', '/mobile/school/students'],
          ['GET', '/mobile/mobile-devices'],
        ] as const) {
          const r = await app.inject({ method: m, url, headers: {} });
          // un POST sin Origin a una ruta inexistente lo corta antes la comprobacion global de Origin (403); un GET no existe (404)
          expect([
            url,
            m === 'GET' ? r.statusCode === 404 : [403, 404].includes(r.statusCode),
          ]).toEqual([url, true]);
        }
      });

      it('RENOVACION con rotacion: el token de acceso anterior deja de servir y la renovacion se gasta', async () => {
        const s = await linkedSession(app, prefA);
        const r1 = await refresh(app, s.dev, s.tokens.refreshToken);
        expect(r1.statusCode, r1.body).toBe(200);
        const t1 = json(r1) as Tokens & Json;
        expect(t1.accessToken).not.toBe(s.tokens.accessToken);
        expect(t1.refreshToken).not.toBe(s.tokens.refreshToken);
        expect((await api(app, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(401); // acceso viejo
        expect((await api(app, s.dev, t1, 'GET', '/mobile/me')).statusCode).toBe(200);
        // una renovacion con la CLAVE equivocada falla sin revocar nada
        const thief = new FakeDevice(); // clave sin dispositivo: ni desafio ni estado
        expect((await challengeRaw(app, thief)).statusCode).toBe(401);
        const stolen = await app.inject({
          method: 'POST',
          url: '/mobile/auth/refresh',
          payload: { refreshToken: t1.refreshToken },
          headers: {
            dpop: thief.proof({
              method: 'POST',
              url: `${BASE}/mobile/auth/refresh`,
              nonce: 'N'.repeat(32),
            }),
          },
        });
        expect([stolen.statusCode, json(stolen).error.code]).toEqual([401, 'UNKNOWN_DEVICE']);
        // un dispositivo REAL y distinto (otra persona) con la renovacion robada: clave equivocada, sin revocar nada
        const other = await link(app, prefB);
        const crossed = await refresh(app, other.dev, t1.refreshToken);
        expect([crossed.statusCode, json(crossed).error.code]).toEqual([401, 'INVALID_TOKEN']);
        expect((await api(app, s.dev, t1, 'GET', '/mobile/me')).statusCode).toBe(200);
        // REUSO de la renovacion anterior: 401 y la sesion COMPLETA se revoca
        const reuse = await refresh(app, s.dev, s.tokens.refreshToken);
        expect([reuse.statusCode, json(reuse).error.code]).toEqual([401, 'REFRESH_REUSED']);
        expect((await api(app, s.dev, t1, 'GET', '/mobile/me')).statusCode).toBe(401);
        expect((await refresh(app, s.dev, t1.refreshToken)).statusCode).toBe(401);
        expect(
          await n(`select count(*) n from audit_events where event_type = 'mobile.session_reuse'`),
        ).toBeGreaterThanOrEqual(1);
        // el dispositivo, con su clave, puede abrir una sesion nueva
        expect((await token(app, s.dev)).statusCode).toBe(200);
      });

      it('RENOVACIONES CONCURRENTES con el mismo token: solo una gana y la otra cierra la sesion (reuso)', async () => {
        const s = await linkedSession(app, prefA);
        const [a, b] = await Promise.all([
          refresh(app, s.dev, s.tokens.refreshToken),
          refresh(app, s.dev, s.tokens.refreshToken),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
        // despues de un reuso detectado, ninguna credencial de esa sesion sirve
        const winner = (a.statusCode === 200 ? json(a) : json(b)) as Tokens;
        const check = await api(app, s.dev, winner, 'GET', '/mobile/me');
        expect([200, 401]).toContain(check.statusCode);
        const active = await n(
          `select count(*) n from mobile_sessions where device_id = $1 and revoked_at is null`,
          [s.deviceId],
        );
        expect(active).toBeLessThanOrEqual(1);
      });

      it('REVOCACION del dispositivo (autoridad): la sesion y las renovaciones dejan de servir de inmediato', async () => {
        const s = await linkedSession(app, prefA);
        expect((await api(app, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(200);
        // sin permiso, sin CSRF, y sobre un id ajeno desde la persona titular
        expect(
          (
            await kit.call(prefB, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
              body: { reason: 'authority' },
              target: app,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await kit.call(prefB, 'POST', `/mobile-devices/mine/devices/${s.deviceId}/revoke`, {
              target: app,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await kit.call(boss, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
              body: { reason: 'authority' },
              csrf: false,
              target: app,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await kit.call(boss, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
              body: { reason: 'otra' },
              target: app,
            })
          ).statusCode,
        ).toBe(400);
        const rev = await kit.call(boss, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
          body: { reason: 'lost' },
          target: app,
        });
        expect(rev.statusCode, rev.body).toBe(200);
        const dead = await api(app, s.dev, s.tokens, 'GET', '/mobile/me');
        expect([dead.statusCode, json(dead).error.code]).toEqual([401, 'SESSION_ENDED']);
        expect((await refresh(app, s.dev, s.tokens.refreshToken)).statusCode).toBe(401);
        const newToken = await token(app, s.dev);
        expect([newToken.statusCode, json(newToken).error.code]).toEqual([401, 'DEVICE_REVOKED']);
        expect(
          await n(
            `select count(*) n from mobile_sessions where device_id = $1 and revoked_at is null`,
            [s.deviceId],
          ),
        ).toBe(0);
        expect(
          (
            await q(`select status, revoke_reason from mobile_devices where id = $1`, [s.deviceId])
          )[0],
        ).toMatchObject({ status: 'revoked', revoke_reason: 'lost' });
        const again = await kit.call(boss, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
          body: { reason: 'lost' },
          target: app,
        });
        expect(again.statusCode).toBe(409);
        // una clave revocada no se vuelve a registrar jamas
        const reenroll = await rawPost(app, '/mobile/enroll/requests', {
          publicKey: s.dev.jwk,
          label: 'misma clave',
          platform: 'android',
        });
        expect([reenroll.statusCode, json(reenroll).error.code]).toEqual([
          409,
          'KEY_ALREADY_REGISTERED',
        ]);
      });

      it('REVOCACION por la propia persona titular (perdida del dispositivo) y aislamiento de su lista', async () => {
        const s = await linkedSession(app, prefA);
        const mineA = json(await kit.call(prefA, 'GET', '/mobile-devices/mine', { target: app }));
        expect((mineA.devices as Array<{ id: string }>).some((d) => d.id === s.deviceId)).toBe(
          true,
        );
        const mineB = json(await kit.call(prefB, 'GET', '/mobile-devices/mine', { target: app }));
        expect((mineB.devices as Array<{ id: string }>).some((d) => d.id === s.deviceId)).toBe(
          false,
        );
        expect(
          (
            await kit.call(prefA, 'POST', `/mobile-devices/mine/devices/${s.deviceId}/revoke`, {
              target: app,
            })
          ).statusCode,
        ).toBe(200);
        expect((await api(app, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(401);
        expect(
          (
            await q(`select revoke_reason, revoked_by from mobile_devices where id = $1`, [
              s.deviceId,
            ])
          )[0],
        ).toMatchObject({ revoke_reason: 'titular', revoked_by: accA.id });
        // la autoridad ve todo; una persona sin permiso, nada
        const list = await kit.call(boss, 'GET', '/mobile-devices', { target: app });
        expect(list.statusCode).toBe(200);
        expect((await kit.call(prefA, 'GET', '/mobile-devices', { target: app })).statusCode).toBe(
          403,
        );
        expect(
          (await kit.call(tecnico, 'GET', '/mobile-devices', { target: app })).statusCode,
        ).toBe(403);
      });

      it('CUENTA y ROL: desactivar la cuenta o revocar el rol corta el acceso de inmediato; volver a conceder el rol NO revive el dispositivo', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const login = await kit.login(acc, app);
        const s = await linkedSession(app, login);
        expect((await api(app, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(200);
        // el rol se revoca: la misma credencial deja de servir
        await q(
          `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
          [acc.id, kit.boss.id],
        );
        const noRoleNow = await api(app, s.dev, s.tokens, 'GET', '/mobile/me');
        expect(noRoleNow.statusCode).toBe(401);
        expect(
          (await refresh(app, s.dev, s.tokens.refreshToken)).statusCode,
        ).toBeGreaterThanOrEqual(401);
        expect((await token(app, s.dev)).statusCode).toBe(403);
        // se concede de nuevo el rol: el dispositivo (registrado ANTES) sigue sin servir
        await q(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source) select $1, r.id, r.domain, $2, 'grant' from roles r where r.key = 'prefectura'`,
          [acc.id, kit.boss.id],
        );
        expect((await token(app, s.dev)).statusCode).toBe(403);
        // cuenta desactivada
        const acc2 = await kit.seed({ role: 'prefectura' });
        const s2 = await linkedSession(app, await kit.login(acc2, app));
        await q(`update users set status = 'disabled' where id = $1`, [acc2.id]);
        expect((await api(app, s2.dev, s2.tokens, 'GET', '/mobile/me')).statusCode).toBe(401);
        expect((await token(app, s2.dev)).statusCode).toBe(403);
      });

      it('una cuenta con un rol que exige MFA (p. ej. Direccion) no es elegible para el canal movil', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const login = await kit.login(acc, app);
        const s = await linkedSession(app, login);
        await q(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source) select $1, r.id, r.domain, $2, 'grant' from roles r where r.key = 'direccion'`,
          [acc.id, kit.boss.id],
        );
        expect((await api(app, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(401);
        expect((await token(app, s.dev)).statusCode).toBe(403);
        // conceder un rol revoca las sesiones web de la persona: se vuelve a iniciar sesion para probar el reclamo
        const relogin = await kit.login(acc, app);
        const req = await enroll(app, new FakeDevice());
        const claim = await kit.call(relogin, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: app,
        });
        expect(claim.statusCode).toBe(403);
      });
    });

    // ================================================================================================ lecturas escolares
    describe('lecturas escolares sandbox por el canal movil (mismos servicios que el portal)', () => {
      it('cada prefecta ve SOLO sus grupos y el padron minimo; el grupo ajeno responde igual que uno inexistente (404)', async () => {
        const a = await linkedSession(app, prefA);
        const b = await linkedSession(app, prefB);
        const gA = await api(app, a.dev, a.tokens, 'GET', '/mobile/school/me/groups');
        expect(gA.statusCode, gA.body).toBe(200);
        expect(
          (json(gA).groups as Array<{ group: { id: string } }>).map((x) => x.group.id),
        ).toEqual([ids.gA]);
        const gB = await api(app, b.dev, b.tokens, 'GET', '/mobile/school/me/groups');
        expect(
          (json(gB).groups as Array<{ group: { id: string } }>).map((x) => x.group.id),
        ).toEqual([ids.gB]);
        const rosterA = await api(
          app,
          a.dev,
          a.tokens,
          'GET',
          `/mobile/school/groups/${ids.gA}/roster`,
        );
        expect(rosterA.statusCode, rosterA.body).toBe(200);
        const students = json(rosterA).students as Array<Record<string, unknown>>;
        expect(students).toHaveLength(3);
        for (const s of students)
          expect(Object.keys(s).sort()).toEqual(['familyName', 'givenNames', 'id']);
        // acceso cruzado y grupo inexistente: mismo 404
        const cross = await api(
          app,
          a.dev,
          a.tokens,
          'GET',
          `/mobile/school/groups/${ids.gB}/roster`,
        );
        const missing = await api(
          app,
          a.dev,
          a.tokens,
          'GET',
          '/mobile/school/groups/00000000-0000-4000-8000-000000000999/roster',
        );
        expect([cross.statusCode, missing.statusCode]).toEqual([404, 404]);
        expect(json(cross).error.code).toBe(json(missing).error.code);
        // ruta con datos extra en la consulta o id invalido: 400
        expect(
          (await api(app, a.dev, a.tokens, 'GET', '/mobile/school/me/groups?userId=' + accB.id))
            .statusCode,
        ).toBe(400);
        expect(
          (await api(app, a.dev, a.tokens, 'GET', '/mobile/school/groups/no-uuid/roster'))
            .statusCode,
        ).toBe(400);
      });

      it('PARIDAD con el portal: la respuesta movil es la misma que la web para la misma cuenta', async () => {
        const a = await linkedSession(app, prefA);
        const mobile = json(await api(app, a.dev, a.tokens, 'GET', '/mobile/school/me/groups'));
        const web = json(await kit.call(prefA, 'GET', '/school/me/groups', { target: app }));
        expect({ ...mobile, generatedAt: null }).toEqual({ ...web, generatedAt: null });
        const mRoster = json(
          await api(app, a.dev, a.tokens, 'GET', `/mobile/school/groups/${ids.gA}/roster`),
        );
        const wRoster = json(
          await kit.call(prefA, 'GET', `/school/groups/${ids.gA}/roster`, { target: app }),
        );
        expect({ ...mRoster, generatedAt: null }).toEqual({ ...wRoster, generatedAt: null });
      });

      it('una asignacion revocada corta la lectura de inmediato (misma credencial)', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const s = await linkedSession(app, await kit.login(acc, app));
        await q(`alter table prefect_group_assignments disable trigger pga_guard_insert`);
        await q(
          `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by) values ($1, $2, $3, current_date - 100, $4)`,
          [acc.id, ids.year, ids.gA, kit.boss.id],
        );
        await q(`alter table prefect_group_assignments enable trigger pga_guard_insert`);
        const before = json(await api(app, s.dev, s.tokens, 'GET', '/mobile/school/me/groups'));
        expect(before.groups).toHaveLength(1);
        await q(
          `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'prueba' where user_id = $1`,
          [acc.id, kit.boss.id],
        );
        const after = json(await api(app, s.dev, s.tokens, 'GET', '/mobile/school/me/groups'));
        expect(after.groups).toHaveLength(0);
        expect(
          (await api(app, s.dev, s.tokens, 'GET', `/mobile/school/groups/${ids.gA}/roster`))
            .statusCode,
        ).toBe(404);
      });
    });

    // ================================================================================================ caducidad
    describe('caducidad y renovacion con reloj controlado', () => {
      it('el acceso vence y se renueva; la inactividad y la duracion absoluta cierran la sesion', async () => {
        let offsetMs = 0;
        const clockApp = await kit.build(
          {},
          {
            mobile: {
              publicBaseUrl: BASE,
              clock: () => new Date(Date.now() + offsetMs),
              config: {
                accessTtlSeconds: 60,
                idleTtlSeconds: 300,
                absoluteTtlSeconds: 900,
              },
              limits: {
                enrollIp: 1000,
                challengeIp: 10_000,
                tokenFailIp: 10_000,
                tokenFailKey: 10_000,
                claimFailUser: 10_000,
              },
            },
          },
        );
        await clockApp.ready();
        const login = await kit.login(await kit.seed({ role: 'prefectura' }), clockApp);
        const bossLogin = await kit.login(kit.boss, clockApp);
        const dev = new FakeDevice();
        dev.clock = () => Date.now() + offsetMs; // el dispositivo "viaja" con el servidor: la tolerancia de iat sigue siendo la normal
        const req = await enroll(clockApp, dev);
        await kit.call(login, 'POST', '/mobile-devices/claims', {
          body: { requestId: req.requestId, code: req.pairingCode },
          target: clockApp,
        });
        await kit.call(bossLogin, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
          body: { fingerprint: req.fingerprint },
          target: clockApp,
        });
        expect((await activate(clockApp, dev, req.requestId)).statusCode).toBe(201);
        const t0 = json(await token(clockApp, dev)) as Tokens & Json;
        expect(Date.parse(t0.sessionExpiresAt) - Date.parse(t0.accessExpiresAt)).toBe(840_000);
        expect((await api(clockApp, dev, t0, 'GET', '/mobile/me')).statusCode).toBe(200);
        offsetMs = 61_000; // el acceso vencio
        const expired = await api(clockApp, dev, t0, 'GET', '/mobile/me');
        expect([expired.statusCode, json(expired).error.code]).toEqual([401, 'TOKEN_EXPIRED']);
        const r1 = await refresh(clockApp, dev, t0.refreshToken);
        expect(r1.statusCode, r1.body).toBe(200);
        const t1 = json(r1) as Tokens & Json;
        expect((await api(clockApp, dev, t1, 'GET', '/mobile/me')).statusCode).toBe(200);
        offsetMs = 61_000 + 301_000; // pasaron 5 min sin renovar: la renovacion vencio por inactividad
        const idle = await refresh(clockApp, dev, t1.refreshToken);
        expect([idle.statusCode, json(idle).error.code]).toEqual([401, 'SESSION_EXPIRED']);
        // otra sesion y, al pasar la duracion absoluta, ya no se puede renovar aunque se haya renovado a tiempo
        offsetMs = 0;
        const t2 = json(await token(clockApp, dev)) as Tokens & Json;
        let cur = t2;
        for (const step of [250, 500, 750]) {
          offsetMs = step * 1000;
          const r = await refresh(clockApp, dev, cur.refreshToken);
          expect(r.statusCode, `renovacion a los ${step}s`).toBe(200);
          cur = json(r) as Tokens & Json;
        }
        expect(Date.parse(cur.sessionExpiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
        offsetMs = 901_000;
        const abs = await refresh(clockApp, dev, cur.refreshToken);
        expect([abs.statusCode, json(abs).error.code]).toEqual([401, 'SESSION_EXPIRED']);
        const dead = await api(clockApp, dev, cur, 'GET', '/mobile/me');
        expect(dead.statusCode).toBe(401);
        await clockApp.close();
      });
    });

    // ================================================================================================ anti-replay compartido
    describe('anti-replay y nonces COMPARTIDOS en PostgreSQL; saturacion por clientes anonimos', () => {
      type MobileOpts = NonNullable<NonNullable<Parameters<AdminKit['build']>[1]>['mobile']>;
      const GENEROUS = {
        enrollIp: 1000,
        challengeIp: 10_000,
        tokenFailIp: 10_000,
        tokenFailKey: 10_000,
        claimFailUser: 10_000,
      };
      /** Una "instancia" de la API: proceso nuevo, memoria vacia, MISMA base. */
      const instance = async (mobile: Partial<MobileOpts> = {}, store?: SessionStore) => {
        const target = await kit.build(
          {},
          {
            mobile: { publicBaseUrl: BASE, limits: GENEROUS, ...mobile },
            ...(store ? { store } : {}),
          },
        );
        await target.ready();
        return target;
      };
      const proofs = (thumb: string) =>
        n(`select count(*) n from mobile_proof_jtis where key_thumbprint = $1`, [thumb]);
      const totalState = async () =>
        (await n('select count(*) n from mobile_proof_jtis')) +
        (await n('select count(*) n from mobile_nonces'));
      const meHeaders = (dev: FakeDevice, access: string, jti?: string) => ({
        authorization: `DPoP ${access}`,
        dpop: dev.proof({
          method: 'GET',
          url: `${BASE}/mobile/me`,
          accessToken: access,
          ...(jti ? { jti } : {}),
        }),
      });
      const me = (target: FastifyInstance, headers: Record<string, string>) =>
        target.inject({ method: 'GET', url: '/mobile/me', headers });

      it('una prueba aceptada se guarda solo como hash y NO se acepta otra vez: ni en la misma instancia, ni en otra, ni tras reiniciar', async () => {
        const s = await linkedSession(app, prefA);
        const jti = 'jti-visible-solo-en-la-prueba-0001';
        const headers = meHeaders(s.dev, s.tokens.accessToken, jti);
        expect((await me(app, headers)).statusCode).toBe(200);
        const dump = JSON.stringify(
          await q(`select * from mobile_proof_jtis where key_thumbprint = $1`, [s.dev.thumbprint]),
        );
        expect(dump).not.toContain(jti); // el identificador lo elige el cliente: no se guarda en claro
        expect(dump).not.toContain(s.tokens.accessToken);
        const again = await me(app, headers);
        expect([again.statusCode, json(again).error.code]).toEqual([401, 'INVALID_PROOF']);
        const other = await instance(); // otra instancia: no comparte memoria, si la base
        expect((await me(other, headers)).statusCode).toBe(401);
        const restarted = await instance(); // reinicio: memoria vacia, el estado sigue en PostgreSQL
        expect((await me(restarted, headers)).statusCode).toBe(401);
        // una prueba NUEVA de la misma clave si pasa en la instancia reiniciada
        expect((await api(restarted, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(200);
        await Promise.all([other.close(), restarted.close()]);
      });

      it('dos instancias reciben la MISMA prueba a la vez: solo una la acepta', async () => {
        const s = await linkedSession(app, prefA);
        const second = await instance();
        for (let round = 0; round < 5; round += 1) {
          const headers = meHeaders(s.dev, s.tokens.accessToken);
          const res = await Promise.all([me(app, headers), me(second, headers)]);
          expect(res.map((r) => r.statusCode).sort(), `ronda ${round}`).toEqual([200, 401]);
        }
        await second.close();
      });

      it('NONCE: de un solo uso por operacion, ligado a SU clave y vigente minutos; la repeticion de la prueba (jti) se rechaza aunque el nonce sea valido', async () => {
        const s = await linkedSession(app, prefA);
        const other = await link(app, prefB); // otra clave conocida
        const url = '/mobile/auth/token';
        const post = (dev: FakeDevice, nonce: string, extra: { jti?: string } = {}) =>
          app.inject({
            method: 'POST',
            url,
            headers: { dpop: dev.proof({ method: 'POST', url: BASE + url, nonce, ...extra }) },
          });
        const nonce = await challenge(app, s.dev);
        const crossed = await post(other.dev, nonce); // el nonce es de OTRA clave
        expect([crossed.statusCode, json(crossed).error.code]).toEqual([401, 'NONCE_INVALID']);
        const proof = s.dev.proof({ method: 'POST', url: BASE + url, nonce });
        const ok = await app.inject({ method: 'POST', url, headers: { dpop: proof } });
        expect(ok.statusCode, ok.body).toBe(200); // el intento ajeno no gasto el nonce
        const spent = await post(s.dev, nonce); // prueba NUEVA con el nonce ya gastado
        expect([spent.statusCode, json(spent).error.code]).toEqual([401, 'NONCE_INVALID']);
        const same = await app.inject({ method: 'POST', url, headers: { dpop: proof } });
        expect([same.statusCode, json(same).error.code]).toEqual([401, 'INVALID_PROOF']); // jti repetido
        expect(
          await n(
            `select count(*) n from mobile_nonces where key_thumbprint = $1 and consumed_at is null`,
            [s.dev.thumbprint],
          ),
        ).toBe(0);
      });

      it('CUPOS por clave y CADUCIDAD: nonces y pruebas vigentes acotados; se recuperan al vencer', async () => {
        let offsetMs = 0;
        const capped = await instance({
          clock: () => new Date(Date.now() + offsetMs),
          config: { maxProofsPerKey: 8, maxNoncesPerKey: 2 },
        });
        const l = await link(capped, prefA);
        l.dev.clock = () => Date.now() + offsetMs;
        const c1 = await challengeRaw(capped, l.dev);
        const c2 = await challengeRaw(capped, l.dev);
        const c3 = await challengeRaw(capped, l.dev);
        expect([c1, c2, c3].map((r) => r.statusCode)).toEqual([200, 200, 429]); // tope de nonces por clave
        expect(c3.headers['retry-after']).toBeDefined();
        // gastar un nonce libera su cupo
        const t = await capped.inject({
          method: 'POST',
          url: '/mobile/auth/token',
          headers: {
            dpop: l.dev.proof({
              method: 'POST',
              url: `${BASE}/mobile/auth/token`,
              nonce: json(c1).nonce,
            }),
          },
        });
        expect(t.statusCode, t.body).toBe(200);
        const unspent = json(c2).nonce as string; // sin gastar: vencera
        expect((await challengeRaw(capped, l.dev)).statusCode).toBe(200);
        // tope de pruebas vigentes por clave (8: ya van 7 en la ventana)
        const tokens = json(t) as Tokens;
        expect((await api(capped, l.dev, tokens, 'GET', '/mobile/me')).statusCode).toBe(200);
        const before = await proofs(l.dev.thumbprint);
        const limited = await api(capped, l.dev, tokens, 'GET', '/mobile/me');
        expect([limited.statusCode, json(limited).error.code]).toEqual([429, 'RATE_LIMITED']);
        expect(limited.headers['retry-after']).toBeDefined();
        expect(await proofs(l.dev.thumbprint)).toBe(before); // rechazar no consume cupo
        // al vencer la ventana el cupo se recupera (sin bloqueo permanente) y el nonce sin gastar ya no sirve
        offsetMs = 130_000;
        expect((await api(capped, l.dev, tokens, 'GET', '/mobile/me')).statusCode).toBe(200);
        const late = await capped.inject({
          method: 'POST',
          url: '/mobile/auth/token',
          headers: {
            dpop: l.dev.proof({
              method: 'POST',
              url: `${BASE}/mobile/auth/token`,
              nonce: unspent,
            }),
          },
        });
        expect([late.statusCode, json(late).error.code]).toEqual([401, 'NONCE_INVALID']);
        await capped.close();
      });

      it('un anonimo con claves arbitrarias NO consume estado compartido (ni jti ni nonces) y no sondea solicitudes ajenas', async () => {
        const dev = new FakeDevice();
        const req = await enroll(app, dev); // solicitud legitima, pendiente
        const statusUrl = `/mobile/enroll/requests/${req.requestId}`;
        const activateUrl = `${statusUrl}/activate`;
        const before = await totalState();
        const randomId = '019a0000-0000-7000-8000-000000000000';
        for (let i = 0; i < 15; i += 1) {
          const evil = new FakeDevice();
          const st = await app.inject({
            method: 'GET',
            url: statusUrl,
            headers: { dpop: evil.proof({ method: 'GET', url: BASE + statusUrl }) },
          });
          const none = await app.inject({
            method: 'GET',
            url: `/mobile/enroll/requests/${randomId}`,
            headers: {
              dpop: evil.proof({
                method: 'GET',
                url: `${BASE}/mobile/enroll/requests/${randomId}`,
              }),
            },
          });
          // la solicitud ajena responde IGUAL que una inexistente: no se revela nada
          expect([st.statusCode, json(st).error.code]).toEqual([404, 'REQUEST_NOT_FOUND']);
          expect([none.statusCode, json(none).error.code]).toEqual([404, 'REQUEST_NOT_FOUND']);
          expect(json(st).error.message).toBe(json(none).error.message);
          expect((await challengeRaw(app, evil)).statusCode).toBe(401);
          const act = await app.inject({
            method: 'POST',
            url: activateUrl,
            headers: {
              dpop: evil.proof({ method: 'POST', url: BASE + activateUrl, nonce: 'N'.repeat(32) }),
            },
          });
          expect(act.statusCode).toBe(404);
          const tok = await app.inject({
            method: 'POST',
            url: '/mobile/auth/token',
            headers: {
              dpop: evil.proof({
                method: 'POST',
                url: `${BASE}/mobile/auth/token`,
                nonce: 'N'.repeat(32),
              }),
            },
          });
          expect([tok.statusCode, json(tok).error.code]).toEqual([401, 'UNKNOWN_DEVICE']);
        }
        const malformed = await app.inject({
          method: 'GET',
          url: '/mobile/enroll/requests/no-es-un-uuid',
          headers: {
            dpop: dev.proof({ method: 'GET', url: `${BASE}/mobile/enroll/requests/no-es-un-uuid` }),
          },
        });
        expect(malformed.statusCode).toBe(400);
        expect(await totalState()).toBe(before); // 15 claves ajenas x 5 rutas: cero filas
        // la clave legitima sigue consultando SU solicitud, solo una vez por prueba, y solo ve su propio estado
        const proof = dev.proof({ method: 'GET', url: BASE + statusUrl });
        const mine = await app.inject({ method: 'GET', url: statusUrl, headers: { dpop: proof } });
        expect(mine.statusCode, mine.body).toBe(200);
        expect(Object.keys(json(mine)).sort()).toEqual([
          'claimedBy',
          'expiresAt',
          'fingerprint',
          'requestId',
          'status',
        ]);
        const twice = await app.inject({ method: 'GET', url: statusUrl, headers: { dpop: proof } });
        expect(twice.statusCode).toBe(401);
      });

      it('una prueba invalida NUNCA deja estado: jti enorme, firma ajena, htm, htu, token ajeno, sin cabecera o cabecera exagerada', async () => {
        const s = await linkedSession(app, prefA);
        const o = await linkedSession(app, prefB);
        const base = await proofs(s.dev.thumbprint);
        const access = s.tokens.accessToken;
        const url = '/mobile/me';
        const cases: Record<string, Record<string, string>> = {
          'jti de 200 caracteres': meHeaders(s.dev, access, 'x'.repeat(200)),
          'firma de otra clave': {
            authorization: `DPoP ${access}`,
            dpop: s.dev.proof({
              method: 'GET',
              url: BASE + url,
              accessToken: access,
              signWith: o.dev.privateKey,
            }),
          },
          'metodo distinto': {
            authorization: `DPoP ${access}`,
            dpop: s.dev.proof({ method: 'POST', url: BASE + url, accessToken: access }),
          },
          'URL distinta': {
            authorization: `DPoP ${access}`,
            dpop: s.dev.proof({ method: 'GET', url: `${BASE}/mobile/otra`, accessToken: access }),
          },
          'token de OTRO dispositivo con mi prueba': meHeaders(s.dev, o.tokens.accessToken),
          'sin cabecera DPoP': { authorization: `DPoP ${access}` },
          'cabecera DPoP exagerada': { authorization: `DPoP ${access}`, dpop: 'a.'.repeat(5000) },
        };
        for (const [name, headers] of Object.entries(cases)) {
          const r = await me(app, headers);
          expect(r.statusCode, name).toBe(401);
          expect(await proofs(s.dev.thumbprint), name).toBe(base);
        }
        expect((await api(app, s.dev, s.tokens, 'GET', '/mobile/me')).statusCode).toBe(200);
      });

      it('si PostgreSQL falla durante la validacion anti-replay, la peticion se RECHAZA (503, falla cerrado) y despues se recupera', async () => {
        let down = false;
        const store = kit.harness.store;
        const flaky: SessionStore = {
          transaction: (fn) =>
            store.transaction((tx) =>
              fn({
                query: async (text: string, params?: unknown[]) => {
                  if (down && /mobile_proof_jtis|mobile_nonces/.test(text))
                    throw Object.assign(new Error('boom: conexion perdida con la base'), {
                      code: '57P01',
                    });
                  return tx.query(text, params);
                },
              }),
            ),
        };
        const target = await instance({}, flaky);
        const l = await link(target, prefA);
        const t = json(await token(target, l.dev)) as Tokens;
        expect((await api(target, l.dev, t, 'GET', '/mobile/me')).statusCode).toBe(200);
        down = true;
        for (const [name, res] of [
          ['acceso', await api(target, l.dev, t, 'GET', '/mobile/me')],
          ['lectura escolar', await api(target, l.dev, t, 'GET', '/mobile/school/me/groups')],
          ['desafio', await challengeRaw(target, l.dev)],
        ] as const) {
          expect([res.statusCode, json(res).error.code], name).toEqual([
            503,
            'MOBILE_AUTH_UNAVAILABLE',
          ]);
          expect(res.body, name).not.toMatch(/boom|conexion|57P01|mobile_proof_jtis/i);
        }
        expect(kit.logs.join('')).not.toContain('boom'); // ni el mensaje interno llega a los logs
        down = false;
        expect((await api(target, l.dev, t, 'GET', '/mobile/me')).statusCode).toBe(200);
        await target.close();
      });
    });

    // ================================================================================================ limites compartidos
    describe('LIMITES COMPARTIDOS (PostgreSQL), solicitudes pendientes y retencion de IP', () => {
      type MobileOpts = NonNullable<NonNullable<Parameters<AdminKit['build']>[1]>['mobile']>;
      const GENEROUS = {
        enrollIp: 1000,
        challengeIp: 10_000,
        tokenFailIp: 10_000,
        tokenFailKey: 10_000,
        claimFailUser: 10_000,
      };
      const instance = async (mobile: Partial<MobileOpts> = {}) => {
        const target = await kit.build(
          {},
          { mobile: { publicBaseUrl: BASE, limits: GENEROUS, ...mobile } },
        );
        await target.ready();
        return target;
      };
      const enrollFrom = (target: FastifyInstance, ip: string, dev = new FakeDevice()) =>
        target.inject({
          method: 'POST',
          url: '/mobile/enroll/requests',
          remoteAddress: ip,
          payload: { publicKey: dev.jwk, label: 'x', platform: 'android' },
        });
      const cleanIp = (ip: string) =>
        q(
          `update mobile_device_requests set status = 'cancelled' where requested_ip = $1::inet and status = 'pending'`,
          [ip],
        );

      it('solicitudes por IP y ventana: limite COMPARTIDO entre instancias, con Retry-After, y se recupera al vencer', async () => {
        let offsetMs = 0;
        const mobile = {
          clock: () => new Date(Date.now() + offsetMs),
          limits: { ...GENEROUS, enrollIp: 3 },
          config: { ipWindowSeconds: 60, maxPendingPerIp: 100 },
        };
        const a = await instance(mobile);
        const b = await instance(mobile); // otra instancia: memoria propia, MISMA base
        const ip = '10.30.0.1';
        const res = [
          await enrollFrom(a, ip),
          await enrollFrom(b, ip),
          await enrollFrom(a, ip),
          await enrollFrom(b, ip), // la cuarta ya excede el limite, aunque cada instancia solo vio dos
        ];
        expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201, 429]);
        expect(json(res[3]!).error.code).toBe('IP_RATE_LIMITED');
        const retry = Number(res[3]!.headers['retry-after']);
        expect(retry).toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(60);
        expect((await enrollFrom(a, '10.30.0.2')).statusCode).toBe(201); // otra IP: su propio cupo
        offsetMs = 61_000; // vence la ventana: recuperacion automatica en cualquier instancia
        expect((await enrollFrom(b, ip)).statusCode).toBe(201);
        await Promise.all([a.close(), b.close()]);
      });

      it('la tabla no crece sin limite por solicitudes anonimas: cada IP queda acotada por su limite de ventana', async () => {
        const target = await instance({
          limits: { ...GENEROUS, enrollIp: 4 },
          config: { maxPendingPerIp: 100 },
        });
        const before = await n(`select count(*) n from mobile_device_requests`);
        const codes: number[] = [];
        for (let i = 0; i < 25; i += 1)
          codes.push((await enrollFrom(target, '10.31.0.9')).statusCode);
        expect(codes.filter((c) => c === 201)).toHaveLength(4);
        expect(await n(`select count(*) n from mobile_device_requests`)).toBe(before + 4);
        await target.close();
      });

      it('cupo global lleno: EXPULSION JUSTA (se cierra la solicitud mas antigua de la red con mas pendientes) y nadie queda fuera por un abuso ajeno', async () => {
        await q(`update mobile_device_requests set status = 'cancelled' where status = 'pending'`);
        const target = await instance({ config: { maxPendingRequests: 3, maxPendingPerIp: 2 } });
        const heavy1 = await enrollFrom(target, '10.32.0.1');
        const heavy2 = await enrollFrom(target, '10.32.0.1');
        const other = await enrollFrom(target, '10.32.0.2');
        expect([heavy1, heavy2, other].map((r) => r.statusCode)).toEqual([201, 201, 201]); // 3 de 3
        const newcomer = await enrollFrom(target, '10.32.0.3'); // llega alguien legitimo con el cupo lleno
        expect(newcomer.statusCode, newcomer.body).toBe(201);
        const status = async (id: string) =>
          (await q(`select status from mobile_device_requests where id = $1`, [id]))[0]!.status;
        expect(await status(json(heavy1).requestId)).toBe('cancelled'); // la mas antigua de la red que mas tenia
        expect(await status(json(heavy2).requestId)).toBe('pending');
        expect(await status(json(other).requestId)).toBe('pending');
        expect(
          await n(
            `select count(*) n from audit_events where event_type = 'mobile.request_evicted'`,
          ),
        ).toBeGreaterThanOrEqual(1);
        // sin una red claramente abusadora no se expulsa a nadie: se rechaza con Retry-After
        const late = await enrollFrom(target, '10.32.0.4');
        expect([late.statusCode, json(late).error.code]).toEqual([429, 'TOO_MANY_PENDING']);
        expect(late.headers['retry-after']).toBeDefined();
        await q(`update mobile_device_requests set status = 'cancelled' where status = 'pending'`);
        await target.close();
      });

      it('una vinculacion VENCIDA de la persona no la bloquea: se cierra (sin borrar) y puede reclamar otra', async () => {
        let offsetMs = 0;
        const target = await instance({ clock: () => new Date(Date.now() + offsetMs) });
        const acc = await kit.seed({ role: 'prefectura' });
        const me = await kit.login(acc, target);
        const claimFor = async (dev: FakeDevice) => {
          const req = await enroll(target, dev);
          return {
            req,
            res: await kit.call(me, 'POST', '/mobile-devices/claims', {
              body: { requestId: req.requestId, code: req.pairingCode },
              target,
            }),
          };
        };
        const first = await claimFor(new FakeDevice());
        expect(first.res.statusCode, first.res.body).toBe(200);
        const blocked = await claimFor(new FakeDevice()); // aun vigente: una vinculacion en curso por persona
        expect(blocked.res.statusCode).toBe(409);
        offsetMs = 11 * 60_000; // la primera vencio
        const second = await claimFor(new FakeDevice());
        expect(second.res.statusCode, second.res.body).toBe(200);
        expect(
          (
            await q(`select status from mobile_device_requests where id = $1`, [
              first.req.requestId,
            ])
          )[0]!.status,
        ).toBe('cancelled');
        await q(
          `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status = 'claimed'`,
          [acc.id],
        );
        await target.close();
      });

      it('reclamos fallidos por CUENTA autenticada: limite COMPARTIDO entre instancias, con Retry-After, y se recupera al vencer la ventana', async () => {
        const mobile = {
          limits: { ...GENEROUS, claimFailUser: 3 },
          config: { claimFailureWindowSeconds: 2 },
        };
        const a = await instance(mobile);
        const b = await instance(mobile);
        const acc = await kit.seed({ role: 'prefectura' });
        const meA = await kit.login(acc, a);
        const meB = await kit.login(acc, b);
        const bad = async (target: FastifyInstance, who: Login) => {
          const req = await enroll(target, new FakeDevice());
          return kit.call(who, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: 'AAAA-AAAA' },
            target,
          });
        };
        expect((await bad(a, meA)).statusCode).toBe(400);
        expect((await bad(b, meB)).statusCode).toBe(400);
        expect((await bad(a, meA)).statusCode).toBe(400);
        const limited = await bad(b, meB); // el cuarto fallo de la cuenta, vea la instancia que vea
        expect([limited.statusCode, json(limited).error.code]).toEqual([429, 'CLAIM_RATE_LIMITED']);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        // otra cuenta no se ve afectada
        const other = await kit.seed({ role: 'prefectura' });
        expect((await bad(a, await kit.login(other, a))).statusCode).toBe(400);
        await new Promise((r) => setTimeout(r, 2300)); // vence la ventana
        expect((await bad(b, meB)).statusCode).toBe(400); // ya no limitada (vuelve a contar)
        await q(`update mobile_device_requests set status = 'cancelled' where status = 'pending'`);
        await Promise.all([a.close(), b.close()]);
      });

      it('RETENCION de IP: la solicitud y la sesion guardan la IP exacta (para limites y revision); la auditoria inmutable solo la red /24', async () => {
        const target = await instance();
        const res = await enrollFrom(target, '10.77.5.123');
        expect(res.statusCode).toBe(201);
        const row = (
          await q(`select host(requested_ip) ip from mobile_device_requests where id = $1`, [
            json(res).requestId,
          ])
        )[0]!;
        expect(row.ip).toBe('10.77.5.123');
        const audit = await q(
          `select host(ip) ip from audit_events where event_type = 'mobile.device_requested' and details->>'requestId' = $1`,
          [json(res).requestId],
        );
        expect(audit[0]!.ip).toBe('10.77.5.0'); // red /24: sin la IP exacta
        // ningun evento de auditoria del canal anonimo guarda una IP exacta
        const exact = await q(
          `select event_type, host(ip) ip from audit_events where event_type like 'mobile.%' and ip is not null and family(ip) = 4 and host(ip) !~ '\\.0$'
              and actor_user_id is null`,
        );
        expect(exact).toEqual([]);
        await cleanIp('10.77.5.123');
        await target.close();
      });
    });

    // ================================================================================================ regresion web
    describe('REGRESION: las rutas WEB que comparten handlers con el canal movil no cambian ni se debilitan', () => {
      const bodyOf = (r: Res) => {
        const parsed = r.body ? (JSON.parse(r.body) as Json) : null;
        if (parsed?.error) delete parsed.error.requestId;
        if (parsed && 'generatedAt' in parsed) delete parsed.generatedAt; // sello de tiempo: cambia entre llamadas
        return parsed;
      };

      it('con el canal movil habilitado, cada ruta web responde IGUAL (estado y cuerpo) que sin el: grupos propios, padron, 403, 404, 400 y 401', async () => {
        const without = await kit.build(); // misma base y mismas cuentas, SIN canal movil
        await without.ready();
        const urls = [
          '/school/me/groups',
          '/school/me/groups?x=1',
          `/school/groups/${ids.gA}/roster`,
          `/school/groups/${ids.gB}/roster`,
          `/school/groups/${ids.gA}/roster?page=1`,
          '/school/groups/019a0000-0000-7000-8000-000000000000/roster',
          '/school/groups/no-es-uuid/roster',
          '/school/students',
          '/school/students?limit=1',
        ];
        const who: Array<[string, Login | null]> = [
          ['prefectura A', prefA],
          ['prefectura B', prefB],
          ['direccion', boss],
          ['admin tecnico', tecnico],
          ['sin rol', noRole],
          ['anonimo', null],
        ];
        const seen = new Set<number>();
        for (const [name, login] of who) {
          for (const url of urls) {
            const a = await kit.call(login, 'GET', url, { target: app });
            const b = await kit.call(login, 'GET', url, { target: without });
            expect([name, url, a.statusCode, bodyOf(a)], `${name} ${url}`).toEqual([
              name,
              url,
              b.statusCode,
              bodyOf(b),
            ]);
            seen.add(a.statusCode);
          }
        }
        // la comparacion no es vacia: hubo exito, rechazos por permiso, no encontrado, datos invalidos y sin sesion
        for (const status of [200, 400, 401, 403, 404])
          expect([...seen], `se esperaba algun ${status}`).toContain(status);
        // y los alcances siguen siendo los de siempre en la web
        const mine = bodyOf(await kit.call(prefA, 'GET', '/school/me/groups', { target: app }))!;
        expect(mine.groups).toHaveLength(1);
        const foreign = await kit.call(prefA, 'GET', `/school/groups/${ids.gB}/roster`, {
          target: app,
        });
        expect(foreign.statusCode).toBe(404);
        const roster = bodyOf(
          await kit.call(prefA, 'GET', `/school/groups/${ids.gA}/roster`, { target: app }),
        )!;
        expect(JSON.stringify(roster)).not.toMatch(/schoolCode|school_code|curp|birth/i);
        await without.close();
      });

      it('CSRF y Origin siguen exigidos en las mutaciones web con el canal movil habilitado (la exencion es solo de /mobile)', async () => {
        const body = { requestId: '019a0000-0000-7000-8000-000000000000', code: 'ABCD-EFGH' };
        const post = (opts: { csrf?: boolean | string; origin?: boolean }) =>
          kit.call(prefA, 'POST', '/mobile-devices/claims', { body, target: app, ...opts });
        expect((await post({ csrf: false })).statusCode).toBe(403); // sin token CSRF
        expect((await post({ csrf: 'otro-token' })).statusCode).toBe(403); // token CSRF ajeno
        expect((await post({ origin: false })).statusCode).toBe(403); // sin Origin
        const foreignOrigin = await app.inject({
          method: 'POST',
          url: '/mobile-devices/claims',
          headers: {
            origin: 'http://evil.test',
            'sec-fetch-site': 'cross-site',
            cookie: prefA.cookie,
            'x-csrf-token': prefA.csrf,
          },
          payload: body,
        });
        expect(foreignOrigin.statusCode).toBe(403); // Origin ajeno aun con cookie y CSRF validos
        const logout = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { origin: 'http://evil.test', cookie: prefA.cookie, 'x-csrf-token': prefA.csrf },
        });
        expect(logout.statusCode).toBe(403);
        // una cookie web NO sirve como credencial movil y una credencial movil NO sirve como cookie (ya probado arriba): aqui
        // ademas, una peticion con SOLO la cabecera DPoP/Authorization de un token inexistente no abre la web
        const fake = await app.inject({
          method: 'POST',
          url: '/mobile-devices/claims',
          headers: { origin: 'http://127.0.0.1:5173', authorization: `DPoP ${'A'.repeat(43)}` },
          payload: body,
        });
        expect([401, 403]).toContain(fake.statusCode);
        // la sesion web de prefA sigue intacta tras los intentos rechazados
        expect((await kit.call(prefA, 'GET', '/auth/me', { target: app })).statusCode).toBe(200);
      });

      it('la revocacion de la sesion web es inmediata en las rutas compartidas', async () => {
        const acc = await kit.seed({ role: 'prefectura' });
        const me = await kit.login(acc, app);
        expect((await kit.call(me, 'GET', '/school/me/groups', { target: app })).statusCode).toBe(
          200,
        );
        const out = await kit.call(me, 'POST', '/auth/logout', { target: app });
        expect([200, 204]).toContain(out.statusCode);
        expect((await kit.call(me, 'GET', '/school/me/groups', { target: app })).statusCode).toBe(
          401,
        );
      });
    });

    // ================================================================================================ carreras HTTP
    describe('carreras entre peticiones simultaneas (conexiones independientes en PostgreSQL real)', () => {
      it('REVOCACION contra RENOVACION a la vez: nunca queda una sesion util en un dispositivo revocado', async () => {
        for (let round = 0; round < 6; round += 1) {
          const s = await linkedSession(app, prefA);
          const [ren, rev] = await Promise.all([
            refresh(app, s.dev, s.tokens.refreshToken),
            kit.call(boss, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
              body: { reason: 'authority' },
              target: app,
            }),
          ]);
          expect(rev.statusCode, `ronda ${round}: ${rev.body}`).toBe(200);
          expect([200, 401], `ronda ${round} renovacion`).toContain(ren.statusCode);
          expect(
            await n(
              `select count(*) n from mobile_sessions where device_id = $1 and revoked_at is null`,
              [s.deviceId],
            ),
            `ronda ${round}: sesion activa en un dispositivo revocado`,
          ).toBe(0);
          if (ren.statusCode === 200) {
            // la renovacion gano la carrera pero la revocacion llego despues: sus credenciales ya no sirven
            const t = json(ren) as Tokens;
            expect((await api(app, s.dev, t, 'GET', '/mobile/me')).statusCode).toBe(401);
          }
          expect((await token(app, s.dev)).statusCode).toBe(401);
        }
      });

      it('APROBACION contra CANCELACION a la vez: estado coherente y la activacion solo existe si quedo aprobada', async () => {
        for (let round = 0; round < 6; round += 1) {
          await q(
            `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed', 'approved')`,
            [accA.id],
          );
          const dev = new FakeDevice();
          const req = await enroll(app, dev);
          const claim = await kit.call(prefA, 'POST', '/mobile-devices/claims', {
            body: { requestId: req.requestId, code: req.pairingCode },
            target: app,
          });
          expect(claim.statusCode, claim.body).toBe(200);
          const [approve, cancel] = await Promise.all([
            kit.call(boss, 'POST', `/mobile-devices/requests/${req.requestId}/approve`, {
              body: { fingerprint: req.fingerprint },
              target: app,
            }),
            kit.call(prefA, 'POST', `/mobile-devices/mine/requests/${req.requestId}/cancel`, {
              body: {},
              target: app,
            }),
          ]);
          const label = `ronda ${round}: aprobar=${approve.statusCode} cancelar=${cancel.statusCode}`;
          expect([200, 409], label).toContain(approve.statusCode);
          expect([200, 409], label).toContain(cancel.statusCode);
          expect([approve.statusCode, cancel.statusCode], label).toContain(200); // alguna gano
          const final = (
            await q(`select status from mobile_device_requests where id = $1`, [req.requestId])
          )[0]!.status as string;
          expect(['approved', 'cancelled'], label).toContain(final);
          if (final === 'cancelled') {
            // una solicitud cerrada deja de ser "clave conocida": ni desafio ni activacion
            expect((await challengeRaw(app, dev)).statusCode, `${label}: desafio`).toBe(401);
            expect(
              await n(`select count(*) n from mobile_devices where request_id = $1`, [
                req.requestId,
              ]),
              label,
            ).toBe(0);
          } else {
            const act = await activate(app, dev, req.requestId);
            expect(act.statusCode, `${label}: ${act.body}`).toBe(201);
          }
        }
      });
    });

    // ================================================================================================ transversales
    describe('seguridad transversal', () => {
      it('limites: solicitudes de vinculacion por IP y tokens fallidos por clave', async () => {
        const limited = await kit.build(
          {},
          {
            mobile: {
              publicBaseUrl: BASE,
              limits: {
                enrollIp: 2,
                challengeIp: 3,
                tokenFailIp: 100,
                tokenFailKey: 2,
                claimFailUser: 100,
              },
            },
          },
        );
        await limited.ready();
        const devs = [new FakeDevice(), new FakeDevice(), new FakeDevice()];
        const reqs = [];
        for (const d of devs) {
          reqs.push(
            await limited.inject({
              method: 'POST',
              url: '/mobile/enroll/requests',
              remoteAddress: '10.55.0.1', // el limite es compartido en la base: una IP propia de la prueba
              payload: { publicKey: d.jwk, label: 'x', platform: 'android' },
            }),
          );
        }
        expect(reqs.map((r) => r.statusCode)).toEqual([201, 201, 429]);
        expect(reqs[2]!.headers['retry-after']).toBeDefined();
        // desafios: la clave de la primera solicitud ya es conocida; tope por IP
        const ch = [];
        for (let i = 0; i < 4; i += 1) ch.push((await challengeRaw(limited, devs[0]!)).statusCode);
        expect(ch).toEqual([200, 200, 200, 429]);
        await limited.close();
      });

      it('el modulo no existe sin la opcion `mobile` y no se habilita en produccion', async () => {
        const off = await kit.build();
        await off.ready();
        for (const [m, url] of [
          ['POST', '/mobile/enroll/requests'],
          ['GET', '/mobile/me'],
          ['GET', '/mobile-devices/mine'],
          ['POST', '/mobile/auth/token'],
        ] as const) {
          const r = await off.inject({
            method: m,
            url,
            headers: { origin: 'http://127.0.0.1:5173' },
          });
          expect([url, r.statusCode === 404]).toEqual([url, true]);
        }
        await off.close();
        await expect(
          buildApp(loadEnv({ NODE_ENV: 'production', HOST: '127.0.0.1' }), {
            auth: { store: kit.harness.store, mobile: { publicBaseUrl: BASE } },
          }),
        ).rejects.toThrow(/production/);
      });

      it('CORS: un origen ajeno no recibe permisos en las rutas moviles', async () => {
        const r = await app.inject({
          method: 'OPTIONS',
          url: '/mobile/me',
          headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' },
        });
        expect(r.headers['access-control-allow-origin']).not.toBe('http://evil.example');
        expect(r.headers['access-control-allow-origin']).not.toBe('*');
      });

      it('auditoria: cada paso queda registrado sin secretos; los logs no contienen tokens, codigos ni claves', async () => {
        const s = await linkedSession(app, prefA);
        await kit.call(boss, 'POST', `/mobile-devices/devices/${s.deviceId}/revoke`, {
          body: { reason: 'authority' },
          target: app,
        });
        const types = (
          await q(`select distinct event_type from audit_events where event_type like 'mobile.%'`)
        ).map((r) => r.event_type as string);
        for (const t of [
          'mobile.device_requested',
          'mobile.device_claimed',
          'mobile.device_approved',
          'mobile.device_activated',
          'mobile.session_issued',
          'mobile.device_revoked',
        ]) {
          expect(types, t).toContain(t);
        }
        const dump = JSON.stringify(
          await q(`select details from audit_events where event_type like 'mobile.%'`),
        );
        expect(dump).not.toContain(s.tokens.accessToken);
        expect(dump).not.toContain(s.tokens.refreshToken);
        expect(dump).not.toMatch(/"d":|privateKey|pairing_code/);
        const logs = kit.logs.join('\n');
        expect(logs).not.toContain(s.tokens.accessToken);
        expect(logs).not.toContain(s.tokens.refreshToken);
        expect(logs).not.toContain(
          s.dev.proof({ method: 'GET', url: BASE + '/x' }).slice(0, 20) + 'zz',
        ); // sanidad del buscador
        for (const secret of kit.secrets) expect(logs).not.toContain(secret);
      });

      it('el sandbox no crea cuentas ni usuarios: ninguna ruta movil devuelve datos personales de otra cuenta', async () => {
        const before = await n(`select count(*) n from users`);
        await linkedSession(app, prefA);
        expect(await n(`select count(*) n from users`)).toBe(before);
        const mine = json(await kit.call(prefA, 'GET', '/mobile-devices/mine', { target: app }));
        expect(JSON.stringify(mine)).not.toContain(accB.email);
        expect(JSON.stringify(mine)).not.toContain('password');
      });
    });
  });
}
