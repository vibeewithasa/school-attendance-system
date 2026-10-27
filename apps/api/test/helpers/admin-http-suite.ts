import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import type { AuthLimits } from '../../src/modules/auth/auth.module.js';
import { DEV_COOKIE_NAME } from '../../src/modules/auth/guards.js';
import { createPasswordService } from '../../src/modules/auth/password.js';
import type { Harness } from './auth-http-suite.js';
import { ORIGIN } from './auth-http-suite.js';

/**
 * Suite HTTP de /admin/users y /admin/roles (fastify `inject`) sobre PostgreSQL real (PGlite o clúster desechable) con un
 * rol de ejecucion NO propietario. Modo MFA diferido (el unico que permite iniciar sesion con direccion/admin_tecnico).
 * Cuentas, correos y contrasenas son FICTICIOS.
 */
const GENEROUS: Partial<AuthLimits> = {
  ipFailures: 10_000,
  pairFailures: 10_000,
  identityFailures: 10_000,
  floodLogin: 100_000,
  floodOther: 100_000,
  activationRequestIp: 100_000,
  activationRequestAccount: 100_000,
  activationCompleteFailures: 100_000,
};
const PARAMS = { memoryKiB: 20 * 1024, passes: 2, parallelism: 1, tagLength: 32 };

type Res = LightMyRequestResponse;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (r: Res) => r.json() as Json;

export interface AdminSuiteExtras {
  /** Solo se ejecutan las pruebas adicionales (extra); las de /admin se omiten. */
  onlyExtra?: boolean;
  /** Pruebas adicionales que se ejecutan con la misma app y utilidades (p. ej. concurrencia real). */
  extra?: (kit: AdminKit) => void;
}

export interface AdminKit {
  harness: Harness;
  app: () => FastifyInstance;
  build: (
    limits?: Partial<AuthLimits>,
    extra?: { schoolToday?: () => string },
  ) => Promise<FastifyInstance>;
  seed: (opts: Seed) => Promise<Account>;
  login: (account: Account, target?: FastifyInstance) => Promise<Login>;
  call: (
    login: Login | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts?: { body?: unknown; csrf?: boolean | string; origin?: boolean; target?: FastifyInstance },
  ) => Promise<Res>;
  boss: Account;
  techBoss: Account;
  /** Lineas de log de TODAS las apps construidas por la suite y valores secretos ficticios generados (para buscar fugas). */
  logs: string[];
  secrets: Set<string>;
}

interface Seed {
  role?: string | null;
  domain?: 'school' | 'technical';
  status?: 'active' | 'pending';
}
export interface Account {
  id: string;
  email: string;
  password: string;
}
export interface Login {
  cookie: string;
  csrf: string;
  account: Account;
}

export function defineAdminHttpSuite(
  label: string,
  setup: () => Promise<{ harness: Harness; teardown: () => Promise<void> }>,
  extras: AdminSuiteExtras = {},
): void {
  // `onlyExtra`: el montaje de cuentas se reutiliza, pero las pruebas de /admin no se registran (ni siquiera como omitidas).
  const sub = (extras.onlyExtra ? () => undefined : describe) as typeof describe;
  describe(`HTTP /admin (${label})`, () => {
    let harness: Harness;
    let teardown: () => Promise<void>;
    let app: FastifyInstance;
    let boss: Account;
    let techBoss: Account;
    let seq = 0;
    const passwords = createPasswordService({ params: PARAMS });
    const logs: string[] = [];
    const secrets = new Set<string>();

    const build = (limits: Partial<AuthLimits> = {}, extra: { schoolToday?: () => string } = {}) =>
      buildApp(
        loadEnv({
          NODE_ENV: 'test',
          CORS_ORIGIN: ORIGIN,
          LOG_LEVEL: 'info',
          HOST: '127.0.0.1',
          AUTH_MFA_ENFORCEMENT: 'deferred',
        }),
        {
          auth: {
            store: harness.store,
            passwords,
            limits: { ...GENEROUS, ...limits },
            ...(extra.schoolToday ? { schoolToday: extra.schoolToday } : {}),
          },
          logStream: { write: (c: string) => void logs.push(c) },
        },
      );

    async function seed(opts: Seed = {}): Promise<Account> {
      const email = `persona-${++seq}@escuela.mx`;
      const password = `Clave-ficticia-${seq}-#Admin`;
      secrets.add(password);
      const domain = opts.domain ?? 'school';
      const status = opts.status ?? 'active';
      const r = await harness.owner(
        `insert into users (email, display_name, account_domain, status, password_hash)
         values ($1, 'Persona de prueba', $2, $3, $4) returning id`,
        [email, domain, status, status === 'pending' ? null : await passwords.hash(password)],
      );
      const id = r.rows[0]!.id as string;
      if (opts.role !== null) {
        const grantor = domain === 'technical' ? techBoss : boss;
        await harness.owner(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source)
           select $1, r.id, r.domain, $3, 'grant' from roles r where r.key = $2`,
          [id, opts.role ?? 'prefectura', grantor.id],
        );
      }
      return { id, email, password };
    }

    async function login(account: Account, target: FastifyInstance = app): Promise<Login> {
      const res = await target.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        payload: { email: account.email, password: account.password },
      });
      expect(res.statusCode, 'login esperado').toBe(200);
      const value = res.cookies.find((c) => c.name === DEV_COOKIE_NAME)!.value;
      secrets.add(value);
      const cookie = `${DEV_COOKIE_NAME}=${value}`;
      const csrf = (
        await target.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })
      ).json().csrfToken as string;
      return { cookie, csrf, account };
    }

    async function call(
      who: Login | null,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      opts: {
        body?: unknown;
        csrf?: boolean | string;
        origin?: boolean;
        target?: FastifyInstance;
      } = {},
    ): Promise<Res> {
      const headers: Record<string, string> = {};
      if (opts.origin !== false) {
        headers.origin = ORIGIN;
        headers['sec-fetch-site'] = 'same-origin';
      }
      if (who) headers.cookie = who.cookie;
      if (who && method !== 'GET' && opts.csrf !== false) {
        headers['x-csrf-token'] = typeof opts.csrf === 'string' ? opts.csrf : who.csrf;
      }
      return (opts.target ?? app).inject({
        method,
        url,
        headers,
        ...(opts.body === undefined ? {} : { payload: opts.body as object }),
      });
    }

    const auditCount = async (type: string, subject: string, outcome?: string) =>
      Number(
        (
          await harness.owner(
            `select count(*)::int n from audit_events where event_type = $1 and subject_user_id = $2
               and ($3::text is null or outcome = $3)`,
            [type, subject, outcome ?? null],
          )
        ).rows[0]!.n,
      );
    const activeSessions = async (id: string) =>
      Number(
        (
          await harness.owner(
            `select count(*)::int n from sessions where user_id = $1 and revoked_at is null`,
            [id],
          )
        ).rows[0]!.n,
      );
    const newAccount = (login: Login, over: Json = {}) =>
      call(login, 'POST', '/admin/users', {
        body: {
          email: `Nueva.${++seq}@Escuela.MX `,
          displayName: 'Cuenta pendiente de prueba',
          accountDomain: 'school',
          ...over,
        },
      });

    beforeAll(async () => {
      ({ harness, teardown } = await setup());
      const hash = await passwords.hash('titular-ficticio-0-#Admin');
      const mk = async (
        email: string,
        domain: string,
        role: string,
        ref: string,
      ): Promise<Account> => {
        const r = await harness.owner(
          `insert into users (email, display_name, account_domain, status, password_hash)
           values ($1, 'Titular', $2, 'active', $3) returning id`,
          [email, domain, hash],
        );
        const id = r.rows[0]!.id as string;
        await harness.owner(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
           select $1, r.id, r.domain, null, 'bootstrap', $3 from roles r where r.key = $2`,
          [id, role, ref],
        );
        return { id, email, password: 'titular-ficticio-0-#Admin' };
      };
      secrets.add('titular-ficticio-0-#Admin');
      boss = await mk('direccion@escuela.mx', 'school', 'direccion', 'ACTA-PRUEBA-ESC');
      techBoss = await mk('tecnico@escuela.mx', 'technical', 'admin_tecnico', 'ACTA-PRUEBA-TEC');
      app = await build();
    }, 240_000);
    afterAll(async () => {
      await app?.close();
      await teardown?.();
    });

    // ----------------------------------------------------------------------------------------------- acceso
    sub('acceso', () => {
      it('sin sesion: 401 en todas las rutas administrativas', async () => {
        const id = '00000000-0000-4000-8000-000000000001';
        for (const [m, u] of [
          ['GET', '/admin/users'],
          ['GET', `/admin/users/${id}`],
          ['POST', '/admin/users'],
          ['POST', `/admin/users/${id}/disable`],
          ['GET', '/admin/roles'],
          ['POST', `/admin/users/${id}/roles`],
          ['DELETE', `/admin/users/${id}/roles/prefectura`],
        ] as const) {
          const res = await call(null, m, u, { body: m === 'POST' ? {} : undefined });
          expect(res.statusCode, `${m} ${u}`).toBe(401);
        }
      });

      it('una prefectura (sin permisos de autoridad) recibe 403 y las denegaciones quedan auditadas', async () => {
        const pref = await seed({ role: 'prefectura' });
        const me = await login(pref);
        const target = await seed({ role: 'trabajo_social' });
        expect((await call(me, 'GET', '/admin/users')).statusCode).toBe(403);
        expect((await call(me, 'GET', '/admin/roles')).statusCode).toBe(403);
        expect((await newAccount(me)).statusCode).toBe(403);
        expect((await call(me, 'GET', `/admin/users/${target.id}`)).statusCode).toBe(404);
        const assign = await call(me, 'POST', `/admin/users/${target.id}/roles`, {
          body: { roleKey: 'prefectura' },
        });
        expect(assign.statusCode).toBe(404); // fuera de su alcance: indistinguible de inexistente
        expect(
          Number(
            (
              await harness.owner(
                `select count(*)::int n from audit_events where event_type = 'authz.denied' and actor_user_id = $1 and outcome = 'denied'`,
                [pref.id],
              )
            ).rows[0]!.n,
          ),
        ).toBeGreaterThanOrEqual(3);
      });

      it('mutaciones sin CSRF o sin Origin permitido: 403 y no cambian nada', async () => {
        const me = await login(boss);
        const body = { email: 'csrf@escuela.mx', displayName: 'X', accountDomain: 'school' };
        const noCsrf = await call(me, 'POST', '/admin/users', { body, csrf: false });
        expect(noCsrf.statusCode).toBe(403);
        expect(json(noCsrf).error.code).toBe('CSRF_INVALID');
        expect(
          (await call(me, 'POST', '/admin/users', { body, csrf: 'invalido' })).statusCode,
        ).toBe(403);
        const noOrigin = await call(me, 'POST', '/admin/users', { body, origin: false });
        expect(json(noOrigin).error.code).toBe('FORBIDDEN_ORIGIN');
        const exists = await harness.owner(
          `select count(*)::int n from users where email = 'csrf@escuela.mx'`,
        );
        expect(Number(exists.rows[0]!.n)).toBe(0);
        const target = await seed({ role: 'prefectura' });
        for (const [m, u] of [
          ['POST', `/admin/users/${target.id}/disable`],
          ['POST', `/admin/users/${target.id}/roles`],
          ['DELETE', `/admin/users/${target.id}/roles/prefectura`],
        ] as const) {
          expect(
            (
              await call(me, m, u, {
                body: m === 'POST' ? { roleKey: 'trabajo_social' } : undefined,
                csrf: false,
              })
            ).statusCode,
          ).toBe(403);
        }
        expect((await call(me, 'GET', `/admin/users/${target.id}`)).statusCode).toBe(200); // sigue activa
      });

      it('las respuestas administrativas no se almacenan en cache', async () => {
        const me = await login(boss);
        expect((await call(me, 'GET', '/admin/roles')).headers['cache-control']).toBe('no-store');
      });
    });

    // ----------------------------------------------------------------------------------------------- cuentas
    sub('crear y consultar cuentas', () => {
      it('direccion crea una cuenta PENDIENTE sin contrasena; el actor es la sesion; se audita; sin datos sensibles', async () => {
        const me = await login(boss);
        const res = await newAccount(me);
        expect(res.statusCode).toBe(201);
        const user = json(res);
        expect(Object.keys(user).sort()).toEqual(
          [
            'accountDomain',
            'activation',
            'createdAt',
            'displayName',
            'email',
            'emailKind',
            'id',
            'lastLoginAt',
            'locked',
            'roles',
            'status',
          ].sort(),
        );
        expect(user).toMatchObject({
          status: 'pending',
          accountDomain: 'school',
          roles: [],
          activation: null,
          locked: false,
        });
        expect(user.email).toMatch(/^nueva\.\d+@escuela\.mx$/); // normalizado
        expect(res.headers.location).toBe(`/admin/users/${user.id}`);
        const row = (
          await harness.owner(`select created_by, status, password_hash from users where id = $1`, [
            user.id,
          ])
        ).rows[0]!;
        expect(row).toEqual({ created_by: boss.id, status: 'pending', password_hash: null });
        expect(await auditCount('user.created', user.id, 'success')).toBe(1);
        expect(res.body).not.toMatch(/password|hash|token/i);
        // la cuenta pendiente no puede iniciar sesion (aun sin activar)
        const attempt = await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { origin: ORIGIN },
          payload: { email: user.email, password: 'cualquier-contrasena-ficticia' },
        });
        expect(attempt.statusCode).toBe(401);
      });

      it('rechaza correo duplicado (409), cuerpos con campos extra o inventados (400) y cuentas de otro dominio (403)', async () => {
        const me = await login(boss);
        const first = json(await newAccount(me));
        const dup = await newAccount(me, { email: first.email.toUpperCase() });
        expect(dup.statusCode).toBe(409);
        expect(json(dup).error.code).toBe('CONFLICT');
        for (const extra of [
          { password: 'impuesta-por-admin' },
          { status: 'active' },
          { createdBy: techBoss.id },
          { roles: ['direccion'] },
          { passwordHash: 'x' },
        ]) {
          const res = await newAccount(me, extra);
          expect(res.statusCode, JSON.stringify(extra)).toBe(400);
          expect(res.body).not.toContain('impuesta-por-admin');
        }
        for (const bad of [
          { email: 'no-es-correo' },
          { displayName: '' },
          { displayName: 'x'.repeat(121) },
          { accountDomain: 'otro' },
          { emailKind: 'x' },
        ]) {
          expect((await newAccount(me, bad)).statusCode, JSON.stringify(bad)).toBe(400);
        }
        // direccion no crea cuentas tecnicas
        expect((await newAccount(me, { accountDomain: 'technical' })).statusCode).toBe(403);
      });

      it('admin_tecnico administra solo cuentas tecnicas', async () => {
        const tech = await login(techBoss);
        const ok = await newAccount(tech, { accountDomain: 'technical' });
        expect(ok.statusCode).toBe(201);
        expect((await newAccount(tech, { accountDomain: 'school' })).statusCode).toBe(403);
        const schoolUser = await seed({ role: 'prefectura' });
        expect((await call(tech, 'GET', `/admin/users/${schoolUser.id}`)).statusCode).toBe(404);
        const list = json(await call(tech, 'GET', '/admin/users?pageSize=100'));
        expect(list.items.every((u: Json) => u.accountDomain === 'technical')).toBe(true);
        expect(list.items.some((u: Json) => u.id === schoolUser.id)).toBe(false);
      });

      it('listado: paginacion, filtros y validacion; busqueda con comodines escapados', async () => {
        const me = await login(boss);
        const tag = `zz${++seq}`;
        for (let i = 0; i < 25; i++) {
          await newAccount(me, {
            email: `${tag}.${String(i).padStart(2, '0')}@escuela.mx`,
            displayName: `Prueba ${tag} ${i}`,
          });
        }
        const p1 = json(await call(me, 'GET', `/admin/users?q=${tag}&pageSize=10&page=1`));
        const p3 = json(await call(me, 'GET', `/admin/users?q=${tag}&pageSize=10&page=3`));
        expect(p1).toMatchObject({ page: 1, pageSize: 10, total: 25 });
        expect(p1.items).toHaveLength(10);
        expect(p3.items).toHaveLength(5);
        const ids = new Set([...p1.items, ...p3.items].map((u: Json) => u.id));
        expect(ids.size).toBe(15); // sin repetidos entre paginas
        expect(json(await call(me, 'GET', `/admin/users?q=${tag}&status=pending`)).total).toBe(25);
        expect(json(await call(me, 'GET', `/admin/users?q=${tag}&status=active`)).total).toBe(0);
        expect(
          json(await call(me, 'GET', `/admin/users?role=direccion`)).items.some(
            (u: Json) => u.id === boss.id,
          ),
        ).toBe(true);
        expect(json(await call(me, 'GET', `/admin/users?q=%25%25`)).total).toBe(0); // "%%" literal, no comodin
        expect(json(await call(me, 'GET', `/admin/users?q=${tag}&domain=technical`)).total).toBe(0);
        for (const bad of [
          'pageSize=1000',
          'page=0',
          'status=raro',
          'domain=x',
          'q=a',
          'role=Mal%20Rol',
          'orden=asc',
          'page=abc',
        ]) {
          expect((await call(me, 'GET', `/admin/users?${bad}`)).statusCode, bad).toBe(400);
        }
        expect((await call(me, 'GET', '/admin/users/no-es-uuid')).statusCode).toBe(400);
        expect(
          (await call(me, 'GET', '/admin/users/00000000-0000-4000-8000-000000000009')).statusCode,
        ).toBe(404);
      });

      it('roles disponibles: cada autoridad ve solo los roles de su dominio', async () => {
        const school = json(await call(await login(boss), 'GET', '/admin/roles')) as Json[];
        expect(school.map((r) => r.key).sort()).toEqual([
          'control_acceso',
          'direccion',
          'prefectura',
          'trabajo_social',
        ]);
        expect(school.every((r) => r.domain === 'school')).toBe(true);
        const tech = json(await call(await login(techBoss), 'GET', '/admin/roles')) as Json[];
        expect(tech.map((r) => r.key)).toEqual(['admin_tecnico']);
        expect(Object.keys(school[0]!).sort()).toEqual([
          'description',
          'domain',
          'key',
          'name',
          'requiresMfa',
        ]);
      });
    });

    // ----------------------------------------------------------------------------------------------- roles
    sub('asignar y revocar roles', () => {
      it('asignacion valida: la concede el actor de la sesion, queda auditada y se refleja en la cuenta', async () => {
        const me = await login(boss);
        const acct = json(await newAccount(me));
        const res = await call(me, 'POST', `/admin/users/${acct.id}/roles`, {
          body: { roleKey: 'prefectura' },
        });
        expect(res.statusCode).toBe(201);
        expect(json(res).roles.map((r: Json) => r.key)).toEqual(['prefectura']);
        const row = (
          await harness.owner(
            `select granted_by, grant_source, grant_reference from user_roles where user_id = $1`,
            [acct.id],
          )
        ).rows[0]!;
        expect(row).toEqual({ granted_by: boss.id, grant_source: 'grant', grant_reference: null });
        expect(await auditCount('role.granted', acct.id, 'success')).toBe(1);
        const dup = await call(me, 'POST', `/admin/users/${acct.id}/roles`, {
          body: { roleKey: 'prefectura' },
        });
        expect(dup.statusCode).toBe(409);
      });

      it('rechaza rol inexistente (404), cuerpos con actor o campos extra (400) y cuentas deshabilitadas (403)', async () => {
        const me = await login(boss);
        const target = await seed({ role: 'prefectura' });
        expect(
          (
            await call(me, 'POST', `/admin/users/${target.id}/roles`, {
              body: { roleKey: 'no_existe' },
            })
          ).statusCode,
        ).toBe(404);
        for (const body of [
          { roleKey: 'control_acceso', grantedBy: techBoss.id },
          { roleKey: 'control_acceso', userId: boss.id },
          {},
          { roleKey: 5 },
          { roleKey: 'Mal Rol' },
        ]) {
          expect(
            (await call(me, 'POST', `/admin/users/${target.id}/roles`, { body })).statusCode,
            JSON.stringify(body),
          ).toBe(400);
        }
        const off = await seed({ role: 'prefectura' });
        expect((await call(me, 'POST', `/admin/users/${off.id}/disable`)).statusCode).toBe(200);
        expect(
          (
            await call(me, 'POST', `/admin/users/${off.id}/roles`, {
              body: { roleKey: 'control_acceso' },
            })
          ).statusCode,
        ).toBe(403);
      });

      it('10. autoasignacion rechazada: nadie se concede roles a si mismo (ni siquiera direccion)', async () => {
        const me = await login(boss);
        const self = await call(me, 'POST', `/admin/users/${boss.id}/roles`, {
          body: { roleKey: 'trabajo_social' },
        });
        expect(self.statusCode).toBe(403);
        const pref = await seed({ role: 'prefectura' });
        const prefSession = await login(pref);
        expect(
          (
            await call(prefSession, 'POST', `/admin/users/${pref.id}/roles`, {
              body: { roleKey: 'direccion' },
            })
          ).statusCode,
        ).toBe(404);
        const roles = await harness.owner(
          `select count(*)::int n from user_roles where user_id = $1 and revoked_at is null`,
          [pref.id],
        );
        expect(Number(roles.rows[0]!.n)).toBe(1);
        expect(await auditCount('authz.denied', boss.id, 'denied')).toBeGreaterThanOrEqual(1);
      });

      it('9. escalamiento de dominios rechazado en ambos sentidos', async () => {
        const dir = await login(boss);
        const tech = await login(techBoss);
        const schoolUser = await seed({ role: 'prefectura' });
        const techUser = await seed({ domain: 'technical', role: 'admin_tecnico' });
        // direccion no concede roles tecnicos ni ve cuentas tecnicas
        expect(
          (
            await call(dir, 'POST', `/admin/users/${techUser.id}/roles`, {
              body: { roleKey: 'admin_tecnico' },
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await call(dir, 'POST', `/admin/users/${schoolUser.id}/roles`, {
              body: { roleKey: 'admin_tecnico' },
            })
          ).statusCode,
        ).toBe(403);
        // admin_tecnico no concede roles escolares ni ve cuentas escolares
        expect(
          (
            await call(tech, 'POST', `/admin/users/${schoolUser.id}/roles`, {
              body: { roleKey: 'direccion' },
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await call(tech, 'POST', `/admin/users/${techUser.id}/roles`, {
              body: { roleKey: 'direccion' },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (await call(tech, 'DELETE', `/admin/users/${schoolUser.id}/roles/prefectura`)).statusCode,
        ).toBe(404);
        // nada cambio
        const n = await harness.owner(
          `select count(*)::int n from user_roles where user_id in ($1, $2) and revoked_at is null`,
          [schoolUser.id, techUser.id],
        );
        expect(Number(n.rows[0]!.n)).toBe(2);
      });

      it('revocar: queda registrado, revoca las sesiones de la cuenta y la repeticion da 404', async () => {
        const me = await login(boss);
        const target = await seed({ role: 'prefectura' });
        const targetSession = await login(target);
        expect((await call(targetSession, 'GET', '/auth/me')).statusCode).toBe(200);
        const res = await call(me, 'DELETE', `/admin/users/${target.id}/roles/prefectura`);
        expect(res.statusCode).toBe(200);
        expect(json(res).roles).toEqual([]);
        const row = (
          await harness.owner(
            `select revoked_by from user_roles where user_id = $1 and revoked_at is not null`,
            [target.id],
          )
        ).rows[0]!;
        expect(row.revoked_by).toBe(boss.id);
        expect(await auditCount('role.revoked', target.id, 'success')).toBe(1);
        expect((await call(targetSession, 'GET', '/auth/me')).statusCode).toBe(401);
        expect(await activeSessions(target.id)).toBe(0);
        expect(
          (await call(me, 'DELETE', `/admin/users/${target.id}/roles/prefectura`)).statusCode,
        ).toBe(404);
      });

      it('cambio de roles con sesion activa: la sesion de quien administra se invalida al perder la autoridad', async () => {
        const admin = await seed({ role: 'direccion' });
        const adminSession = await login(admin);
        expect((await call(adminSession, 'GET', '/admin/users')).statusCode).toBe(200);
        const me = await login(boss);
        expect(
          (await call(me, 'DELETE', `/admin/users/${admin.id}/roles/direccion`)).statusCode,
        ).toBe(200);
        expect((await call(adminSession, 'GET', '/admin/users')).statusCode).toBe(401);
      });

      it('nunca se deja un dominio sin titular con autoridad (revocar o deshabilitar al ultimo => 409)', async () => {
        const me = await login(boss);
        // boss es el unico titular escolar
        const only = await call(me, 'DELETE', `/admin/users/${boss.id}/roles/direccion`);
        expect(only.statusCode).toBe(409);
        expect(json(only).error.code).toBe('LAST_AUTHORITY');
        expect((await call(me, 'POST', `/admin/users/${boss.id}/disable`)).statusCode).toBe(403); // nadie se deshabilita a si mismo
        // con un segundo titular, ese puede renunciar mientras quede otro; el ultimo no
        const second = await seed({ role: 'direccion' });
        const secondSession = await login(second);
        const renounce = await call(
          secondSession,
          'DELETE',
          `/admin/users/${second.id}/roles/direccion`,
        );
        expect(renounce.statusCode).toBe(200); // boss sigue siendo titular
        expect(
          (await call(me, 'DELETE', `/admin/users/${boss.id}/roles/direccion`)).statusCode,
        ).toBe(409);
        // (el caso simetrico con dos solicitudes simultaneas se prueba en el clúster desechable)
      });
    });

    // ----------------------------------------------------------------------------------------------- deshabilitar
    sub('deshabilitar cuentas', () => {
      it('deshabilita, revoca sesiones, audita y es idempotente; no se re-habilita por la API', async () => {
        const me = await login(techBoss);
        const target = await seed({ domain: 'technical', role: 'admin_tecnico' });
        const targetSession = await login(target);
        const res = await call(me, 'POST', `/admin/users/${target.id}/disable`);
        expect(res.statusCode).toBe(200);
        expect(json(res).status).toBe('disabled');
        expect(await auditCount('user.disabled', target.id, 'success')).toBe(1);
        expect((await call(targetSession, 'GET', '/auth/me')).statusCode).toBe(401);
        expect((await call(me, 'POST', `/admin/users/${target.id}/disable`)).statusCode).toBe(200);
        expect(await auditCount('user.disabled', target.id, 'success')).toBe(1);
        const relogin = await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { origin: ORIGIN },
          payload: { email: target.email, password: target.password },
        });
        expect(relogin.statusCode).toBe(401);
      });

      it('una prefectura no puede deshabilitar a nadie y direccion no deshabilita cuentas tecnicas', async () => {
        const pref = await login(await seed({ role: 'prefectura' }));
        const victim = await seed({ role: 'trabajo_social' });
        expect((await call(pref, 'POST', `/admin/users/${victim.id}/disable`)).statusCode).toBe(
          404,
        );
        const dir = await login(boss);
        const techUser = await seed({ domain: 'technical', role: 'admin_tecnico' });
        expect((await call(dir, 'POST', `/admin/users/${techUser.id}/disable`)).statusCode).toBe(
          404,
        );
        expect(
          Number(
            (
              await harness.owner(
                `select count(*)::int n from users where id in ($1,$2) and status = 'active'`,
                [victim.id, techUser.id],
              )
            ).rows[0]!.n,
          ),
        ).toBe(2);
      });
    });

    // ----------------------------------------------------------------------------------------------- transversales
    sub('transversales', () => {
      it('sesion expirada o revocada: 401 en las rutas administrativas', async () => {
        const dir = await seed({ role: 'direccion' });
        const s = await login(dir);
        await harness.owner(
          `update sessions set revoked_at = now(), revoked_reason = 'admin' where user_id = $1 and revoked_at is null`,
          [dir.id],
        );
        expect((await call(s, 'GET', '/admin/users')).statusCode).toBe(401);
        const s2 = await login(dir);
        await harness
          .owner(
            `update sessions set idle_expires_at = now() - interval '1 minute', expires_at = now() + interval '1 hour' where user_id = $1 and revoked_at is null`,
            [dir.id],
          )
          .catch(() => undefined);
        expect((await call(s2, 'GET', '/admin/roles')).statusCode).toBe(401);
      });

      it('limite de peticiones en las rutas administrativas (429 controlado)', async () => {
        const limited = await build({ floodOther: 3 });
        const s = await login(boss, limited);
        const codes: number[] = [];
        for (let i = 0; i < 6; i++)
          codes.push((await call(s, 'GET', '/admin/roles', { target: limited })).statusCode);
        expect(codes.slice(0, 1)).toEqual([200]);
        expect(codes).toContain(429);
        await limited.close();
      });

      it('no se filtran contrasenas, tokens ni hashes en las respuestas ni en los logs', async () => {
        const me = await login(boss);
        const list = await call(me, 'GET', '/admin/users?pageSize=100');
        expect(list.body).not.toMatch(/password|argon2|token_hash|"token"/i);
        const blob = logs.join('');
        for (const secret of secrets) expect(blob.includes(secret), 'secreto en logs').toBe(false);
        expect(blob).not.toContain('$argon2id');
        expect(blob).not.toMatch(/set-cookie|x-csrf-token/i);
      });
    });

    extras.extra?.({
      get harness() {
        return harness;
      },
      app: () => app,
      build,
      seed,
      login,
      call,
      get boss() {
        return boss;
      },
      get techBoss() {
        return techBoss;
      },
      logs,
      secrets,
    });
  });
}
