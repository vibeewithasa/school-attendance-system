import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

/**
 * Migracion 0008 (politica RBAC de alumnos, cerrada por defecto) aplicada de forma INCREMENTAL sobre 0000-0007. PGlite = PostgreSQL
 * 18.6 en memoria; sin datos reales. Nunca toca eta15_dev.
 */
const dir = join(import.meta.dirname, '..', 'drizzle');
const migrations = readMigrationFiles({ migrationsFolder: dir });

async function dbUntil(count: number): Promise<PGlite> {
  const d = new PGlite({ extensions: { btree_gist } });
  for (const m of migrations.slice(0, count)) for (const stmt of m.sql) await d.exec(stmt);
  return d;
}

const matrix = async (d: PGlite) =>
  (
    await d.query<{ role: string; permission: string; scope: string }>(
      `select r.key as role, p.key as permission, rp.scope from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key like 'students:%' or p.key like 'enrollments:%' order by 1, 2`,
    )
  ).rows.map((x) => `${x.role}|${x.permission}|${x.scope}`);
const count = async (d: PGlite, table: string) =>
  Number((await d.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0]!.n);

describe('0008: politica RBAC de alumnos', () => {
  it('el journal ordena 0007 y 0008 y 0008 lleva la marca destructiva limitada a sus DELETE', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(11); // 0008 y las posteriores
    const sql = migrations[8]!.sql
      .join('\n')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql.match(/DELETE FROM/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bALTER\b|\bINSERT\b|\bUPDATE\b/i);
  });

  it('antes de aplicarla la semilla 0004 deja a trabajo social y control de acceso con lectura GLOBAL (la brecha)', async () => {
    const d = await dbUntil(8);
    const m = await matrix(d);
    expect(m).toContain('trabajo_social|students:read|all');
    expect(m).toContain('trabajo_social|students:read_basic|all');
    expect(m).toContain('control_acceso|students:read_basic|all');
    await d.close();
  });

  it('retira exactamente 3 asignaciones, deja 3 eventos de auditoria, no toca nada mas y es idempotente', async () => {
    const d = await dbUntil(8);
    const before = await matrix(d);
    const a0 = await count(d, 'audit_events');
    const rpBefore = await count(d, 'role_permissions');
    const permsBefore = await count(d, 'permissions');
    expect([rpBefore, permsBefore, a0]).toEqual([38, 27, 6]);

    for (const stmt of migrations[8]!.sql) await d.exec(stmt);
    const after = await matrix(d);
    expect(before.filter((x) => !after.includes(x)).sort()).toEqual(
      [
        'control_acceso|students:read_basic|all',
        'trabajo_social|students:read|all',
        'trabajo_social|students:read_basic|all',
      ].sort(),
    );
    expect(after.filter((x) => !before.includes(x))).toEqual([]);
    expect(after).toEqual([
      'direccion|enrollments:manage|all',
      'direccion|students:manage|all',
      'direccion|students:read|all',
      'direccion|students:read_basic|all',
      'prefectura|students:read|assigned_groups',
      'prefectura|students:read_basic|assigned_groups',
    ]);
    expect(await count(d, 'role_permissions')).toBe(35);
    expect(await count(d, 'permissions')).toBe(27); // los permisos siguen definidos
    expect(await count(d, 'audit_events')).toBe(a0 + 3);
    const changes = await d.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type = 'role.permissions_changed'`,
    );
    expect(changes.rows[0]!.n).toBe(9); // 6 de 0006 + 3 de 0008

    // Idempotente: repetir las sentencias no cambia ni la matriz ni la auditoria.
    for (const stmt of migrations[8]!.sql) await d.exec(stmt);
    expect(await matrix(d)).toEqual(after);
    expect(await count(d, 'audit_events')).toBe(a0 + 3);
    await d.close();
  });

  it('no autoescala: el resto de la matriz (catalogo, personal, tecnico) permanece igual', async () => {
    const d = await dbUntil(8);
    const all = async () =>
      (
        await d.query<{ k: string }>(
          `select r.key || '|' || p.key || '|' || rp.scope as k from role_permissions rp
             join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
            where p.key not like 'students:%' order by 1`,
        )
      ).rows.map((x) => x.k);
    const before = await all();
    for (const stmt of migrations[8]!.sql) await d.exec(stmt);
    expect(await all()).toEqual(before);
    await d.close();
  });

  it('admin_tecnico jamas puede recibir permisos de alumnos: lo impide el esquema (dominio)', async () => {
    const d = await dbUntil(9);
    const e = await d
      .exec(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = 'admin_tecnico' and p.key = 'students:read'`,
      )
      .then(() => null)
      .catch((x: { message: string }) => x.message);
    expect(e).toMatch(/domain_match/);
    await d.close();
  });

  it('la verificacion final revierte la migracion si falta la asignacion de Direccion', async () => {
    const d = await dbUntil(8);
    await d.exec(
      `delete from role_permissions rp using roles r, permissions p
        where rp.role_id = r.id and rp.permission_id = p.id and r.key = 'direccion' and p.key = 'students:manage'`,
    );
    const err = await d
      .exec(migrations[8]!.sql.join('\n'))
      .then(() => null)
      .catch((x: { message: string }) => x.message);
    expect(err).toMatch(/0008: direccion debe conservar/);
    await d.close();
  });
});
