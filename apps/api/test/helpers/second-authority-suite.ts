import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import {
  SECOND_AUTHORITY_PROCEDURES,
  WaiverError,
  grantSecondAuthorityWaiver,
} from '../../src/modules/activation/dual-control.js';
import { bootstrapFirstAuthority, type OwnerClient } from '../../src/modules/auth/bootstrap.js';
import { createPasswordService } from '../../src/modules/auth/password.js';
import type { SessionStore } from '../../src/modules/auth/session-service.js';
import { newBrowserSecret } from './activation-suite.js';
import { ORIGIN } from './auth-http-suite.js';

/**
 * Procedimiento EXCEPCIONAL para incorporar a la segunda autoridad de un dominio con una sola (dispensa del control dual):
 * la concede el propietario desde la consola con acta; no existe por HTTP. Dominio TECNICO (el escolar esta bloqueado).
 * Todo con cuentas FICTICIAS en una base desechable; nunca contra eta15_dev.
 */
const PARAMS = { memoryKiB: 20 * 1024, passes: 2, parallelism: 1, tagLength: 32 };
const LIMITS = {
  ipFailures: 100_000,
  pairFailures: 100_000,
  identityFailures: 100_000,
  floodLogin: 100_000,
  floodOther: 100_000,
  activationRequestIp: 100_000,
  activationRequestAccount: 100_000,
  activationCompleteFailures: 100_000,
};
const SPW = 'Primera autoridad tecnica de prueba 1';
const PPW = 'Segunda autoridad tecnica de prueba 2';
const ACTA = 'ACTA-SEGUNDA-AUTORIDAD-001';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function defineSecondAuthoritySuite(
  label: string,
  setup: () => Promise<{
    store: SessionStore;
    owner: OwnerClient;
    q: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    teardown: () => Promise<void>;
  }>,
): void {
  describe(`segunda autoridad: dispensa excepcional del control dual (${label})`, () => {
    let h: Awaited<ReturnType<typeof setup>>;
    let app: FastifyInstance;
    const passwords = createPasswordService({ params: PARAMS });
    const S = { id: '', email: 'autoridad.uno@escuela.test' };
    const P = { id: '', email: 'autoridad.dos@escuela.test' };
    const logs: string[] = [];

    const post = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        payload: payload as object,
      });
    async function login(email: string, password: string) {
      const res = await post('/auth/login', { email, password });
      expect(res.statusCode, 'login').toBe(200);
      const cookie = `${res.cookies[0]!.name}=${res.cookies[0]!.value}`;
      const csrf = (
        await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })
      ).json().csrfToken as string;
      return { cookie, csrf };
    }
    const call = (
      who: { cookie: string; csrf: string },
      method: 'GET' | 'POST',
      url: string,
      body?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          cookie: who.cookie,
          ...(method === 'POST' ? { 'x-csrf-token': who.csrf } : {}),
        },
        ...(body === undefined ? {} : { payload: body as object }),
      });
    const q = (sql: string, params: unknown[] = []) => h.q(sql, params);
    const waive = (
      over: Partial<Parameters<typeof grantSecondAuthorityWaiver>[0]> = {},
      deps = {},
    ) =>
      grantSecondAuthorityWaiver(
        { email: P.email, acta: ACTA, ...over },
        { client: h.owner, ...deps },
      );
    const waiverError = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (e) {
        return e instanceof WaiverError ? e.code : `otro:${String(e)}`;
      }
      return 'sin_error';
    };

    beforeAll(async () => {
      h = await setup();
      const b = await bootstrapFirstAuthority(
        {
          domain: 'technical',
          email: S.email,
          displayName: 'Primera autoridad ficticia',
          acta: 'ACTA-BOOTSTRAP-PRUEBA',
        },
        { client: h.owner, passwords, readPassword: async () => SPW },
      );
      S.id = b.userId;
      app = await buildApp(
        loadEnv({
          NODE_ENV: 'test',
          CORS_ORIGIN: ORIGIN,
          LOG_LEVEL: 'info',
          HOST: '127.0.0.1',
          AUTH_MFA_ENFORCEMENT: 'deferred',
        }),
        {
          auth: { store: h.store, passwords, limits: LIMITS },
          logStream: { write: (c: string) => void logs.push(c) },
        },
      );
    }, 240_000);
    afterAll(async () => {
      await app?.close();
      await h?.teardown();
    });

    let proof = newBrowserSecret();
    let requestId = '';

    it('la unica autoridad crea la cuenta de la segunda y le asigna el rol; la persona solicita su activacion', async () => {
      const s = await login(S.email, SPW);
      const created = await call(s, 'POST', '/admin/users', {
        email: P.email,
        displayName: 'Segunda autoridad ficticia',
        accountDomain: 'technical',
      });
      expect(created.statusCode).toBe(201);
      P.id = (created.json() as Json).id;
      expect(
        (await call(s, 'POST', `/admin/users/${P.id}/roles`, { roleKey: 'admin_tecnico' }))
          .statusCode,
      ).toBe(201);
      await post('/auth/activation/request', { email: P.email, secretHash: proof.secretHash });
      const list = (await call(s, 'GET', '/admin/activation-requests')).json() as Json;
      const item = list.items.find((r: Json) => r.email === P.email);
      expect(item.createdByActor).toBe(true);
      requestId = item.id;
    });

    it('SIN dispensa, quien creo la cuenta no puede aprobar su activacion (no hay otra autoridad)', async () => {
      const s = await login(S.email, SPW);
      const res = await call(s, 'POST', `/admin/activation-requests/${requestId}/approve`, {
        code: proof.code,
        verificationMethod: 'in_person_id',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/procedimiento excepcional/);
    });

    it('la dispensa solo la concede el propietario: un rol que no lo es (la API) es rechazado', async () => {
      const code = await waiverError(
        h.store.transaction((tx) =>
          grantSecondAuthorityWaiver({ email: P.email, acta: ACTA }, { client: tx as OwnerClient }),
        ),
      );
      expect(code).toBe('not_owner');
    });

    it('requisitos de la dispensa: acta, vigencia, cuenta pendiente con rol de autoridad y una sola autoridad activa', async () => {
      expect(await waiverError(waive({ acta: 'ab' }))).toBe('invalid_input');
      expect(await waiverError(waive({ email: 'no-es-correo' }))).toBe('invalid_input');
      expect(await waiverError(waive({ hours: 0 }))).toBe('invalid_input');
      expect(await waiverError(waive({ hours: 500 }))).toBe('invalid_input');
      expect(await waiverError(waive({ email: 'no.existe@escuela.test' }))).toBe('not_applicable');
      expect(await waiverError(waive({ email: S.email }))).toBe('not_applicable'); // cuenta activa, no pendiente
      // una cuenta pendiente SIN rol de autoridad no necesita dispensa
      await h.q(
        `insert into users (email, display_name, account_domain, status) values ('sin.rol@escuela.test','Sin rol','technical','pending')`,
      );
      expect(await waiverError(waive({ email: 'sin.rol@escuela.test' }))).toBe('not_applicable');
      expect(
        Number(
          (
            await q(
              `select count(*)::int n from audit_events where event_type = 'activation.waiver_granted'`,
            )
          ).rows[0]!.n,
        ),
      ).toBe(0);
    });

    it('el dominio ESCOLAR esta BLOQUEADO: falta el procedimiento institucional', async () => {
      expect(SECOND_AUTHORITY_PROCEDURES.school.approved).toBe(false);
      await h.q(
        `insert into users (email, display_name, account_domain, status) values ('escolar.pendiente@escuela.test','Escolar pendiente','school','pending')`,
      );
      const code = await waiverError(waive({ email: 'escolar.pendiente@escuela.test' }));
      expect(code).toBe('procedure_blocked');
      expect(
        Number(
          (
            await q(
              `select count(*)::int n from audit_events where event_type = 'activation.waiver_granted'`,
            )
          ).rows[0]!.n,
        ),
      ).toBe(0);
    });

    it('una dispensa CADUCADA no sirve', async () => {
      await waive({ hours: 0.00003 }); // ~0.1 s
      await new Promise((r) => setTimeout(r, 400));
      const s = await login(S.email, SPW);
      const res = await call(s, 'POST', `/admin/activation-requests/${requestId}/approve`, {
        code: proof.code,
        verificationMethod: 'in_person_id',
      });
      expect(res.statusCode).toBe(403);
    });

    it('con la dispensa vigente, el creador aprueba UNA vez; se audita y la dispensa se consume', async () => {
      const granted = await waive();
      expect(granted.domain).toBe('technical');
      const s = await login(S.email, SPW);
      const ok = await call(s, 'POST', `/admin/activation-requests/${requestId}/approve`, {
        code: proof.code,
        verificationMethod: 'in_person_id',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const events = await q(
        `select event_type, actor_user_id, details from audit_events where subject_user_id = $1 and event_type like 'activation.%' order by occurred_at`,
        [P.id],
      );
      const types = events.rows.map((e) => e.event_type);
      expect(types).toEqual(
        expect.arrayContaining([
          'activation.waiver_granted',
          'activation.waiver_used',
          'activation.authorized',
        ]),
      );
      const granted2 = events.rows.find((e) => e.event_type === 'activation.waiver_granted')!;
      expect((granted2.details as Json).acta).toBe(ACTA);
      expect(granted2.actor_user_id).toBeNull(); // la concedio la consola, no una sesion
      expect(
        events.rows.find((e) => e.event_type === 'activation.waiver_used')!.actor_user_id,
      ).toBe(S.id);
      // un solo uso: cancelar, reiniciar y volver a aprobar sin nueva dispensa se rechaza
      expect(
        (await call(s, 'POST', `/admin/activation-requests/${requestId}/cancel`)).statusCode,
      ).toBe(200);
      const again = newBrowserSecret();
      await post('/auth/activation/request', { email: P.email, secretHash: again.secretHash });
      const id2 = ((await call(s, 'GET', '/admin/activation-requests')).json() as Json).items.find(
        (r: Json) => r.email === P.email,
      ).id;
      const second = await call(s, 'POST', `/admin/activation-requests/${id2}/approve`, {
        code: again.code,
        verificationMethod: 'in_person_id',
      });
      expect(second.statusCode).toBe(403);
      // una nueva dispensa (otra acta) permite completar el proceso
      await waive({ acta: 'ACTA-SEGUNDA-AUTORIDAD-002' });
      expect(
        (
          await call(s, 'POST', `/admin/activation-requests/${id2}/approve`, {
            code: again.code,
            verificationMethod: 'in_person_known',
          })
        ).statusCode,
      ).toBe(200);
      proof = again;
    });

    it('la persona elige SU contrasena, entra, y ahora hay dos autoridades: se aprueban entre si sin dispensa', async () => {
      const done = await post('/auth/activation/complete', {
        secret: proof.secret,
        newPassword: PPW,
      });
      expect(done.statusCode, done.body).toBe(204);
      const p = await login(P.email, PPW);
      const me = (
        await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: p.cookie } })
      ).json() as Json;
      expect(me.roles).toEqual(['admin_tecnico']);
      // P crea una cuenta: S (otra autoridad) puede aprobarla; P no (la creo) y ya no hay dispensa posible (2 autoridades)
      const created = await call(p, 'POST', '/admin/users', {
        email: 'tercera@escuela.test',
        displayName: 'Tercera cuenta ficticia',
        accountDomain: 'technical',
      });
      expect(created.statusCode).toBe(201);
      const thirdId = (created.json() as Json).id as string;
      await call(p, 'POST', `/admin/users/${thirdId}/roles`, { roleKey: 'admin_tecnico' });
      const t = newBrowserSecret();
      await post('/auth/activation/request', {
        email: 'tercera@escuela.test',
        secretHash: t.secretHash,
      });
      const s = await login(S.email, SPW);
      const rid = ((await call(s, 'GET', '/admin/activation-requests')).json() as Json).items.find(
        (r: Json) => r.email === 'tercera@escuela.test',
      ).id;
      expect(
        (
          await call(p, 'POST', `/admin/activation-requests/${rid}/approve`, {
            code: t.code,
            verificationMethod: 'in_person_id',
          })
        ).statusCode,
      ).toBe(403);
      expect(await waiverError(waive({ email: 'tercera@escuela.test' }))).toBe('not_applicable'); // ya hay dos autoridades
      expect(
        (
          await call(s, 'POST', `/admin/activation-requests/${rid}/approve`, {
            code: t.code,
            verificationMethod: 'in_person_id',
          })
        ).statusCode,
      ).toBe(200);
    });

    it('ninguna fuga: ni acta ni contrasenas ni secretos en los registros de auditoria o de log', async () => {
      const audit = (await q(`select string_agg(a::text, ' ') as d from audit_events a`)).rows[0]!
        .d as string;
      for (const secret of [SPW, PPW, proof.secret, proof.secretHash]) {
        expect(audit.includes(secret)).toBe(false);
        expect(logs.join('').includes(secret)).toBe(false);
      }
    });
  });
}
