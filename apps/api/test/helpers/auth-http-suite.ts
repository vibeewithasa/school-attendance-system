import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { DEV_COOKIE_NAME, PROD_COOKIE_NAME } from '../../src/modules/auth/auth.routes.js';
import { type AuthLimits } from '../../src/modules/auth/auth.module.js';
import {
  createPasswordService,
  parsePasswordHash,
  type Argon2idParams,
  type PasswordService,
} from '../../src/modules/auth/password.js';
import type { SessionStore } from '../../src/modules/auth/session-service.js';

/**
 * Suite de pruebas HTTP de /auth/* con Fastify `inject` sobre una base PostgreSQL real (PGlite o clúster desechable),
 * ejecutada con un rol NO propietario equivalente a eta15_api. Todo es ficticio: correos, contrasenas y actas.
 */
export interface Harness {
  store: SessionStore;
  /** SQL como propietario del esquema (fixtures y alteraciones de estado que la API no puede hacer). */
  owner: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const ORIGIN = 'http://127.0.0.1:5173';
const STRONG = 'Clave-ficticia-de-prueba #1 ñá';
const APP_PARAMS: Argon2idParams = {
  memoryKiB: 20 * 1024,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
};
const OLD_PARAMS: Argon2idParams = {
  memoryKiB: 19 * 1024,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
};
const MIN = 60_000;
/** Limites holgados para que las pruebas no interfieran entre si; las de limites usan valores pequenos. */
const GENEROUS: Partial<AuthLimits> = {
  ipFailures: 10_000,
  pairFailures: 10_000,
  identityFailures: 10_000,
  floodLogin: 100_000,
  floodOther: 100_000,
};

type Res = LightMyRequestResponse;
const noRequestId = (r: Res) => {
  const j = r.json() as { error: { code: string; message: string } };
  return { status: r.statusCode, code: j.error.code, message: j.error.message };
};

export function defineAuthHttpSuite(
  label: string,
  setup: () => Promise<{ harness: Harness; teardown: () => Promise<void> }>,
): void {
  describe(`HTTP /auth (${label})`, () => {
    let harness: Harness;
    let teardown: () => Promise<void>;
    let boss: string;
    let seq = 0;
    let clockNow = new Date();
    const clock = () => clockNow;

    // Contador de trabajo costoso: cada autenticacion fallida debe gastar UNA derivacion (verify o decoy).
    const calls = { verify: 0, decoy: 0, hash: 0 };
    const real: PasswordService = createPasswordService({ params: APP_PARAMS });
    const passwords: PasswordService = {
      hash: (p) => (calls.hash++, hook.onHash ? hook.onHash(p) : real.hash(p)),
      verify: (h, p) => (calls.verify++, real.verify(h, p)),
      needsRehash: (h) => real.needsRehash(h),
      decoyVerify: (p) => (calls.decoy++, real.decoyVerify(p)),
    };
    const hook: { onHash?: (p: string) => Promise<string> } = {};
    const seedHasher = createPasswordService({ params: APP_PARAMS });
    const oldHasher = createPasswordService({ params: OLD_PARAMS });

    const logs: string[] = [];
    const logStream = { write: (chunk: string) => void logs.push(chunk) };
    const transcript: string[] = []; // cuerpos y cabeceras (salvo set-cookie) de todas las respuestas

    let app: FastifyInstance;
    let prodApp: FastifyInstance;
    const csrfValues = new Set<string>(); // valores CSRF: legitimos en el cuerpo de /auth/csrf, pero nunca en logs
    const secrets = new Set<string>(); // contrasenas ficticias y tokens emitidos: no deben aparecer en logs ni cuerpos

    const build = async (
      nodeEnv: 'test' | 'production',
      limits: Partial<AuthLimits> = {},
      stream = true,
    ) =>
      buildApp(
        loadEnv({ NODE_ENV: nodeEnv, CORS_ORIGIN: ORIGIN, LOG_LEVEL: 'info', HOST: '127.0.0.1' }),
        {
          auth: { store: harness.store, passwords, clock, limits: { ...GENEROUS, ...limits } },
          ...(stream ? { logStream } : {}),
        },
      );

    async function seedUser(opts: {
      password?: string | null;
      role?: string | null;
      domain?: 'school' | 'technical';
      status?: 'active' | 'disabled' | 'pending';
      lockedUntil?: Date | null;
      mustChange?: boolean;
      hasher?: PasswordService;
    }): Promise<{ id: string; email: string; password: string }> {
      const email = `persona-${++seq}@escuela.mx`;
      const password = opts.password === undefined ? `${STRONG}-${seq}` : (opts.password ?? '');
      secrets.add(password);
      const finalStatus = opts.status ?? 'active';
      const status = finalStatus === 'disabled' ? 'active' : finalStatus; // el rol se concede mientras esta activa
      const hash =
        status === 'pending' || !password ? null : await (opts.hasher ?? seedHasher).hash(password);
      const r = await harness.owner(
        `insert into users (email, display_name, account_domain, status, password_hash, locked_until, must_change_password)
         values ($1,'Persona de prueba',$2,$3,$4,$5,$6) returning id`,
        [
          email,
          opts.domain ?? 'school',
          status,
          hash,
          opts.lockedUntil ?? null,
          opts.mustChange ?? false,
        ],
      );
      const id = r.rows[0]!.id as string;
      if (opts.role !== null) {
        await harness.owner(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source)
           select $1, r.id, r.domain, $3, 'grant' from roles r where r.key = $2`,
          [id, opts.role ?? 'prefectura', boss],
        );
      }
      if (finalStatus === 'disabled')
        await harness.owner(`update users set status = 'disabled' where id = $1`, [id]);
      return { id, email, password };
    }

    const record = (res: Res) => {
      const { 'set-cookie': _omit, ...headers } = res.headers;
      void _omit;
      transcript.push(JSON.stringify({ headers, body: res.body }));
      return res;
    };
    const send = async (
      target: FastifyInstance,
      method: 'GET' | 'POST' | 'OPTIONS',
      url: string,
      opts: {
        payload?: unknown;
        headers?: Record<string, string>;
        ip?: string;
        origin?: boolean;
      } = {},
    ) => {
      const headers: Record<string, string> = {
        ...(opts.origin === false ? {} : { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
        ...opts.headers,
      };
      const res = await target.inject({
        method,
        url,
        headers,
        ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
        ...(opts.ip ? { remoteAddress: opts.ip } : {}),
      });
      return record(res);
    };
    const cookieName = (target: FastifyInstance) =>
      target === prodApp ? PROD_COOKIE_NAME : DEV_COOKIE_NAME;
    const login = (email: string, password: string, ip?: string, target?: FastifyInstance) =>
      send(target ?? app, 'POST', '/auth/login', { payload: { email, password }, ip });
    /** Inicia sesion y devuelve el valor de la cookie (token), que se registra como secreto. */
    async function session(
      user: { email: string; password: string },
      target: FastifyInstance = app,
    ) {
      const res = await login(user.email, user.password, undefined, target);
      expect(res.statusCode, 'login esperado').toBe(200);
      const c = res.cookies.find((x) => x.name === cookieName(target))!;
      secrets.add(c.value);
      return { token: c.value, cookie: `${cookieName(target)}=${c.value}` };
    }
    const me = (cookie: string, target: FastifyInstance = app) =>
      send(target, 'GET', '/auth/me', { headers: { cookie } });
    const activeSessions = async (id: string) =>
      Number(
        (
          await harness.owner(
            `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
            [id],
          )
        ).rows[0]!.n,
      );

    beforeAll(async () => {
      ({ harness, teardown } = await setup());
      const b = await harness.owner(
        `insert into users (email, display_name, account_domain, status, password_hash)
         values ('direccion-titular@escuela.mx','Titular','school','active',$1) returning id`,
        [await seedHasher.hash('titular-ficticio-0')],
      );
      boss = b.rows[0]!.id as string;
      await harness.owner(
        `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
         select $1, r.id, r.domain, null, 'bootstrap', 'ACTA-PRUEBA-001' from roles r where r.key='direccion'`,
        [boss],
      );
      app = await build('test');
      prodApp = await build('production');
    }, 240_000);
    afterAll(async () => {
      await Promise.allSettled([app?.close(), prodApp?.close()]);
      await teardown?.();
    });

    // ------------------------------------------------------------------ login
    describe('POST /auth/login', () => {
      it('1. login correcto con un rol no privilegiado: 200, cookie y cuerpo sin token', async () => {
        clockNow = new Date();
        const u = await seedUser({});
        const res = await login(u.email, u.password);
        expect(res.statusCode).toBe(200);
        const body = res.json() as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['mustChangePassword', 'session']);
        const cookie = res.cookies.find((c) => c.name === DEV_COOKIE_NAME)!;
        secrets.add(cookie.value);
        expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(res.body).not.toContain(cookie.value); // el token NO viaja en el JSON
        expect(res.headers['cache-control']).toBe('no-store');
        // y normaliza el correo: mayusculas y espacios
        const again = await login(`  ${u.email.toUpperCase()}  `, u.password);
        expect(again.statusCode).toBe(200);
        secrets.add(again.cookies.find((c) => c.name === DEV_COOKIE_NAME)!.value);
      });

      it('2-6. contrasena incorrecta, usuario inexistente, cuenta inactiva, bloqueada y sin activar: la MISMA respuesta 401', async () => {
        const good = await seedUser({});
        const disabled = await seedUser({ status: 'disabled' });
        const locked = await seedUser({ lockedUntil: new Date(Date.now() + 3_600_000) });
        const pending = await seedUser({ status: 'pending', password: null });
        const cases = [
          await login(good.email, 'contrasena-incorrecta-ficticia'),
          await login('nadie-existe@escuela.mx', 'contrasena-incorrecta-ficticia'),
          await login(disabled.email, disabled.password), // credenciales CORRECTAS de cuenta inactiva
          await login(locked.email, locked.password), // credenciales CORRECTAS de cuenta bloqueada
          await login(pending.email, 'cualquier-contrasena-ficticia'),
        ];
        const shapes = cases.map(noRequestId);
        for (const s of shapes)
          expect(s).toEqual({
            status: 401,
            code: 'INVALID_CREDENTIALS',
            message: 'Correo o contraseña incorrectos',
          });
        for (const r of cases) expect(r.cookies).toEqual([]);
        expect(await activeSessions(disabled.id)).toBe(0);
        expect(await activeSessions(locked.id)).toBe(0);
      });

      it('27. no enumeracion: todo fallo gasta exactamente UNA derivacion de Argon2id (verify o decoy)', async () => {
        const good = await seedUser({});
        const disabled = await seedUser({ status: 'disabled' });
        const pending = await seedUser({ status: 'pending', password: null });
        const measure = async (fn: () => Promise<unknown>) => {
          const before = calls.verify + calls.decoy;
          await fn();
          return calls.verify + calls.decoy - before;
        };
        expect(await measure(() => login(good.email, 'incorrecta-ficticia'))).toBe(1);
        expect(await measure(() => login('inexistente@escuela.mx', 'incorrecta-ficticia'))).toBe(1);
        expect(await measure(() => login(disabled.email, disabled.password))).toBe(1);
        expect(await measure(() => login(pending.email, 'incorrecta-ficticia'))).toBe(1);
      });

      it('7. MFA obligatorio no disponible: 403 explicito, ninguna sesion ni cookie, sin re-hash', async () => {
        const dir = await seedUser({ role: null });
        // direccion e admin_tecnico se conceden por acta (solo el propietario)
        await harness
          .owner(
            `insert into user_roles (user_id, role_id, domain, granted_by, grant_source)
           select $1, r.id, r.domain, $2, 'grant' from roles r where r.key = 'direccion'`,
            [dir.id, boss],
          )
          .catch(() => undefined); // si el trigger exige permiso, el propietario lo concede con acta
        await harness.owner(`select 1`);
        const has = await harness.owner(`select count(*)::int n from user_roles where user_id=$1`, [
          dir.id,
        ]);
        if (Number(has.rows[0]!.n) === 0) {
          await harness.owner(
            `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
             select $1, r.id, r.domain, null, 'recovery', 'ACTA-PRUEBA-REC' from roles r where r.key = 'direccion'`,
            [dir.id],
          );
        }
        const hashBefore = (
          await harness.owner(`select password_hash h from users where id=$1`, [dir.id])
        ).rows[0]!.h;
        const res = await login(dir.email, dir.password);
        expect(res.statusCode).toBe(403);
        expect(noRequestId(res).code).toBe('MFA_REQUIRED');
        expect(res.cookies).toEqual([]);
        expect(await activeSessions(dir.id)).toBe(0);
        const total = await harness.owner(`select count(*)::int n from sessions where user_id=$1`, [
          dir.id,
        ]);
        expect(Number(total.rows[0]!.n)).toBe(0);
        expect(
          (await harness.owner(`select password_hash h from users where id=$1`, [dir.id])).rows[0]!
            .h,
        ).toBe(hashBefore);
        // y una contrasena incorrecta de ese mismo usuario sigue siendo un 401 generico (el aviso exige la contrasena correcta)
        expect(noRequestId(await login(dir.email, 'incorrecta-ficticia')).code).toBe(
          'INVALID_CREDENTIALS',
        );
      });

      it('validacion: 400 para entradas invalidas, sin eco de la entrada; 415 para otros tipos de contenido', async () => {
        const bad: unknown[] = [
          {},
          { email: 'a@b.mx' },
          { password: 'x' },
          { email: 42, password: 'x' },
          { email: 'a@b.mx', password: '' },
          { email: 'a@b.mx', password: 'x'.repeat(1025) },
          { email: 'a'.repeat(300) + '@b.mx', password: 'x' },
          { email: 'a@b.mx', password: 'x', rol: 'direccion' },
        ];
        for (const payload of bad) {
          const res = await send(app, 'POST', '/auth/login', { payload });
          expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
          expect(noRequestId(res).code).toBe('VALIDATION_ERROR');
        }
        const marker = 'CONTRASENA-FICTICIA-EN-JSON-ROTO';
        secrets.add(marker);
        const broken = await send(app, 'POST', '/auth/login', {
          headers: { 'content-type': 'application/json' },
          payload: `{"email":"a@b.mx","password":"${marker}` as unknown as object,
        });
        expect(broken.statusCode).toBe(400);
        expect(broken.body).not.toContain(marker);
        const form = await send(app, 'POST', '/auth/login', {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'email=a@b.mx&password=x' as unknown as object,
        });
        expect(form.statusCode).toBe(415);
      });

      it('no crea cuentas automaticamente', async () => {
        const before = await harness.owner(`select count(*)::int n from users`);
        await login('nueva-cuenta@escuela.mx', 'cualquier-contrasena-ficticia');
        expect((await harness.owner(`select count(*)::int n from users`)).rows[0]!.n).toBe(
          before.rows[0]!.n,
        );
      });
    });

    // ------------------------------------------------------------------ cookies
    describe('cookie de sesion', () => {
      it('8, 10. HttpOnly, SameSite=Strict, Path=/, sin Domain; Expires = caducidad absoluta; sin Secure en desarrollo', async () => {
        clockNow = new Date();
        const u = await seedUser({});
        const res = await login(u.email, u.password);
        const c = res.cookies.find((x) => x.name === DEV_COOKIE_NAME)!;
        secrets.add(c.value);
        expect(c.httpOnly).toBe(true);
        expect(c.sameSite).toBe('Strict');
        expect(c.path).toBe('/');
        expect(c.domain).toBeUndefined();
        expect(c.secure).toBeFalsy();
        const abs = new Date((res.json() as { session: { expiresAt: string } }).session.expiresAt);
        expect(abs.getTime() - clockNow.getTime()).toBe(720 * MIN);
        expect(new Date(c.expires!).getTime()).toBe(Math.floor(abs.getTime() / 1000) * 1000);
      });

      it('9. en produccion: nombre __Host-, Secure, Path=/ y sin Domain', async () => {
        const u = await seedUser({});
        const res = await login(u.email, u.password, undefined, prodApp);
        const c = res.cookies.find((x) => x.name === PROD_COOKIE_NAME)!;
        secrets.add(c.value);
        expect(c.secure).toBe(true);
        expect(c.httpOnly).toBe(true);
        expect(c.sameSite).toBe('Strict');
        expect(c.path).toBe('/');
        expect(c.domain).toBeUndefined();
        expect(res.cookies.some((x) => x.name === DEV_COOKIE_NAME)).toBe(false);
        // la cookie de desarrollo NO sirve en produccion
        const devCookie = `${DEV_COOKIE_NAME}=${c.value}`;
        expect((await me(devCookie, prodApp)).statusCode).toBe(401);
        expect((await me(`${PROD_COOKIE_NAME}=${c.value}`, prodApp)).statusCode).toBe(200);
      });

      it('no acepta el token fuera de la cookie (cabecera Authorization, URL o cuerpo)', async () => {
        const u = await seedUser({});
        const { token } = await session(u);
        for (const opts of [
          { headers: { authorization: `Bearer ${token}` } },
          { headers: { 'x-session-token': token } },
        ] as Array<{ headers: Record<string, string> }>)
          expect((await send(app, 'GET', '/auth/me', opts)).statusCode).toBe(401);
        expect(
          (await send(app, 'GET', `/auth/me?token=${token}&${DEV_COOKIE_NAME}=${token}`))
            .statusCode,
        ).toBe(401);
        // Esta prueba pone el token en la URL a proposito (un cliente equivocado); Fastify registra la URL, asi que se
        // excluye de la comprobacion de logs: la API nunca pide ni emite tokens en URLs.
        secrets.delete(token);
      });
    });

    // ------------------------------------------------------------------ CORS, origen y CSRF
    describe('CORS, origen y CSRF', () => {
      it('11. CORS: origen permitido con credenciales; origen ajeno sin cabeceras CORS', async () => {
        const ok = await send(app, 'OPTIONS', '/auth/login', {
          origin: false,
          headers: {
            origin: ORIGIN,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,x-csrf-token',
          },
        });
        expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
        expect(ok.headers['access-control-allow-credentials']).toBe('true');
        const evil = await send(app, 'OPTIONS', '/auth/login', {
          origin: false,
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        });
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
        const get = await send(app, 'GET', '/auth/me', {
          origin: false,
          headers: { origin: 'https://evil.example' },
        });
        expect(get.headers['access-control-allow-origin']).toBeUndefined();
      });

      it('12. login CSRF: sin Origin, con Origin ajeno, "null" o Sec-Fetch-Site cross-site => 403 sin cookie ni intento', async () => {
        const u = await seedUser({});
        const before = calls.verify + calls.decoy;
        const attempts: Array<{ origin?: boolean; headers?: Record<string, string> }> = [
          { origin: false },
          { origin: false, headers: { origin: 'https://evil.example' } },
          { origin: false, headers: { origin: 'null' } },
          { origin: false, headers: { origin: 'http://localhost:5173' } }, // localhost != 127.0.0.1: no se confunden
          { headers: { 'sec-fetch-site': 'cross-site' } },
          { headers: { 'sec-fetch-site': 'none' } },
        ];
        for (const a of attempts) {
          const res = await send(app, 'POST', '/auth/login', {
            payload: { email: u.email, password: u.password },
            ...a,
          });
          expect(res.statusCode, JSON.stringify(a)).toBe(403);
          expect(noRequestId(res).code).toBe('FORBIDDEN_ORIGIN');
          expect(res.cookies).toEqual([]);
        }
        expect(calls.verify + calls.decoy).toBe(before); // ni siquiera se llego a verificar la contrasena
        expect(await activeSessions(u.id)).toBe(0);
        // same-site (subdominio) con Origin permitido si es aceptable
        const sameSite = await send(app, 'POST', '/auth/login', {
          payload: { email: u.email, password: u.password },
          headers: { 'sec-fetch-site': 'same-site' },
        });
        expect(sameSite.statusCode).toBe(200);
        secrets.add(sameSite.cookies[0]!.value);
      });

      it('13. logout sin CSRF o con CSRF invalido => 403 y la sesion sigue vigente', async () => {
        const u = await seedUser({});
        const other = await seedUser({});
        const s = await session(u);
        const so = await session(other);
        const otherCsrf = (
          (await send(app, 'GET', '/auth/csrf', { headers: { cookie: so.cookie } })).json() as {
            csrfToken: string;
          }
        ).csrfToken;
        for (const headers of [
          { cookie: s.cookie },
          { cookie: s.cookie, 'x-csrf-token': 'invalido' },
          { cookie: s.cookie, 'x-csrf-token': otherCsrf }, // CSRF de OTRA sesion
          { cookie: s.cookie, 'x-csrf-token': s.token }, // el propio token de sesion no es un CSRF valido
        ] as Array<Record<string, string>>) {
          const res = await send(app, 'POST', '/auth/logout', { headers });
          expect(res.statusCode).toBe(403);
          expect(noRequestId(res).code).toBe('CSRF_INVALID');
        }
        expect((await me(s.cookie)).statusCode).toBe(200);
        // la proteccion no depende solo del Origin: un Origin permitido sin CSRF tambien falla (arriba), y un CSRF sin Origin permitido tambien
        const csrf = (
          (await send(app, 'GET', '/auth/csrf', { headers: { cookie: s.cookie } })).json() as {
            csrfToken: string;
          }
        ).csrfToken;
        const noOrigin = await send(app, 'POST', '/auth/logout', {
          origin: false,
          headers: { cookie: s.cookie, 'x-csrf-token': csrf },
        });
        expect(noOrigin.statusCode).toBe(403);
        expect(noRequestId(noOrigin).code).toBe('FORBIDDEN_ORIGIN');
        expect((await me(s.cookie)).statusCode).toBe(200);
      });

      it('GET /auth/csrf: 401 sin sesion; con sesion devuelve un valor derivado que no es el token', async () => {
        expect((await send(app, 'GET', '/auth/csrf')).statusCode).toBe(401);
        const u = await seedUser({});
        const s = await session(u);
        const res = await send(app, 'GET', '/auth/csrf', { headers: { cookie: s.cookie } });
        expect(res.statusCode).toBe(200);
        const csrf = (res.json() as { csrfToken: string }).csrfToken;
        csrfValues.add(csrf);
        expect(csrf).not.toBe(s.token);
        expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.cookies).toEqual([]);
        // estable para la sesion y distinto entre sesiones
        const again = (
          (await send(app, 'GET', '/auth/csrf', { headers: { cookie: s.cookie } })).json() as {
            csrfToken: string;
          }
        ).csrfToken;
        expect(again).toBe(csrf);
        const s2 = await session(u);
        const other = (
          (await send(app, 'GET', '/auth/csrf', { headers: { cookie: s2.cookie } })).json() as {
            csrfToken: string;
          }
        ).csrfToken;
        expect(other).not.toBe(csrf);
      });

      it('cabeceras de seguridad (helmet) presentes', async () => {
        const res = await send(app, 'GET', '/auth/me');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBeDefined();
        expect(res.headers['x-powered-by']).toBeUndefined();
      });
    });

    // ------------------------------------------------------------------ limites de intentos
    describe('limites de intentos', () => {
      const limited = async (limits: Partial<AuthLimits>) => {
        const a = await build('test', limits);
        return a;
      };

      it('14. por IP: tras N fallos (de cualquier cuenta) la IP queda bloqueada, incluso con credenciales correctas, y antes de gastar Argon2id', async () => {
        const target = await limited({ ipFailures: 3, pairFailures: 99, identityFailures: 99 });
        const u = await seedUser({});
        for (let i = 0; i < 3; i++) {
          const r = await login(`nadie-${i}@escuela.mx`, 'incorrecta-ficticia', '10.9.9.9', target);
          expect(r.statusCode).toBe(401);
        }
        const before = calls.verify + calls.decoy;
        const blocked = await login(u.email, u.password, '10.9.9.9', target);
        expect(blocked.statusCode).toBe(429);
        expect(noRequestId(blocked).code).toBe('RATE_LIMITED');
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect(calls.verify + calls.decoy).toBe(before); // el bloqueo ocurre ANTES de Argon2id
        // otra IP no resulta afectada
        expect((await login(u.email, u.password, '10.9.9.10', target)).statusCode).toBe(200);
        await target.close();
      });

      it('15. por identidad: la pareja IP+correo se bloquea sin impedir que la persona legitima entre desde otra IP', async () => {
        const target = await limited({ ipFailures: 99, pairFailures: 3, identityFailures: 6 });
        const victim = await seedUser({});
        for (let i = 0; i < 3; i++)
          expect(
            (await login(victim.email, 'adivinando-ficticia', '10.1.1.1', target)).statusCode,
          ).toBe(401);
        expect(
          (await login(victim.email, 'adivinando-ficticia', '10.1.1.1', target)).statusCode,
        ).toBe(429);
        // el atacante bloqueado NO puede probar la contrasena correcta tampoco
        expect((await login(victim.email, victim.password, '10.1.1.1', target)).statusCode).toBe(
          429,
        );
        // la persona legitima, desde otra IP, entra
        const legit = await login(victim.email, victim.password, '10.2.2.2', target);
        expect(legit.statusCode).toBe(200);
        secrets.add(legit.cookies[0]!.value);
        // y un inicio correcto limpia SU pareja
        expect((await login(victim.email, victim.password, '10.2.2.2', target)).statusCode).toBe(
          200,
        );
        await target.close();
      });

      it('15b. limite global por correo (limitacion documentada): muchas IPs distintas pueden frenar la cuenta por la ventana', async () => {
        const target = await limited({ ipFailures: 99, pairFailures: 99, identityFailures: 4 });
        const victim = await seedUser({});
        for (let i = 0; i < 4; i++)
          await login(victim.email, 'x-ficticia', `10.3.3.${i + 1}`, target);
        const r = await login(victim.email, victim.password, '10.3.3.99', target);
        expect(r.statusCode).toBe(429);
        // otra cuenta no se ve afectada
        const other = await seedUser({});
        expect((await login(other.email, other.password, '10.3.3.99', target)).statusCode).toBe(
          200,
        );
        await target.close();
      });

      it('la ventana vence con el tiempo', async () => {
        let t = 1_000_000;
        const target = await limited({ pairFailures: 2, windowMs: 10 * MIN, now: () => t });
        const u = await seedUser({});
        await login(u.email, 'x-ficticia', '10.4.4.4', target);
        await login(u.email, 'x-ficticia', '10.4.4.4', target);
        expect((await login(u.email, u.password, '10.4.4.4', target)).statusCode).toBe(429);
        t += 11 * MIN;
        expect((await login(u.email, u.password, '10.4.4.4', target)).statusCode).toBe(200);
        await target.close();
      });

      it('inundacion por IP (plugin de rate-limit): 429 controlado', async () => {
        const target = await limited({ floodLogin: 3, floodOther: 2 });
        const codes: number[] = [];
        for (let i = 0; i < 5; i++)
          codes.push(
            (await login('inundacion@escuela.mx', 'x-ficticia', '10.5.5.5', target)).statusCode,
          );
        expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
        expect(codes.slice(3)).toEqual([429, 429]);
        const blocked = await login('inundacion@escuela.mx', 'x-ficticia', '10.5.5.5', target);
        expect(noRequestId(blocked)).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
        expect(blocked.headers['retry-after']).toBeDefined();
        for (let i = 0; i < 2; i++) await send(target, 'GET', '/auth/me', { ip: '10.5.5.6' });
        expect((await send(target, 'GET', '/auth/me', { ip: '10.5.5.6' })).statusCode).toBe(429);
        await target.close();
      });

      it('no se confia en X-Forwarded-For: no sirve para esquivar ni para trasladar el bloqueo', async () => {
        const target = await limited({ ipFailures: 2, pairFailures: 99, identityFailures: 99 });
        const u = await seedUser({});
        for (let i = 0; i < 2; i++)
          await send(target, 'POST', '/auth/login', {
            payload: { email: 'x@escuela.mx', password: 'x-ficticia' },
            ip: '10.6.6.6',
            headers: { 'x-forwarded-for': `203.0.113.${i}` },
          });
        const res = await send(target, 'POST', '/auth/login', {
          payload: { email: u.email, password: u.password },
          ip: '10.6.6.6',
          headers: { 'x-forwarded-for': '198.51.100.7' },
        });
        expect(res.statusCode).toBe(429);
        await target.close();
      });
    });

    // ------------------------------------------------------------------ sesiones
    describe('GET /auth/me y ciclo de vida de la sesion', () => {
      it('23. sin sesion: 401 (tambien con cookie basura, que ademas se limpia)', async () => {
        expect((await send(app, 'GET', '/auth/me')).statusCode).toBe(401);
        const junk = await me(`${DEV_COOKIE_NAME}=${'A'.repeat(43)}`);
        expect(junk.statusCode).toBe(401);
        expect(noRequestId(junk).code).toBe('UNAUTHENTICATED');
        expect(junk.cookies.find((c) => c.name === DEV_COOKIE_NAME)?.value).toBe('');
        expect((await me(`${DEV_COOKIE_NAME}=basura`)).statusCode).toBe(401);
      });

      it('16, 24, 25. sesion valida: identidad minima, roles y permisos; sin hashes ni secretos', async () => {
        clockNow = new Date();
        const u = await seedUser({ role: 'prefectura' });
        const s = await session(u);
        const res = await me(s.cookie);
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          user: Record<string, unknown>;
          roles: string[];
          permissions: Array<{ permission: string; scope: string }>;
          session: Record<string, unknown>;
        };
        expect(body.user).toEqual({ id: u.id, accountDomain: 'school', mustChangePassword: false });
        expect(body.roles).toEqual(['prefectura']);
        expect(body.permissions.length).toBeGreaterThan(0);
        expect(body.session.mfaVerified).toBe(false);
        const raw = res.body;
        for (const forbidden of ['password', 'hash', 'argon2', s.token, u.email, 'token_hash'])
          expect(raw).not.toContain(forbidden);
        expect(res.cookies).toEqual([]);
        expect(res.headers['cache-control']).toBe('no-store');
      });

      it('28. no escalamiento: una prefectura no recibe permisos de autoridad ni de otro dominio', async () => {
        const u = await seedUser({ role: 'prefectura' });
        const s = await session(u);
        const body = (await me(s.cookie)).json() as { permissions: Array<{ permission: string }> };
        const keys = body.permissions.map((p) => p.permission);
        expect(keys.some((k) => /^(users:manage|roles:)/.test(k))).toBe(false);
        expect(keys.some((k) => k.startsWith('technical') || k.startsWith('system'))).toBe(false);
        // el cuerpo del login no permite inyectar roles/dominio
        const inject = await send(app, 'POST', '/auth/login', {
          payload: { email: u.email, password: u.password, roles: ['direccion'] },
        });
        expect(inject.statusCode).toBe(400);
      });

      it('17. sesion expirada por inactividad y por tiempo absoluto: 401 y cookie limpiada', async () => {
        clockNow = new Date();
        const u = await seedUser({});
        const s = await session(u);
        clockNow = new Date(clockNow.getTime() + 59 * MIN);
        expect((await me(s.cookie)).statusCode).toBe(200); // renueva la inactividad
        clockNow = new Date(clockNow.getTime() + 59 * MIN);
        expect((await me(s.cookie)).statusCode).toBe(200);
        clockNow = new Date(clockNow.getTime() + 61 * MIN);
        const idle = await me(s.cookie);
        expect(idle.statusCode).toBe(401);
        expect(idle.cookies.find((c) => c.name === DEV_COOKIE_NAME)?.value).toBe('');
        // absoluta
        clockNow = new Date();
        const s2 = await session(u);
        for (let i = 0; i < 13; i++) {
          clockNow = new Date(clockNow.getTime() + 55 * MIN); // 55 min < 60 min de inactividad
          expect((await me(s2.cookie)).statusCode, `paso ${i}`).toBe(200); // hasta 715 min < 720 min
        }
        clockNow = new Date(clockNow.getTime() + 55 * MIN); // 770 min > 12 h absolutas
        expect((await me(s2.cookie)).statusCode).toBe(401);
        clockNow = new Date();
      });

      it('18. sesion revocada: 401', async () => {
        const u = await seedUser({});
        const s = await session(u);
        await harness.owner(
          `update sessions set revoked_at = now(), revoked_reason = 'admin' where user_id = $1 and revoked_at is null`,
          [u.id],
        );
        expect((await me(s.cookie)).statusCode).toBe(401);
      });

      it('19. cambio de contrasena: invalida las sesiones; la nueva contrasena entra y la vieja no', async () => {
        const u = await seedUser({});
        const s = await session(u);
        const newPassword = 'Otra-clave-ficticia-2 ##';
        secrets.add(newPassword);
        await harness.owner(
          `update users set password_hash = $2, password_changed_at = now() where id = $1`,
          [u.id, await seedHasher.hash(newPassword)],
        );
        expect((await me(s.cookie)).statusCode).toBe(401);
        expect((await login(u.email, u.password)).statusCode).toBe(401);
        const fresh = await login(u.email, newPassword);
        expect(fresh.statusCode).toBe(200);
        secrets.add(fresh.cookies[0]!.value);
      });

      it('20. revocacion de rol: la sesion deja de valer y no se puede abrir otra sin roles', async () => {
        const u = await seedUser({});
        const s = await session(u);
        await harness.owner(
          `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
          [u.id, boss],
        );
        expect((await me(s.cookie)).statusCode).toBe(401);
        expect(noRequestId(await login(u.email, u.password)).code).toBe('INVALID_CREDENTIALS');
      });

      it('cuenta deshabilitada o bloqueada despues del login: 401 inmediato', async () => {
        const a = await seedUser({});
        const b = await seedUser({});
        const sa = await session(a);
        const sb = await session(b);
        await harness.owner(`update users set status='disabled' where id=$1`, [a.id]);
        await harness.owner(
          `update users set locked_until = now() + interval '1 hour' where id=$1`,
          [b.id],
        );
        expect((await me(sa.cookie)).statusCode).toBe(401);
        expect((await me(sb.cookie)).statusCode).toBe(401);
      });

      it('cambio de contrasena obligatorio: la sesion se emite y lo indica (las rutas protegidas lo exigiran)', async () => {
        const u = await seedUser({ mustChange: true });
        const res = await login(u.email, u.password);
        expect((res.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
        secrets.add(res.cookies[0]!.value);
        const body = (await me(`${DEV_COOKIE_NAME}=${res.cookies[0]!.value}`)).json() as {
          user: { mustChangePassword: boolean };
        };
        expect(body.user.mustChangePassword).toBe(true);
      });
    });

    // ------------------------------------------------------------------ logout
    describe('POST /auth/logout', () => {
      it('21, 22. revoca la sesion actual, limpia la cookie y el logout repetido es seguro (401 sin efectos)', async () => {
        const u = await seedUser({});
        const keep = await session(u); // otra sesion del mismo usuario NO se toca
        const s = await session(u);
        const csrf = (
          (await send(app, 'GET', '/auth/csrf', { headers: { cookie: s.cookie } })).json() as {
            csrfToken: string;
          }
        ).csrfToken;
        const out = await send(app, 'POST', '/auth/logout', {
          headers: { cookie: s.cookie, 'x-csrf-token': csrf },
        });
        expect(out.statusCode).toBe(204);
        expect(out.body).toBe('');
        expect(out.cookies.find((c) => c.name === DEV_COOKIE_NAME)?.value).toBe('');
        expect((await me(s.cookie)).statusCode).toBe(401);
        expect((await me(keep.cookie)).statusCode).toBe(200);
        const reason = await harness.owner(
          `select revoked_reason r from sessions where token_hash = sha256(decode($1,'base64'))`,
          [Buffer.from(s.token, 'base64url').toString('base64')],
        );
        expect(reason.rows[0]!.r).toBe('logout');
        // repetido
        const again = await send(app, 'POST', '/auth/logout', {
          headers: { cookie: s.cookie, 'x-csrf-token': csrf },
        });
        expect(again.statusCode).toBe(401);
        expect((await me(keep.cookie)).statusCode).toBe(200);
      });

      it('no cambia estado con GET', async () => {
        const u = await seedUser({});
        const s = await session(u);
        expect(
          (await send(app, 'GET', '/auth/logout', { headers: { cookie: s.cookie } })).statusCode,
        ).toBe(404);
        expect((await me(s.cookie)).statusCode).toBe(200);
      });
    });

    // ------------------------------------------------------------------ rehash y concurrencia
    describe('rehash y concurrencia', () => {
      it('29. rehash coherente: la contrasena se actualiza al entrar, la sesion nueva queda vigente y las anteriores se revocan', async () => {
        const u = await seedUser({ hasher: oldHasher });
        const before = parsePasswordHash(
          (await harness.owner(`select password_hash h from users where id=$1`, [u.id])).rows[0]!
            .h as string,
        ).params;
        expect(before.memoryKiB).toBe(OLD_PARAMS.memoryKiB);
        // sesion previa (otro navegador) abierta con la contrasena antigua directamente en la base
        await harness.owner(
          `insert into sessions (user_id, token_hash, expires_at, idle_expires_at)
           values ($1, sha256('previa'::bytea), now() + interval '8 hours', now() + interval '1 hour')`,
          [u.id],
        );
        const res = await login(u.email, u.password);
        expect(res.statusCode).toBe(200);
        const s = { cookie: `${DEV_COOKIE_NAME}=${res.cookies[0]!.value}` };
        secrets.add(res.cookies[0]!.value);
        const after = (
          await harness.owner(
            `select password_hash h, password_changed_at c from users where id=$1`,
            [u.id],
          )
        ).rows[0]!;
        expect(parsePasswordHash(after.h as string).params.memoryKiB).toBe(APP_PARAMS.memoryKiB);
        expect(after.c).toBeNull(); // no es un cambio de contrasena
        expect((await me(s.cookie)).statusCode).toBe(200); // la sesion nueva NO se invalido
        expect(await activeSessions(u.id)).toBe(1); // la previa si (revocada por el trigger al cambiar el hash)
        // y la contrasena sigue siendo la misma
        expect((await login(u.email, u.password)).statusCode).toBe(200);
      });

      it('29b. si la contrasena cambia mientras se re-hashea, el login falla y no queda sesion ni hash pisado', async () => {
        const u = await seedUser({ hasher: oldHasher });
        const concurrent = await seedHasher.hash('cambio-concurrente-ficticio');
        hook.onHash = async (p) => {
          await harness.owner(
            `update users set password_hash = $2, password_changed_at = now() where id = $1`,
            [u.id, concurrent],
          );
          return real.hash(p);
        };
        try {
          const res = await login(u.email, u.password);
          expect(res.statusCode).toBe(401);
        } finally {
          hook.onHash = undefined;
        }
        expect(
          (await harness.owner(`select password_hash h from users where id=$1`, [u.id])).rows[0]!.h,
        ).toBe(concurrent);
        expect(await activeSessions(u.id)).toBe(0);
      });

      it('30. concurrencia de sesiones: 7 inicios secuenciales dejan 5 vigentes; los 2 mas antiguos dejan de valer', async () => {
        clockNow = new Date();
        const u = await seedUser({});
        const sessions: Array<{ cookie: string }> = [];
        for (let i = 0; i < 7; i++) sessions.push(await session(u));
        expect(await activeSessions(u.id)).toBe(5);
        expect((await me(sessions[0]!.cookie)).statusCode).toBe(401);
        expect((await me(sessions[1]!.cookie)).statusCode).toBe(401);
        for (const s of sessions.slice(2)) expect((await me(s.cookie)).statusCode).toBe(200);
      });

      it('30b. 10 inicios de sesion SIMULTANEOS del mismo usuario: todos 200 y exactamente 5 vigentes', async () => {
        const u = await seedUser({});
        const results = await Promise.all(
          Array.from({ length: 10 }, () => login(u.email, u.password)),
        );
        expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
        for (const r of results) secrets.add(r.cookies[0]!.value);
        expect(await activeSessions(u.id)).toBe(5);
        const valid = await Promise.all(
          results.map((r) => me(`${DEV_COOKIE_NAME}=${r.cookies[0]!.value}`)),
        );
        expect(valid.filter((r) => r.statusCode === 200)).toHaveLength(5);
      });
    });

    // ------------------------------------------------------------------ secretos
    describe('ausencia de secretos', () => {
      it('25. ninguna respuesta (cuerpo ni cabeceras salvo Set-Cookie) contiene contrasenas, tokens, hashes ni CSRF', () => {
        expect(transcript.length).toBeGreaterThan(20);
        const blob = transcript.join('\n');
        for (const secret of secrets)
          if (secret)
            expect(blob.includes(secret), `fuga de un secreto de ${secret.length} caracteres`).toBe(
              false,
            );
        expect(blob).not.toContain('$argon2id');
        expect(blob).not.toMatch(/password_hash|token_hash/);
      });

      it('26. los logs no contienen contrasenas, tokens, cookies, valores CSRF ni hashes', () => {
        expect(logs.length).toBeGreaterThan(20);
        const blob = logs.join('');
        for (const secret of secrets)
          if (secret)
            expect(
              blob.includes(secret),
              `fuga en logs de un secreto de ${secret.length} caracteres`,
            ).toBe(false);
        for (const value of csrfValues)
          expect(blob.includes(value), 'valor CSRF en logs').toBe(false);
        expect(blob).not.toContain('$argon2id');
        expect(blob).not.toMatch(/set-cookie|"cookie"|x-csrf-token/i);
      });
    });
  });
}
