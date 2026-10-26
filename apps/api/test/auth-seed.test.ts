import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, catalogProblems } from '../src/modules/access-control/catalog.js';
import { freshDb } from './helpers/pglite.js';

/** Semilla de roles y permisos (migracion 0005) en PGlite = PostgreSQL 18.6 en memoria. */
let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

describe('catalogo en codigo', () => {
  it('es internamente consistente (dominios, scopes admitidos, sin duplicados)', () => {
    expect(catalogProblems()).toEqual([]);
  });
  it('los roles iniciales son exactamente los cinco aprobados', () => {
    expect(ROLES.map((r) => r.key).sort()).toEqual(
      ['admin_tecnico', 'control_acceso', 'direccion', 'prefectura', 'trabajo_social'].sort(),
    );
  });
  it('admin_tecnico no tiene ningun permiso escolar y los roles escolares ninguno tecnico', () => {
    const domainOf = new Map(PERMISSIONS.map((p) => [p.key, p.domain]));
    for (const role of ROLES) {
      for (const grant of role.grants) {
        const d = domainOf.get(grant.permission);
        expect(d === 'shared' || d === role.domain, `${role.key} -> ${grant.permission}`).toBe(
          true,
        );
      }
    }
  });
  it('la politica de sesion coincide con la aprobada', () => {
    const by = Object.fromEntries(
      ROLES.map((r) => [r.key, [r.sessionIdleMinutes, r.sessionAbsoluteMinutes]]),
    );
    expect(by).toEqual({
      prefectura: [60, 720],
      trabajo_social: [60, 720],
      control_acceso: [60, 720],
      direccion: [30, 480],
      admin_tecnico: [15, 480],
    });
  });
  it('MFA es obligatorio para admin_tecnico y direccion', () => {
    expect(
      ROLES.filter((r) => r.requiresMfa)
        .map((r) => r.key)
        .sort(),
    ).toEqual(['admin_tecnico', 'direccion']);
  });
});

describe('semilla en la base (0005) = catalogo en codigo', () => {
  it('permisos', async () => {
    const r = await db.query<{ key: string; domain: string }>(
      `select key, domain from permissions order by key`,
    );
    expect(r.rows).toEqual(
      [...PERMISSIONS]
        .map((p) => ({ key: p.key, domain: p.domain }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  });
  it('roles con dominio, MFA y tiempos de sesion', async () => {
    const r = await db.query(
      `select key, domain, requires_mfa, session_idle_minutes, session_absolute_minutes, max_concurrent_sessions, is_system from roles order by key`,
    );
    expect(r.rows).toEqual(
      [...ROLES]
        .map((x) => ({
          key: x.key,
          domain: x.domain,
          requires_mfa: x.requiresMfa,
          session_idle_minutes: x.sessionIdleMinutes,
          session_absolute_minutes: x.sessionAbsoluteMinutes,
          max_concurrent_sessions: x.maxConcurrentSessions,
          is_system: true,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  });
  it('permisos de cada rol, con su alcance', async () => {
    const r = await db.query<{ role: string; permission: string; scope: string }>(
      `select r.key as role, p.key as permission, rp.scope from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id`,
    );
    const actual = r.rows.map((x) => `${x.role}|${x.permission}|${x.scope}`).sort();
    const expected = ROLES.flatMap((x) =>
      x.grants.map((g) => `${x.key}|${g.permission}|${g.scope}`),
    ).sort();
    expect(actual).toEqual(expected);
  });
  it('prefectura solo accede a alumnos y asistencia de sus grupos asignados', async () => {
    const r = await db.query<{ permission: string; scope: string }>(
      `select p.key as permission, rp.scope from role_permissions rp join roles r on r.id=rp.role_id
         join permissions p on p.id=rp.permission_id where r.key='prefectura' and p.domain='school'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.scope === 'assigned_groups')).toBe(true);
  });
  it('en la base, admin_tecnico no recibe permisos escolares', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id
        where r.key='admin_tecnico' and rp.permission_domain='school'`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
  it('NO siembra usuarios, sesiones, tokens ni eventos de auditoria', async () => {
    for (const t of ['users', 'user_roles', 'sessions', 'auth_tokens', 'audit_events']) {
      const r = await db.query<{ n: number }>(`select count(*)::int n from ${t}`);
      expect(r.rows[0]!.n, t).toBe(0);
    }
  });
  it('la semilla es idempotente: reaplicarla no cambia nada', async () => {
    const before = await db.query<{ n: number }>(
      `select (select count(*) from permissions)::int + (select count(*) from roles)::int + (select count(*) from role_permissions)::int n`,
    );
    const sql = readFileSync(
      join(import.meta.dirname, '..', 'drizzle', '0004_auth_seed_roles_permissions.sql'),
      'utf8',
    );
    for (const stmt of sql.split('--> statement-breakpoint')) await db.exec(stmt);
    const after = await db.query<{ n: number }>(
      `select (select count(*) from permissions)::int + (select count(*) from roles)::int + (select count(*) from role_permissions)::int n`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
