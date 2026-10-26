import { describe, expect, it } from 'vitest';
import type { BootstrapError } from '../../src/modules/auth/bootstrap.js';
import {
  BOOTSTRAP_PROCEDURES,
  bootstrapFirstAuthority,
  MIN_BOOTSTRAP_PASSWORD_LENGTH,
  type BootstrapDeps,
  type OwnerClient,
} from '../../src/modules/auth/bootstrap.js';
import { createPasswordService } from '../../src/modules/auth/password.js';

/**
 * Pruebas del bootstrap controlado de la primera autoridad. Ejecutadas con el PROPIETARIO del esquema sobre PGlite y sobre
 * un clúster PostgreSQL desechable. Cuentas, actas y contrasenas FICTICIAS; nunca se ejecuta contra eta15_dev.
 */
const passwords = createPasswordService({
  params: { memoryKiB: 19 * 1024, passes: 2, parallelism: 1, tagLength: 32 },
});
const PW = 'Contraseña-ficticia-del-titular-#1';
const ACTA = 'ACTA-PRUEBA-2026-001';

export interface BootstrapHarness {
  /** Conexion del propietario (cada llamada devuelve una conexion nueva e independiente cuando es posible). */
  owner: () => Promise<OwnerClient>;
  /** Conexion NO propietaria (eta15_api o rol equivalente). */
  api?: () => Promise<OwnerClient>;
  /** Consulta de verificacion como propietario. */
  q: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  concurrent?: boolean;
}

const asked = () => {
  const state = { calls: 0 };
  return {
    state,
    read: async () => {
      state.calls += 1;
      return PW;
    },
  };
};

export function defineBootstrapSuite(
  label: string,
  setup: () => Promise<{ h: BootstrapHarness; teardown: () => Promise<void> }>,
): void {
  describe(`bootstrap controlado (${label})`, () => {
    let h: BootstrapHarness;
    let teardown: () => Promise<void>;
    let ready: Promise<void> | undefined;
    const init = () =>
      (ready ??= setup().then((r) => ((h = r.h), (teardown = r.teardown), undefined)));
    const run = async (
      input: Partial<Parameters<typeof bootstrapFirstAuthority>[0]> = {},
      deps: Partial<BootstrapDeps> = {},
      client?: OwnerClient,
    ) => {
      await init();
      const reader = asked();
      const result = await bootstrapFirstAuthority(
        {
          domain: 'technical',
          email: 'Titular.Tecnico@Escuela.mx ',
          displayName: 'Titular tecnico ficticio',
          acta: ACTA,
          ...input,
        },
        { client: client ?? (await h.owner()), passwords, readPassword: reader.read, ...deps },
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      return { ...result, reader: reader.state };
    };
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await h.q(sql, params)).rows[0]!.n);

    it('0. el dominio ESCOLAR esta BLOQUEADO por defecto (no hay procedimiento verificable aprobado) y no se pide contrasena', async () => {
      const r = await run({ domain: 'school', email: 'direccion@escuela.mx' });
      expect((r as { error: BootstrapError }).error).toMatchObject({ code: 'procedure_blocked' });
      expect(r.reader.calls).toBe(0);
      expect(await count(`select count(*)::int n from users`)).toBe(0);
      expect(BOOTSTRAP_PROCEDURES.school.approved).toBe(false);
    });

    it('rechaza entradas invalidas antes de pedir la contrasena ni escribir nada', async () => {
      for (const bad of [
        { acta: 'ab' },
        { acta: 'x'.repeat(201) },
        { email: 'no-es-correo' },
        { displayName: '  ' },
      ]) {
        const r = await run(bad);
        expect((r as { error: BootstrapError }).error, JSON.stringify(bad)).toMatchObject({
          code: 'invalid_input',
        });
        expect(r.reader.calls).toBe(0);
      }
      expect(await count(`select count(*)::int n from users`)).toBe(0);
    });

    it('contrasena demasiado corta o lectura cancelada: no se crea nada', async () => {
      const short = await run({}, { readPassword: async () => 'corta' });
      expect((short as { error: BootstrapError }).error).toMatchObject({
        code: 'password_rejected',
      });
      expect(String((short as { error: Error }).error.message)).not.toContain('corta');
      const cancelled = await run(
        {},
        {
          readPassword: async () => {
            throw new Error('Cancelado por la persona usuaria');
          },
        },
      );
      expect((cancelled as { error: Error }).error.message).toMatch(/Cancelado/);
      expect(await count(`select count(*)::int n from users`)).toBe(0);
      expect(MIN_BOOTSTRAP_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    });

    it('1. bootstrap tecnico correcto: cuenta activa con admin_tecnico, acta, token de ceremonia consumido y auditoria', async () => {
      const r = await run();
      expect((r as { error?: unknown }).error).toBeUndefined();
      const { value } = r as { value: { userId: string; domain: string; role: string } };
      expect(value).toMatchObject({ domain: 'technical', role: 'admin_tecnico' });
      expect(r.reader.calls).toBe(1);

      const user = (
        await h.q(
          `select email, status, account_domain, password_hash, password_changed_at from users where id = $1`,
          [value.userId],
        )
      ).rows[0]!;
      expect(user).toMatchObject({
        email: 'titular.tecnico@escuela.mx',
        status: 'active',
        account_domain: 'technical',
      });
      expect(user.password_changed_at).not.toBeNull();
      expect(await passwords.verify(user.password_hash as string, PW)).toBe(true); // la contrasena es la tecleada por la persona
      const role = (
        await h.q(
          `select r.key, ur.grant_source, ur.grant_reference, ur.granted_by from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`,
          [value.userId],
        )
      ).rows[0]!;
      expect(role).toEqual({
        key: 'admin_tecnico',
        grant_source: 'bootstrap',
        grant_reference: ACTA,
        granted_by: null,
      });
      const token = (
        await h.q(
          `select verification_method, authorized_by, used_at from auth_tokens where user_id = $1`,
          [value.userId],
        )
      ).rows[0]!;
      expect(token.verification_method).toBe('ceremony');
      expect(token.authorized_by).toBeNull();
      expect(token.used_at).not.toBeNull();
      expect(
        await count(
          `select count(*)::int n from audit_events where event_type = 'bootstrap.executed' and subject_user_id = $1`,
          [value.userId],
        ),
      ).toBe(1);
      expect(
        await count(
          `select count(*)::int n from audit_events where event_type = 'role.granted' and subject_user_id = $1`,
          [value.userId],
        ),
      ).toBe(1);
      expect(await count(`select count(*)::int n from sessions`)).toBe(0); // no abre sesion
    });

    it('2. NO FILTRA la contrasena: ni en tablas, ni en auditoria, ni en mensajes de error', async () => {
      for (const table of ['users', 'user_roles', 'auth_tokens', 'audit_events']) {
        const dump = (await h.q(`select string_agg(t::text, ' ') as d from ${table} t`)).rows[0]!
          .d as string | null;
        expect(dump ?? '').not.toContain(PW);
      }
      const dup = await run({ email: 'otra@escuela.mx' }); // dominio ya inicializado => error
      expect(String((dup as { error: Error }).error.message)).not.toContain(PW);
    });

    it('3. el bootstrap NO puede repetirse: el dominio queda cerrado para siempre', async () => {
      const again = await run({ email: 'segundo.titular@escuela.mx' });
      expect((again as { error: BootstrapError }).error).toMatchObject({
        code: 'already_initialized',
      });
      expect(again.reader.calls).toBe(0); // ni siquiera se pide la contrasena
      expect(await count(`select count(*)::int n from user_roles where domain = 'technical'`)).toBe(
        1,
      );
      // aunque se salte la comprobacion previa, la base lo rechaza (ultima defensa)
      await h.q(`delete from audit_events where false`);
      const forced = await h.q(
        `select count(*)::int n from user_roles where domain = 'technical' and grant_source = 'bootstrap'`,
      );
      expect(Number(forced.rows[0]!.n)).toBe(1);
    });

    it('4. bootstrap no autorizado: un rol que no es propietario es rechazado y no cambia nada', async () => {
      if (!h.api) return;
      const before = await count(`select count(*)::int n from users`);
      const r = await run(
        { domain: 'school', email: 'intruso@escuela.mx' },
        {
          procedures: {
            ...BOOTSTRAP_PROCEDURES,
            school: { ...BOOTSTRAP_PROCEDURES.school, approved: true },
          },
        },
        await h.api(),
      );
      expect((r as { error: BootstrapError }).error).toMatchObject({ code: 'not_owner' });
      expect(r.reader.calls).toBe(0);
      expect(await count(`select count(*)::int n from users`)).toBe(before);
    });

    it('5. correo ya existente: se revierte por completo (sin cuenta de mas, sin token, sin rol)', async () => {
      await h.q(
        `insert into users (email, display_name, account_domain, status) values ('ya.existe@escuela.mx', 'Existente', 'school', 'pending')`,
      );
      const procedures = {
        ...BOOTSTRAP_PROCEDURES,
        school: { ...BOOTSTRAP_PROCEDURES.school, approved: true },
      };
      const r = await run({ domain: 'school', email: 'ya.existe@escuela.mx' }, { procedures });
      expect((r as { error: BootstrapError }).error).toMatchObject({ code: 'email_taken' });
      expect(await count(`select count(*)::int n from user_roles where domain = 'school'`)).toBe(0);
      expect(
        await count(
          `select count(*)::int n from auth_tokens t join users u on u.id = t.user_id where u.email = 'ya.existe@escuela.mx'`,
        ),
      ).toBe(0);
    });

    it('6. dominio escolar con el procedimiento aprobado (SOLO simulacion de prueba): dos bootstraps simultaneos => exactamente uno', async () => {
      const procedures = {
        ...BOOTSTRAP_PROCEDURES,
        school: { ...BOOTSTRAP_PROCEDURES.school, approved: true },
      };
      const attempt = async (email: string) =>
        run(
          { domain: 'school', email, displayName: 'Direccion ficticia' },
          { procedures },
          await h.owner(),
        );
      const results = h.concurrent
        ? await Promise.all([attempt('a@escuela.mx'), attempt('b@escuela.mx')])
        : [await attempt('a@escuela.mx'), await attempt('b@escuela.mx')];
      const ok = results.filter((r) => !('error' in r));
      const failed = results.filter((r) => 'error' in r) as Array<{ error: BootstrapError }>;
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.error).toMatchObject({ code: 'already_initialized' });
      const rows = await h.q(
        `select r.key, u.account_domain from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id where ur.domain = 'school'`,
      );
      expect(rows.rows).toEqual([{ key: 'direccion', account_domain: 'school' }]);
      expect(
        await count(
          `select count(*)::int n from users where email in ('a@escuela.mx','b@escuela.mx')`,
        ),
      ).toBe(1);
    });
    it('limpieza', async () => {
      await teardown?.();
    });
  });
}
