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
    // Alumnos y asistencia: solo de sus grupos asignados; sus propias asignaciones (0009) y sus propios dispositivos moviles
    // (0011): alcance own.
    const OWN = new Set(['prefect_assignments:read', 'mobile_devices:enroll']);
    expect(
      r.rows.every((x) =>
        OWN.has(x.permission) ? x.scope === 'own' : x.scope === 'assigned_groups',
      ),
    ).toBe(true);
    expect(r.rows.map((x) => x.permission)).not.toContain('students:read');
  });
  it('en la base, admin_tecnico no recibe permisos escolares', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id
        where r.key='admin_tecnico' and rp.permission_domain='school'`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
  it('NO siembra usuarios, sesiones ni tokens; la unica auditoria es la de las altas/bajas de 0006, 0008, 0009, 0010 y 0011', async () => {
    for (const t of ['users', 'user_roles', 'sessions', 'auth_tokens']) {
      const r = await db.query<{ n: number }>(`select count(*)::int n from ${t}`);
      expect(r.rows[0]!.n, t).toBe(0);
    }
    const audit = await db.query<{ event_type: string; actor_user_id: string | null }>(
      `select event_type, actor_user_id from audit_events`,
    );
    // 0006 (politica del catalogo): 1 alta (direccion) + 5 bajas (2 de admin_tecnico y 3 roles escolares); 0008 (alumnos): 3 bajas;
    // 0009 (prefectura): 3 altas (2 de direccion, 1 de prefectura) + 1 baja (students:read de prefectura);
    // 0010 (asistencia): 1 baja (attendance:read global de trabajo_social);
    // 0011 (autenticacion movil, prototipo): 2 altas (mobile_devices:manage de direccion y :enroll de prefectura); todas sin actor
    expect(audit.rows).toHaveLength(16);
    expect(
      audit.rows.every(
        (x) => x.event_type === 'role.permissions_changed' && x.actor_user_id === null,
      ),
    ).toBe(true);
  });
  it('la cadena de semilla (0004 + 0006 + 0008 + 0009 + 0010 + 0011) es idempotente: reaplicarla no cambia nada', async () => {
    const count = () =>
      db.query<{ n: number }>(
        `select (select count(*) from permissions)::int + (select count(*) from roles)::int + (select count(*) from role_permissions)::int n`,
      );
    const before = await count();
    for (const file of [
      '0004_auth_seed_roles_permissions.sql',
      '0006_catalog_rbac_school_management.sql',
      '0008_students_rbac_policy.sql',
      '0009_prefect_group_assignments.sql',
      '0010_daily_attendance.sql',
      '0011_mobile_device_auth.sql',
    ]) {
      const sql = readFileSync(join(import.meta.dirname, '..', 'drizzle', file), 'utf8');
      // 0009 y 0010 mezclan DDL (no repetible) y la parte RBAC (idempotente): solo se repite la ultima.
      const statements = sql.split('--> statement-breakpoint');
      const from = file.startsWith('0009')
        ? statements.findIndex((x) => x.includes('INSERT INTO "permissions"'))
        : file.startsWith('0010')
          ? statements.findIndex((x) => x.includes('DELETE FROM "role_permissions"'))
          : file.startsWith('0011')
            ? statements.findIndex((x) => x.includes('INSERT INTO "permissions"'))
            : 0;
      for (const stmt of statements.slice(from)) await db.exec(stmt);
    }
    const after = await count();
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
