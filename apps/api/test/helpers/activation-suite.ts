import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activationCodeFromHash } from '@eta15/shared-contracts';
import { ORIGIN } from './auth-http-suite.js';
import type { Account, AdminKit, Login } from './admin-http-suite.js';
import { verifyPasswordForTests } from './activation-password.js';

/**
 * Pruebas de la ACTIVACION de cuentas por reclamo en dos partes (titular -> autoridad presencial -> titular), con Fastify
 * `inject` sobre PostgreSQL real (PGlite o clúster desechable con los privilegios de `eta15_api`). Todo es ficticio.
 * El "navegador del titular" se simula aqui con node:crypto (genera el secreto y calcula el hash); la prueba de navegador
 * real esta en la pasada manual contra `pnpm dev:sandbox`.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const GOOD_PASSWORD = 'Mi gato duerme sobre la mesa azul';
const PUBLIC_HEADERS = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

export function newBrowserSecret() {
  const secret = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(Buffer.from(secret, 'base64url')).digest();
  return { secret, secretHash: digest.toString('base64url'), code: activationCodeFromHash(digest) };
}

export function defineActivationTests(kit: AdminKit): void {
  describe('activacion de cuentas (reclamo en dos partes)', () => {
    let seq = 0;
    const post = (
      url: string,
      payload: unknown,
      opts: { origin?: boolean; ip?: string; target?: ReturnType<AdminKit['app']> } = {},
    ) =>
      (opts.target ?? kit.app()).inject({
        method: 'POST',
        url,
        headers: opts.origin === false ? {} : PUBLIC_HEADERS,
        payload: payload as object,
        ...(opts.ip ? { remoteAddress: opts.ip } : {}),
      });
    const requestActivation = (
      email: string,
      secretHash: string,
      opts: Parameters<typeof post>[2] = {},
    ) => post('/auth/activation/request', { email, secretHash }, opts);
    const statusOf = async (secretHash: string) =>
      ((await post('/auth/activation/status', { secretHash })).json() as Json).state as string;
    const complete = (secret: string, newPassword: string, opts: Parameters<typeof post>[2] = {}) =>
      post('/auth/activation/complete', { secret, newPassword }, opts);

    /**
     * Autoridades "creadoras" por dominio (distintas de boss/techBoss, que son quienes aprueban): el control dual impide que
     * quien crea una cuenta apruebe su activacion, asi que las pruebas separan creador y aprobador.
     */
    const makers: Partial<Record<'school' | 'technical', Account>> = {};
    async function makerLogin(domain: 'school' | 'technical'): Promise<Login> {
      makers[domain] ??= await kit.seed({
        domain,
        role: domain === 'school' ? 'direccion' : 'admin_tecnico',
      });
      return kit.login(makers[domain]);
    }

    /** Una autoridad (por defecto la "creadora" del dominio) crea una cuenta pendiente por la API administrativa. */
    async function createPending(
      domain: 'school' | 'technical' = 'school',
      name = 'Persona pendiente de prueba',
      /** Rol que se le asigna ANTES de activar (sin rol una cuenta activa no puede iniciar sesion). `null` = ninguno. */
      role: string | null = domain === 'school' ? 'prefectura' : 'admin_tecnico',
      creator?: Login,
    ) {
      const by = creator ?? (await makerLogin(domain));
      const email = `pendiente.${++seq}.${Date.now() % 100000}@escuela.mx`;
      const res = await kit.call(by, 'POST', '/admin/users', {
        body: { email, displayName: name, accountDomain: domain },
      });
      expect(res.statusCode).toBe(201);
      const id = (res.json() as Json).id as string;
      if (role) {
        const assigned = await kit.call(by, 'POST', `/admin/users/${id}/roles`, {
          body: { roleKey: role },
        });
        expect(assigned.statusCode, assigned.body).toBe(201);
      }
      return { id, email };
    }
    const approve = (by: Login, requestId: string, code: string, method = 'in_person_id') =>
      kit.call(by, 'POST', `/admin/activation-requests/${requestId}/approve`, {
        body: { code, verificationMethod: method },
      });
    const listRequests = async (by: Login) =>
      ((await kit.call(by, 'GET', '/admin/activation-requests')).json() as Json).items as Json[];
    const requestIdOf = async (by: Login, email: string) =>
      (await listRequests(by)).find((r) => r.email === email)?.id as string | undefined;
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const tokenRow = async (userId: string) =>
      (
        await q(
          `select authorized_by, verification_method, used_at, invalidated_at, authorized_at from auth_tokens where user_id = $1 order by created_at desc limit 1`,
          [userId],
        )
      )[0] as Json;
    const loginAs = async (email: string, password: string) =>
      kit.app().inject({
        method: 'POST',
        url: '/auth/login',
        headers: PUBLIC_HEADERS,
        payload: { email, password },
      });
    /** Pasa un token a vencido (solo el propietario, con el trigger de inmutabilidad apagado un instante en una base de PRUEBA). */
    async function expireToken(userId: string) {
      await kit.harness.owner(`alter table auth_tokens disable trigger auth_tokens_guard_update`);
      try {
        await kit.harness.owner(
          `update auth_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
            where user_id = $1 and used_at is null and invalidated_at is null`,
          [userId],
        );
      } finally {
        await kit.harness.owner(
          `alter table auth_tokens enable always trigger auth_tokens_guard_update`,
        );
      }
    }

    it('flujo completo: crear cuenta -> titular solicita -> autoridad verifica en persona -> titular elige su contrasena -> login', async () => {
      const boss = await kit.login(kit.boss);
      const acct = await createPending();
      const before = await loginAs(acct.email, GOOD_PASSWORD);
      expect(before.statusCode).toBe(401); // una cuenta pendiente no entra

      const browser = newBrowserSecret();
      kit.secrets.add(browser.secret);
      const req = await requestActivation(acct.email.toUpperCase(), browser.secretHash);
      expect(req.statusCode).toBe(202);
      expect(req.json()).toEqual({ accepted: true, ttlMinutes: 30 });
      expect(await statusOf(browser.secretHash)).toBe('waiting');

      // La autoridad ve la solicitud, pero NO el codigo, el hash ni el secreto.
      const listRes = await kit.call(boss, 'GET', '/admin/activation-requests');
      const item = ((listRes.json() as Json).items as Json[]).find((r) => r.email === acct.email)!;
      expect(item).toMatchObject({ userId: acct.id, state: 'requested', accountDomain: 'school' });
      expect(Object.keys(item).sort()).toEqual([
        'accountDomain',
        'createdByActor',
        'displayName',
        'email',
        'expiresAt',
        'id',
        'requestedAt',
        'state',
        'userId',
      ]);
      expect(listRes.body).not.toContain(browser.code);
      expect(listRes.body).not.toContain(browser.secretHash);
      expect(await statusOf(browser.secretHash)).toBe('waiting');

      // Sin aprobacion no se puede completar.
      expect((await complete(browser.secret, GOOD_PASSWORD)).statusCode).toBe(400);
      expect((await tokenRow(acct.id)).used_at).toBeNull();

      // La autoridad teclea el codigo de la pantalla del titular (en minusculas y con espacios: se normaliza).
      const ok = await approve(boss, item.id, ` ${browser.code.toLowerCase().replace('-', ' ')} `);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ state: 'authorized' });
      expect(ok.body).not.toContain(browser.secret);
      expect(await statusOf(browser.secretHash)).toBe('authorized');
      expect(await tokenRow(acct.id)).toMatchObject({
        authorized_by: kit.boss.id,
        verification_method: 'in_person_id',
      });

      // El titular elige SU contrasena: sin sesion automatica.
      const done = await complete(browser.secret, GOOD_PASSWORD);
      expect(done.statusCode, done.body).toBe(204);
      expect(done.cookies).toEqual([]);
      expect(done.headers['set-cookie']).toBeUndefined();
      const user = (
        await q(`select status, password_hash, password_changed_at from users where id = $1`, [
          acct.id,
        ])
      )[0]!;
      expect(user.status).toBe('active');
      expect(user.password_changed_at).not.toBeNull();
      expect(await verifyPasswordForTests(user.password_hash as string, GOOD_PASSWORD)).toBe(true);
      expect((await tokenRow(acct.id)).used_at).not.toBeNull();
      expect(await statusOf(browser.secretHash)).toBe('unknown'); // consumida

      // Auditoria sin secretos.
      const events = await q(
        `select event_type, outcome, actor_user_id, a::text as dump from audit_events a where subject_user_id = $1 and event_type like 'activation.%' order by occurred_at`,
        [acct.id],
      );
      expect(events.map((e) => e.event_type)).toEqual([
        'activation.requested',
        'activation.authorized',
        'activation.completed',
      ]);
      expect(events[1]!.actor_user_id).toBe(kit.boss.id);
      for (const e of events) {
        const dump = e.dump as string;
        for (const secret of [
          browser.secret,
          browser.secretHash,
          browser.code,
          GOOD_PASSWORD,
          user.password_hash as string,
        ])
          expect(dump.includes(secret as string)).toBe(false);
      }

      // Ahora entra con la contrasena que ELLA eligio (y no con otra).
      expect((await loginAs(acct.email, 'otra contraseña distinta cualquiera')).statusCode).toBe(
        401,
      );
      const login = await loginAs(acct.email, GOOD_PASSWORD);
      expect(login.statusCode).toBe(200);
      expect(login.cookies[0]!.httpOnly).toBe(true);
    });

    it('sin enumeracion: cuenta pendiente, activa e inexistente reciben exactamente la misma respuesta', async () => {
      const pending = await createPending();
      const active = await kit.seed({ role: 'prefectura' });
      const results = [];
      for (const email of [pending.email, active.email, `no.existe.${Date.now()}@escuela.mx`]) {
        const r = await requestActivation(email, newBrowserSecret().secretHash);
        results.push({ status: r.statusCode, body: r.json(), setCookie: r.headers['set-cookie'] });
      }
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      // y una cuenta ACTIVA no recibe ninguna solicitud
      expect(
        Number(
          (await q(`select count(*)::int n from auth_tokens where user_id = $1`, [active.id]))[0]!
            .n,
        ),
      ).toBe(0);
      expect(await statusOf(newBrowserSecret().secretHash)).toBe('unknown');
    });

    it('una solicitud VIGENTE no se reemplaza repitiendo la peticion publica con el correo (ni aprobada ni sin aprobar)', async () => {
      const boss = await kit.login(kit.boss);
      const acct = await createPending();
      const first = newBrowserSecret();
      const intruder = newBrowserSecret();
      await requestActivation(acct.email, first.secretHash);
      const again = await requestActivation(acct.email, intruder.secretHash); // alguien que solo conoce el correo
      expect(again.statusCode).toBe(202); // misma respuesta: no revela que ya habia una
      expect(await statusOf(first.secretHash)).toBe('waiting'); // la original sigue vigente
      expect(await statusOf(intruder.secretHash)).toBe('unknown'); // la del intruso no se registro
      expect((await listRequests(boss)).filter((r) => r.email === acct.email)).toHaveLength(1);
      // tampoco una vez aprobada
      const id = (await requestIdOf(boss, acct.email))!;
      expect((await approve(boss, id, first.code)).statusCode).toBe(200);
      await requestActivation(acct.email, newBrowserSecret().secretHash);
      expect(await statusOf(first.secretHash)).toBe('authorized');
      expect(
        Number(
          (
            await q(
              `select count(*)::int n from auth_tokens where user_id = $1 and invalidated_at is null`,
              [acct.id],
            )
          )[0]!.n,
        ),
      ).toBe(1);
    });

    it('10 solicitudes publicas simultaneas para la misma cuenta: queda UNA vigente y no se reemplazan entre si', async () => {
      const acct = await createPending();
      const proofs = Array.from({ length: 10 }, () => newBrowserSecret());
      const results = await Promise.all(
        proofs.map((p) => requestActivation(acct.email, p.secretHash)),
      );
      expect(results.every((r) => r.statusCode === 202)).toBe(true);
      const states = await Promise.all(proofs.map((p) => statusOf(p.secretHash)));
      expect(states.filter((s) => s === 'waiting')).toHaveLength(1);
      expect(
        Number(
          (
            await q(
              `select count(*)::int n from auth_tokens where user_id = $1 and invalidated_at is null and used_at is null`,
              [acct.id],
            )
          )[0]!.n,
        ),
      ).toBe(1);
    });

    it('un tercero que se adelanta no logra activar la cuenta: el codigo no coincide y solo una autoridad puede cancelar y reiniciar', async () => {
      const boss = await kit.login(kit.boss);
      const acct = await createPending();
      const attacker = newBrowserSecret(); // conoce el correo, no esta presente ante la autoridad
      const legit = newBrowserSecret();
      await requestActivation(acct.email, attacker.secretHash);
      await requestActivation(acct.email, legit.secretHash); // la persona legitima no puede pisarla
      expect(await statusOf(legit.secretHash)).toBe('unknown');
      const id = (await requestIdOf(boss, acct.email))!;
      const mismatch = await approve(boss, id, legit.code); // la persona presente muestra SU codigo
      expect(mismatch.statusCode).toBe(400);
      expect((mismatch.json() as Json).error.code).toBe('CODE_MISMATCH');
      expect((await complete(attacker.secret, GOOD_PASSWORD)).statusCode).toBe(400); // sin aprobar no activa
      // la autoridad cancela la solicitud ajena (procedimiento autorizado) y la persona reinicia
      expect(
        (await kit.call(boss, 'POST', `/admin/activation-requests/${id}/cancel`)).statusCode,
      ).toBe(200);
      await requestActivation(acct.email, legit.secretHash);
      expect(await statusOf(legit.secretHash)).toBe('waiting');
      expect(await statusOf(attacker.secretHash)).toBe('unknown');
      const id2 = (await requestIdOf(boss, acct.email))!;
      expect((await approve(boss, id2, legit.code)).statusCode).toBe(200);
      expect(
        (await complete(attacker.secret, 'Frase del intruso que no debe funcionar')).statusCode,
      ).toBe(400);
      expect((await complete(legit.secret, GOOD_PASSWORD)).statusCode).toBe(204);
    });

    it('una solicitud aprobada que vence sin completarse se libera sola (expiracion) y la persona puede iniciar otra', async () => {
      const boss = await kit.login(kit.boss);
      const acct = await createPending();
      const old = newBrowserSecret();
      await requestActivation(acct.email, old.secretHash);
      expect(
        (await approve(boss, (await requestIdOf(boss, acct.email))!, old.code)).statusCode,
      ).toBe(200);
      await expireToken(acct.id);
      const fresh = newBrowserSecret();
      await requestActivation(acct.email, fresh.secretHash);
      expect(await statusOf(old.secretHash)).toBe('unknown');
      expect(await statusOf(fresh.secretHash)).toBe('waiting');
    });

    describe('autorizacion de la autoridad', () => {
      it('sin sesion 401; sin CSRF 403; una prefectura 403; el codigo erroneo no autoriza', async () => {
        const boss = await kit.login(kit.boss);
        const acct = await createPending();
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        const id = (await requestIdOf(boss, acct.email))!;
        expect(
          (
            await kit.call(null, 'POST', `/admin/activation-requests/${id}/approve`, {
              body: { code: b.code, verificationMethod: 'in_person_id' },
            })
          ).statusCode,
        ).toBe(401);
        expect((await kit.call(null, 'GET', '/admin/activation-requests')).statusCode).toBe(401);
        expect(
          (
            await kit.call(boss, 'POST', `/admin/activation-requests/${id}/approve`, {
              body: { code: b.code, verificationMethod: 'in_person_id' },
              csrf: false,
            })
          ).statusCode,
        ).toBe(403);
        const pref = await kit.login(await kit.seed({ role: 'prefectura' }));
        expect((await approve(pref, id, b.code)).statusCode).toBe(404); // fuera de su alcance
        expect((await kit.call(pref, 'GET', '/admin/activation-requests')).statusCode).toBe(403);
        const wrong = await approve(boss, id, newBrowserSecret().code);
        expect(wrong.statusCode).toBe(400);
        expect((wrong.json() as Json).error.code).toBe('CODE_MISMATCH');
        expect(await statusOf(b.secretHash)).toBe('waiting'); // sigue sin aprobar
        expect(
          Number(
            (
              await q(
                `select count(*)::int n from audit_events where event_type = 'authz.denied' and actor_user_id = $1 and details->>'reason' = 'code_mismatch'`,
                [kit.boss.id],
              )
            )[0]!.n,
          ),
        ).toBeGreaterThanOrEqual(1);
        // metodo de verificacion y cuerpo invalidos
        expect((await approve(boss, id, b.code, 'por_telefono')).statusCode).toBe(400);
        expect(
          (
            await kit.call(boss, 'POST', `/admin/activation-requests/${id}/approve`, {
              body: {
                code: b.code,
                verificationMethod: 'in_person_id',
                authorizedBy: kit.techBoss.id,
              },
            })
          ).statusCode,
        ).toBe(400);
      });

      it('autoridad de otro dominio: no ve ni aprueba la solicitud (404) y la base tambien lo impide', async () => {
        const boss = await kit.login(kit.boss);
        const tech = await kit.login(kit.techBoss);
        const schoolAcct = await createPending('school');
        const techAcct = await createPending('technical');
        const bs = newBrowserSecret();
        const bt = newBrowserSecret();
        await requestActivation(schoolAcct.email, bs.secretHash);
        await requestActivation(techAcct.email, bt.secretHash);
        const schoolId = (await requestIdOf(boss, schoolAcct.email))!;
        const techId = (await requestIdOf(tech, techAcct.email))!;
        expect(await requestIdOf(tech, schoolAcct.email)).toBeUndefined();
        expect(await requestIdOf(boss, techAcct.email)).toBeUndefined();
        expect((await approve(tech, schoolId, bs.code)).statusCode).toBe(404);
        expect((await approve(boss, techId, bt.code)).statusCode).toBe(404);
        // ultima defensa en PostgreSQL: aunque se intentara saltar la API, el trigger exige autoridad del MISMO dominio
        await expect(
          kit.harness.owner(
            `update auth_tokens set authorized_at = now(), authorized_by = $1, verification_method = 'in_person_id' where user_id = $2 and used_at is null and invalidated_at is null`,
            [kit.techBoss.id, schoolAcct.id],
          ),
        ).rejects.toThrow();
        expect(await statusOf(bs.secretHash)).toBe('waiting');
      });

      it('nadie aprueba su propia activacion (restriccion de la base) ni una autoridad inactiva autoriza', async () => {
        const boss = await kit.login(kit.boss);
        const acct = await createPending();
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        await expect(
          kit.harness.owner(
            `update auth_tokens set authorized_at = now(), authorized_by = user_id, verification_method = 'in_person_id' where user_id = $1 and used_at is null and invalidated_at is null`,
            [acct.id],
          ),
        ).rejects.toThrow();
        // una autoridad deshabilitada: su sesion cae y la base rechaza su firma
        const second = await kit.seed({ role: 'direccion' });
        const secondSession = await kit.login(second);
        await kit.call(boss, 'POST', `/admin/users/${second.id}/disable`);
        const id = (await requestIdOf(boss, acct.email))!;
        expect((await approve(secondSession, id, b.code)).statusCode).toBe(401);
        await expect(
          kit.harness.owner(
            `update auth_tokens set authorized_at = now(), authorized_by = $1, verification_method = 'in_person_id' where user_id = $2 and used_at is null and invalidated_at is null`,
            [second.id, acct.id],
          ),
        ).rejects.toThrow();
        expect(await statusOf(b.secretHash)).toBe('waiting');
      });

      it('la autoridad no puede reemplazar la prueba: el hash del token es inmutable y no puede editarse con los privilegios de la API', async () => {
        const boss = await kit.login(kit.boss);
        const acct = await createPending();
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        const intruder = newBrowserSecret();
        await expect(
          kit.harness.owner(
            `update auth_tokens set token_hash = decode($2, 'base64') where user_id = $1 and used_at is null and invalidated_at is null`,
            [acct.id, Buffer.from(intruder.secretHash, 'base64url').toString('base64')],
          ),
        ).rejects.toThrow(); // incluso el propietario: trigger de inmutabilidad
        // y no hay ruta alguna que reciba un hash/secreto de parte de la autoridad
        const id = (await requestIdOf(boss, acct.email))!;
        const attempt = await kit.call(boss, 'POST', `/admin/activation-requests/${id}/approve`, {
          body: {
            code: b.code,
            verificationMethod: 'in_person_id',
            secretHash: intruder.secretHash,
          },
        });
        expect(attempt.statusCode).toBe(400);
        expect(await statusOf(intruder.secretHash)).toBe('unknown');
      });

      it('doble aprobacion simultanea (dos autoridades): exactamente una', async () => {
        const boss = await kit.login(kit.boss);
        const other = await kit.seed({ role: 'direccion' });
        const otherSession = await kit.login(other);
        const acct = await createPending();
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        const id = (await requestIdOf(boss, acct.email))!;
        const results = await Promise.all([
          approve(boss, id, b.code),
          approve(otherSession, id, b.code),
          approve(boss, id, b.code),
        ]);
        const codes = results.map((r) => r.statusCode).sort();
        expect(codes.filter((c) => c === 200)).toHaveLength(1);
        expect(codes.filter((c) => c === 409)).toHaveLength(2);
        expect(
          Number(
            (
              await q(
                `select count(*)::int n from audit_events where event_type = 'activation.authorized' and subject_user_id = $1`,
                [acct.id],
              )
            )[0]!.n,
          ),
        ).toBe(1);
      });
    });

    describe('finalizacion por el titular', () => {
      async function authorized(
        domain: 'school' | 'technical' = 'school',
        name = 'Persona pendiente de prueba',
      ) {
        const authority = await kit.login(domain === 'school' ? kit.boss : kit.techBoss);
        const acct = await createPending(domain, name);
        const b = newBrowserSecret();
        kit.secrets.add(b.secret);
        await requestActivation(acct.email, b.secretHash);
        const id = (await requestIdOf(authority, acct.email))!;
        expect((await approve(authority, id, b.code)).statusCode).toBe(200);
        return { acct, b, id, authority };
      }

      it('secreto inexistente, mal formado o ajeno: respuesta generica 400 sin pistas', async () => {
        const { acct, b } = await authorized();
        const wrong = await complete(newBrowserSecret().secret, GOOD_PASSWORD);
        expect(wrong.statusCode).toBe(400);
        expect((wrong.json() as Json).error.code).toBe('ACTIVATION_INVALID');
        for (const bad of ['corto', 'A'.repeat(44), b.secretHash.slice(0, 42) + '!'])
          expect((await complete(bad, GOOD_PASSWORD)).statusCode).toBe(400);
        expect((await complete(b.secretHash, GOOD_PASSWORD)).statusCode).toBe(400); // el HASH no es el secreto
        expect(wrong.body).not.toContain(acct.email);
        expect((await tokenRow(acct.id)).used_at).toBeNull();
      });

      it('politica de contrasenas: rechaza las debiles SIN consumir el token y sin repetirlas; acepta frases Unicode', async () => {
        const { acct, b } = await authorized('school', 'Maria Fernanda Lopez');
        const cases: Array<[string, string]> = [
          ['corta1', 'too_short'],
          ['Password123456', 'common'],
          ['contraseña123456', 'common'],
          ['aaaaaaaaaaaaaaaa', 'repetitive'],
          ['abcdefghijklmnop', 'sequence'],
          [acct.email.split('@')[0]! + '2026!!', 'contains_identity'],
          ['mariafernandalopez77', 'contains_identity'],
          ['x'.repeat(200), 'too_long'],
        ];
        for (const [password, reason] of cases) {
          const res = await complete(b.secret, password);
          expect(res.statusCode, password).toBe(400);
          const body = res.json() as Json;
          expect(body.error.code).toBe('PASSWORD_POLICY');
          expect(body.error.reasons).toContain(reason);
          expect(res.body).not.toContain(password);
        }
        expect(await statusOf(b.secretHash)).toBe('authorized'); // el token sigue vigente
        const passphrase = 'El niño comió piñatas bajo la luna 🌙';
        const ok = await complete(b.secret, passphrase);
        expect(ok.statusCode, ok.body).toBe(204);
        expect((await loginAs(acct.email, passphrase)).statusCode).toBe(200);
        // NFKC: la misma frase con otra composicion Unicode tambien entra
        expect((await loginAs(acct.email, passphrase.normalize('NFD'))).statusCode).toBe(200);
      });

      it('un solo uso: la segunda finalizacion con el mismo secreto falla y la contrasena no cambia', async () => {
        const { acct, b } = await authorized();
        expect((await complete(b.secret, GOOD_PASSWORD)).statusCode).toBe(204);
        const again = await complete(b.secret, 'Otra contraseña muy distinta y larga');
        expect(again.statusCode).toBe(400);
        expect((await loginAs(acct.email, GOOD_PASSWORD)).statusCode).toBe(200);
        expect((await loginAs(acct.email, 'Otra contraseña muy distinta y larga')).statusCode).toBe(
          401,
        );
      });

      it('finalizaciones simultaneas (8 con contrasenas distintas): exactamente una, y es la que queda', async () => {
        const { acct, b } = await authorized();
        const passwords = Array.from(
          { length: 8 },
          (_, i) => `Frase de prueba número ${i} para activar`,
        );
        const results = await Promise.all(passwords.map((p) => complete(b.secret, p)));
        expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
        expect(results.filter((r) => r.statusCode === 400)).toHaveLength(7);
        const winner = passwords[results.findIndex((r) => r.statusCode === 204)]!;
        const hash = (await q(`select password_hash from users where id = $1`, [acct.id]))[0]!
          .password_hash as string;
        expect(await verifyPasswordForTests(hash, winner)).toBe(true);
        expect(
          Number(
            (
              await q(
                `select count(*)::int n from audit_events where event_type = 'activation.completed' and subject_user_id = $1`,
                [acct.id],
              )
            )[0]!.n,
          ),
        ).toBe(1);
      });

      it('solicitud vencida: no se aprueba, no se completa, se puede cancelar y la persona inicia otra', async () => {
        const boss = await kit.login(kit.boss);
        const acct = await createPending();
        const old = newBrowserSecret();
        await requestActivation(acct.email, old.secretHash);
        await expireToken(acct.id);
        expect(await statusOf(old.secretHash)).toBe('expired');
        const items = await listRequests(boss);
        const item = items.find((r) => r.email === acct.email)!;
        expect(item.state).toBe('expired');
        const late = await approve(boss, item.id, old.code);
        expect(late.statusCode).toBe(409);
        expect((late.json() as Json).error.code).toBe('EXPIRED');
        const cancel = await kit.call(boss, 'POST', `/admin/activation-requests/${item.id}/cancel`);
        expect(cancel.statusCode).toBe(200);
        expect(await statusOf(old.secretHash)).toBe('unknown');
        expect(
          (await kit.call(boss, 'POST', `/admin/activation-requests/${item.id}/cancel`)).statusCode,
        ).toBe(404);
        const fresh = newBrowserSecret();
        await requestActivation(acct.email, fresh.secretHash);
        expect(await statusOf(fresh.secretHash)).toBe('waiting');
      });

      it('aprobada y vencida antes de completar: invalida (no se puede completar)', async () => {
        const { acct, b } = await authorized();
        await expireToken(acct.id);
        expect(await statusOf(b.secretHash)).toBe('expired');
        expect((await complete(b.secret, GOOD_PASSWORD)).statusCode).toBe(400);
        expect(
          ((await q(`select status from users where id = $1`, [acct.id]))[0] as Json).status,
        ).toBe('pending');
      });

      it('si el navegador del titular se cerro tras la aprobacion: la autoridad cancela y la persona reinicia', async () => {
        const { acct, b, id, authority } = await authorized();
        const lost = newBrowserSecret(); // el secreto original se perdio; la nueva solicitud no puede pisar la aprobada
        await requestActivation(acct.email, lost.secretHash);
        expect(await statusOf(lost.secretHash)).toBe('unknown');
        expect(await statusOf(b.secretHash)).toBe('authorized');
        expect(
          (await kit.call(authority, 'POST', `/admin/activation-requests/${id}/cancel`)).statusCode,
        ).toBe(200);
        await requestActivation(acct.email, lost.secretHash);
        expect(await statusOf(lost.secretHash)).toBe('waiting');
        expect((await complete(b.secret, GOOD_PASSWORD)).statusCode).toBe(400); // el secreto anterior ya no sirve
      });

      it('cancelar vs completar a la vez: nunca queda una cuenta activa con un token cancelado', async () => {
        const { acct, b, id, authority } = await authorized();
        const [c, d] = await Promise.all([
          complete(b.secret, GOOD_PASSWORD),
          kit.call(authority, 'POST', `/admin/activation-requests/${id}/cancel`),
        ]);
        const row = await tokenRow(acct.id);
        const status = ((await q(`select status from users where id = $1`, [acct.id]))[0] as Json)
          .status;
        if (c.statusCode === 204) {
          expect(status).toBe('active');
          expect(row.used_at).not.toBeNull();
          expect(d.statusCode).toBe(404);
        } else {
          expect(status).toBe('pending');
          expect(row.invalidated_at).not.toBeNull();
        }
      });
    });

    describe('separacion de dominios y roles tras activar', () => {
      it('cuenta TECNICA: la activa su autoridad tecnica y no obtiene permisos escolares; el rol asignado antes se conserva', async () => {
        const creator = await kit.login(kit.techBoss);
        // admin_tecnico es un rol de AUTORIDAD: la activa OTRA autoridad tecnica, no quien creo la cuenta (control dual).
        const tech = await kit.login(
          await kit.seed({ domain: 'technical', role: 'admin_tecnico' }),
        );
        const acct = await createPending('technical', 'Persona tecnica', 'admin_tecnico', creator);
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        const id = (await requestIdOf(tech, acct.email))!;
        const sameCreator = await approve(creator, id, b.code, 'in_person_known');
        expect(sameCreator.statusCode).toBe(403);
        expect(sameCreator.body).toMatch(/otra autoridad/);
        expect(await statusOf(b.secretHash)).toBe('waiting');
        expect((await approve(tech, id, b.code, 'in_person_known')).statusCode).toBe(200);
        expect((await complete(b.secret, GOOD_PASSWORD)).statusCode).toBe(204);
        const login = await loginAs(acct.email, GOOD_PASSWORD);
        expect(login.statusCode).toBe(200);
        const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
        const me = (
          await kit.app().inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
        ).json() as Json;
        expect(me.roles).toEqual(['admin_tecnico']);
        expect(me.user.accountDomain).toBe('technical');
        const school = new Set(
          (await q(`select key from permissions where domain = 'school'`)).map(
            (r) => r.key as string,
          ),
        );
        expect(me.permissions.some((p: Json) => school.has(p.permission))).toBe(false);
      });

      it('control dual: quien creo una cuenta NUNCA aprueba su activacion (cualquier cuenta); otra autoridad si', async () => {
        const boss = await kit.login(kit.boss);
        const other = await kit.login(await kit.seed({ role: 'direccion' }));
        for (const role of ['prefectura', 'direccion']) {
          const acct = await createPending('school', `Cuenta ${role}`, role, boss); // creada por boss
          const b = newBrowserSecret();
          await requestActivation(acct.email, b.secretHash);
          const id = (await requestIdOf(boss, acct.email))!;
          const denied = await approve(boss, id, b.code);
          expect(denied.statusCode, role).toBe(403);
          expect(denied.body).toMatch(/otra autoridad/);
          expect(await statusOf(b.secretHash)).toBe('waiting');
          expect(
            Number(
              (
                await q(
                  `select count(*)::int n from audit_events where event_type = 'authz.denied' and actor_user_id = $1 and details->>'reason' = 'dual_control_required' and subject_user_id is null`,
                  [kit.boss.id],
                )
              )[0]!.n,
            ),
          ).toBeGreaterThanOrEqual(1);
          const listed = (await listRequests(boss)).find((r) => r.id === id)!;
          expect(listed.createdByActor).toBe(true); // la interfaz puede avisar que no le corresponde aprobar
          expect(
            ((await listRequests(other)).find((r) => r.id === id) as Json).createdByActor,
          ).toBe(false);
          expect((await approve(other, id, b.code)).statusCode, role).toBe(200);
          expect((await complete(b.secret, GOOD_PASSWORD)).statusCode).toBe(204);
          expect((await loginAs(acct.email, GOOD_PASSWORD)).statusCode).toBe(200); // MFA diferido en este entorno de pruebas
        }
      });

      it('rol asignado y luego revocado a la cuenta recien activada: la sesion cae', async () => {
        const boss = await kit.login(kit.boss);
        const acct = await createPending();
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        await approve(boss, (await requestIdOf(boss, acct.email))!, b.code);
        await complete(b.secret, GOOD_PASSWORD);
        const login = await loginAs(acct.email, GOOD_PASSWORD);
        const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
        expect(
          (await kit.app().inject({ method: 'GET', url: '/auth/me', headers: { cookie } }))
            .statusCode,
        ).toBe(200);
        expect(
          (await kit.call(boss, 'DELETE', `/admin/users/${acct.id}/roles/prefectura`)).statusCode,
        ).toBe(200);
        expect(
          (await kit.app().inject({ method: 'GET', url: '/auth/me', headers: { cookie } }))
            .statusCode,
        ).toBe(401);
      });

      it('una cuenta activada sin ningun rol no puede iniciar sesion (no hay acceso sin roles)', async () => {
        const boss = await kit.login(kit.boss);
        const acct = await createPending('school', 'Persona sin rol', null);
        const b = newBrowserSecret();
        await requestActivation(acct.email, b.secretHash);
        await approve(boss, (await requestIdOf(boss, acct.email))!, b.code);
        expect((await complete(b.secret, GOOD_PASSWORD)).statusCode).toBe(204);
        expect((await loginAs(acct.email, GOOD_PASSWORD)).statusCode).toBe(401);
      });
    });

    describe('abuso y proteccion de la entrada', () => {
      it('los endpoints publicos exigen Origin permitido y JSON estricto', async () => {
        const b = newBrowserSecret();
        for (const url of [
          '/auth/activation/request',
          '/auth/activation/status',
          '/auth/activation/complete',
        ]) {
          expect((await post(url, {}, { origin: false })).statusCode, url).toBe(403);
        }
        expect(
          (
            await post('/auth/activation/request', {
              email: 'a@escuela.mx',
              secretHash: b.secretHash,
              extra: 1,
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (await post('/auth/activation/request', { email: 'no-correo', secretHash: b.secretHash }))
            .statusCode,
        ).toBe(400);
        expect(
          (await post('/auth/activation/request', { email: 'a@escuela.mx', secretHash: 'corto' }))
            .statusCode,
        ).toBe(400);
        expect(
          (await post('/auth/activation/complete', { secret: b.secret, newPassword: '' }))
            .statusCode,
        ).toBe(400);
      });

      it('limite de solicitudes por correo (frena el reemplazo repetido) y por IP; limite de finalizaciones fallidas', async () => {
        const limited = await kit.build({
          activationRequestAccount: 2,
          activationRequestIp: 50,
          activationCompleteFailures: 3,
        });
        const acct = await createPending();
        const codes: number[] = [];
        for (let i = 0; i < 4; i++)
          codes.push(
            (
              await requestActivation(acct.email, newBrowserSecret().secretHash, {
                target: limited,
                ip: '10.8.8.1',
              })
            ).statusCode,
          );
        expect(codes).toEqual([202, 202, 429, 429]);
        const blocked = await requestActivation(acct.email, newBrowserSecret().secretHash, {
          target: limited,
          ip: '10.8.8.2',
        });
        expect(blocked.statusCode).toBe(429); // desde otra IP el limite por correo sigue valiendo
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        const fails: number[] = [];
        for (let i = 0; i < 5; i++)
          fails.push(
            (
              await complete(newBrowserSecret().secret, GOOD_PASSWORD, {
                target: limited,
                ip: '10.8.8.3',
              })
            ).statusCode,
          );
        expect(fails).toEqual([400, 400, 400, 429, 429]);
        await limited.close();
      });

      it('ninguna respuesta ni log contiene secretos, hashes de secreto, codigos ni contrasenas', async () => {
        const blob = kit.logs.join('');
        for (const secret of kit.secrets)
          expect(blob.includes(secret), 'secreto en logs').toBe(false);
        for (const fragment of [GOOD_PASSWORD, 'El niño comió', 'Mi gato duerme'])
          expect(blob.includes(fragment)).toBe(false);
        expect(blob).not.toContain('$argon2id');
        const all = (await q(`select string_agg(t::text, ' ') as d from auth_tokens t`))[0]!.d as
          string | null;
        expect(all ?? '').not.toContain(GOOD_PASSWORD);
      });
    });
  });
}
