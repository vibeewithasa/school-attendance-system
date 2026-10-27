import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure } from './helpers/pglite.js';

/**
 * Migracion 0006 (politica RBAC del catalogo escolar) aplicada de forma INCREMENTAL sobre una base que ya tiene 0000-0005,
 * como ocurriria en eta15_dev. PGlite = PostgreSQL 18.6 en memoria; nunca toca eta15_dev.
 */
const dir = join(import.meta.dirname, '..', 'drizzle');
const migrations = readMigrationFiles({ migrationsFolder: dir });
let db: PGlite;
let before: string[] = [];
const allAssignments = async () =>
  (await matrix('%')).map((x) => `${x.role}|${x.permission}|${x.scope}`).sort();

const matrix = async (like = 'catalog:%') =>
  (
    await db.query<{ role: string; permission: string; scope: string }>(
      `select r.key as role, p.key as permission, rp.scope from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key like $1 order by 1, 2`,
      [like],
    )
  ).rows;
const auditCount = async () =>
  (await db.query<{ n: number }>(`select count(*)::int n from audit_events`)).rows[0]!.n;

beforeAll(async () => {
  db = new PGlite();
  expect(migrations).toHaveLength(7);
  for (const m of migrations.slice(0, 6)) for (const stmt of m.sql) await db.exec(stmt);
  before = await allAssignments();
  expect(before).toHaveLength(42);
});
afterAll(async () => {
  await db.close();
});

describe('0006: estado anterior (0000-0005)', () => {
  it('admin_tecnico administra el catalogo y los cinco roles lo leen; no existe el permiso escolar', async () => {
    const m = await matrix();
    expect(m).toContainEqual({ role: 'admin_tecnico', permission: 'catalog:manage', scope: 'all' });
    expect(m.filter((x) => x.permission === 'catalog:read')).toHaveLength(5);
    expect(m.some((x) => x.permission === 'catalog:manage_school')).toBe(false);
  });

  it('el esquema ya impide dar catalog:manage (tecnico) a Direccion: la correccion exige un permiso nuevo', async () => {
    const e = await failure(
      db.exec(`insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
        select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = 'direccion' and p.key = 'catalog:manage'`),
    );
    expect(e.message).toMatch(/domain_match/);
    // y el dominio de un permiso es inmutable: no se puede "reclasificar" catalog:manage
    const f = await failure(
      db.exec(`update permissions set domain = 'school' where key = 'catalog:manage'`),
    );
    expect(f.code).toBe('42501');
  });
});

describe('0006: aplicacion incremental', () => {
  it('se aplica sin errores y deja la politica propuesta: solo Direccion tiene permisos del catalogo', async () => {
    for (const stmt of migrations[6]!.sql) await db.exec(stmt);
    expect(await matrix()).toEqual([
      { role: 'direccion', permission: 'catalog:manage_school', scope: 'all' },
      { role: 'direccion', permission: 'catalog:read', scope: 'all' },
    ]);
    const p = await db.query<{ domain: string; is_authority: boolean }>(
      `select domain, is_authority from permissions where key = 'catalog:manage_school'`,
    );
    expect(p.rows).toEqual([{ domain: 'school', is_authority: false }]);
    // el permiso tecnico queda definido pero SIN asignar (reservado)
    expect(
      (await db.query(`select 1 from permissions where key = 'catalog:manage'`)).rows,
    ).toHaveLength(1);
  });

  it('diferencia exacta frente a 0000-0005: 1 alta y 5 bajas, nada mas', async () => {
    const after = await allAssignments();
    expect(after.filter((x) => !before.includes(x))).toEqual([
      'direccion|catalog:manage_school|all',
    ]);
    expect(before.filter((x) => !after.includes(x)).sort()).toEqual(
      [
        'admin_tecnico|catalog:manage|all',
        'admin_tecnico|catalog:read|all',
        'control_acceso|catalog:read|all',
        'prefectura|catalog:read|all',
        'trabajo_social|catalog:read|all',
      ].sort(),
    );
  });

  it('no toca nada mas: solo cambian las seis asignaciones; sin usuarios ni sesiones', async () => {
    const total = (await db.query<{ n: number }>(`select count(*)::int n from role_permissions`))
      .rows[0]!.n;
    // semilla 0004 = 42 asignaciones; 0006: -2 (admin_tecnico: manage y read) -3 (lectura) +1 (direccion) = 38
    expect(total).toBe(38);
    expect((await db.query(`select 1 from roles`)).rows).toHaveLength(5);
    for (const t of ['users', 'user_roles', 'sessions', 'auth_tokens'])
      expect((await db.query<{ n: number }>(`select count(*)::int n from ${t}`)).rows[0]!.n).toBe(
        0,
      );
    // prefectura conserva solo alcance assigned_groups
    const prefectura = (await matrix('%')).filter((x) => x.role === 'prefectura');
    expect(prefectura.length).toBeGreaterThan(0);
    expect(prefectura.every((x) => x.scope === 'assigned_groups')).toBe(true);
    // admin_tecnico sigue sin permisos escolares
    expect(
      (await matrix('%')).filter(
        (x) =>
          x.role === 'admin_tecnico' &&
          (x.permission.startsWith('students:') || x.permission.endsWith('_school')),
      ),
    ).toEqual([]);
  });

  it('deja auditoria de cada cambio de asignacion (1 alta y 5 bajas = 6 eventos) y ningun otro evento', async () => {
    const ev = await db.query<{ details: { role: string; permission: string; change: string } }>(
      `select details from audit_events where event_type = 'role.permissions_changed'`,
    );
    const lines = ev.rows
      .map((r) => `${r.details.change}|${r.details.role}|${r.details.permission}`)
      .sort();
    expect(lines).toEqual(
      [
        'add|direccion|catalog:manage_school',
        'remove|admin_tecnico|catalog:manage',
        'remove|admin_tecnico|catalog:read',
        'remove|control_acceso|catalog:read',
        'remove|prefectura|catalog:read',
        'remove|trabajo_social|catalog:read',
      ].sort(),
    );
    expect(await auditCount()).toBe(6);
  });

  it('es idempotente: reaplicarla no cambia asignaciones ni agrega auditoria', async () => {
    const before = JSON.stringify(await matrix('%'));
    for (const stmt of migrations[6]!.sql) await db.exec(stmt);
    expect(JSON.stringify(await matrix('%'))).toBe(before);
    expect(await auditCount()).toBe(6);
  });

  it('lleva la marca de migracion destructiva (solo bajas de asignaciones) y NO borra roles ni permisos', () => {
    const sql = readFileSync(join(dir, '0006_catalog_rbac_school_management.sql'), 'utf8');
    expect(sql.split('\n')[0]).toBe('-- eta15:allow-destructive');
    const stmts = sql.replace(/^--.*$/gm, '');
    expect(stmts).not.toMatch(/\b(DROP|TRUNCATE|ALTER)\b/i);
    expect(stmts).not.toMatch(/DELETE\s+FROM\s+"(roles|permissions|users|sessions|audit_events)"/i);
    expect((stmts.match(/DELETE\s+FROM\s+"role_permissions"/gi) ?? []).length).toBe(2);
    expect((stmts.match(/\bDELETE\b/gi) ?? []).length).toBe(2); // ningun otro borrado
  });
});

describe('0006: despues de aplicada', () => {
  it('seguridad intacta: el dominio sigue sin poder mezclarse y los permisos no se editan', async () => {
    const tech = await failure(
      db.exec(`insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
        select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = 'admin_tecnico' and p.key = 'catalog:manage_school'`),
    );
    expect(tech.message).toMatch(/domain_match/);
    const upd = await failure(db.exec(`update role_permissions set scope = 'own'`));
    expect(upd.code).toBe('42501');
    const dom = await failure(
      db.exec(`update permissions set domain = 'technical' where key = 'catalog:manage_school'`),
    );
    expect(dom.code).toBe('42501');
  });
});
