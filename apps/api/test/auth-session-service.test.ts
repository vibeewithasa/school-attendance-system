import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSessionService,
  hashSessionToken,
  type SessionService,
} from '../src/modules/auth/session-service.js';
import { addUser, bootstrap, createApiRole, grant, revoke } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { pgliteStore } from './helpers/session-stores.js';

/**
 * Servicio de sesiones sobre el esquema REAL (migraciones 0000-0005 en PGlite = motor PG 18), ejecutado como un rol
 * no propietario. Reloj inyectado para caducidades. Usuarios y actas FICTICIOS. La concurrencia real (varias
 * conexiones) y los privilegios exactos de eta15_api se prueban en test/pgtemp/session-service.pg.test.ts.
 */

const MIN = 60_000;
const sha256 = (token: string) =>
  createHash('sha256').update(Buffer.from(token, 'base64url')).digest();

let db: PGlite;
let boss: string; // direccion (school) por acta
let tech: string; // admin_tecnico (technical) por acta
let seq = 0;
const email = () => `persona-${++seq}@escuela.mx`;

/** Usuario escolar con el rol dado concedido por el titular. */
async function staff(roleKey = 'prefectura'): Promise<string> {
  const id = await addUser(db, email(), 'school');
  await grant(db, id, roleKey, boss);
  return id;
}

let clock = new Date();
const service = (opts: { touchIntervalMs?: number } = {}): SessionService =>
  createSessionService({ store: pgliteStore(db, 'api_runtime'), clock: () => clock, ...opts });
let svc: SessionService;

const row = async (token: string) =>
  (
    await db.query<Record<string, unknown>>(
      `select id, user_id, last_seen_at, expires_at, idle_expires_at, revoked_at, revoked_reason, revoked_by, created_at
         from sessions where token_hash = $1`,
      [sha256(token)],
    )
  ).rows[0]!;

async function open(userId: string, over: Record<string, unknown> = {}) {
  const r = await svc.create({ userId, ...over });
  if (!r.ok) throw new Error(`no se pudo crear la sesion: ${r.reason}`);
  return r;
}

beforeAll(async () => {
  db = await freshDb();
  await createApiRole(db);
  boss = await addUser(db, 'direccion@escuela.mx', 'school');
  await bootstrap(db, boss, 'direccion');
  tech = await addUser(db, 'tecnico@escuela.mx', 'technical');
  await bootstrap(db, tech, 'admin_tecnico', 'ACTA-TEC-001');
}, 120_000);
afterAll(async () => {
  await db.close();
});

describe('hashSessionToken', () => {
  it('acepta solo tokens canonicos de 256 bits en base64url', () => {
    const good = Buffer.alloc(32, 1).toString('base64url');
    expect(good).toHaveLength(43);
    expect(hashSessionToken(good)).toEqual(sha256(good));
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'abc',
      good + 'A',
      good.slice(1),
      good.replace(/.$/, '='),
      good.slice(0, 42) + '+', // alfabeto base64 estandar, no base64url
      good.slice(0, 42) + 'B', // ultimo caracter con bits de relleno distintos de cero: no canonico
    ]) {
      expect(hashSessionToken(bad)).toBeNull();
    }
  });
});

describe('crear sesiones', () => {
  it('devuelve un token opaco de 256 bits y guarda SOLO su SHA-256', async () => {
    svc = service();
    clock = new Date();
    const id = await staff();
    const { token, session } = await open(id, {
      clientType: 'android',
      ip: '192.168.1.20',
      userAgent: 'x'.repeat(400),
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session).toMatchObject({ userId: id, clientType: 'android', mfaVerifiedAt: null });

    const stored = await db.query<{ token_hash: Uint8Array; ip: string; ua: number; dump: string }>(
      `select token_hash, host(ip) as ip, char_length(user_agent) as ua, s::text as dump from sessions s where id = $1`,
      [session.id],
    );
    const r = stored.rows[0]!;
    expect(Buffer.from(r.token_hash).equals(sha256(token))).toBe(true);
    expect(r.ip).toBe('192.168.1.20');
    expect(r.ua).toBe(256);
    expect(r.dump).not.toContain(token); // el token en claro no esta en ninguna columna
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it('tokens distintos en cada sesion', async () => {
    const id = await staff();
    const tokens = new Set<string>();
    for (let i = 0; i < 4; i++) tokens.add((await open(id)).token);
    expect(tokens.size).toBe(4);
  });

  it.each([
    ['prefectura', 60, 720],
    ['trabajo_social', 60, 720],
    ['direccion', 30, 480],
  ])(
    'politica de %s: %i min de inactividad y %i min absolutos',
    async (roleKey, idle, absolute) => {
      clock = new Date(Date.now() + 1000 * 3600);
      const id = roleKey === 'direccion' ? boss : await staff(roleKey);
      const { session } = await open(id, { mfaVerified: roleKey === 'direccion' });
      expect(session.idleExpiresAt.getTime() - clock.getTime()).toBe(idle * MIN);
      expect(session.expiresAt.getTime() - clock.getTime()).toBe(absolute * MIN);
    },
  );

  it('administrador tecnico: 15 min de inactividad y 8 h absolutas', async () => {
    const { session } = await open(tech, { mfaVerified: true });
    expect(session.idleExpiresAt.getTime() - clock.getTime()).toBe(15 * MIN);
    expect(session.expiresAt.getTime() - clock.getTime()).toBe(480 * MIN);
  });

  it('registra la verificacion MFA solo si se indica', async () => {
    const id = await staff();
    expect((await open(id)).session.mfaVerifiedAt).toBeNull();
    expect((await open(id, { mfaVerified: true })).session.mfaVerifiedAt).toEqual(clock);
  });

  it('rechaza cuentas inexistentes, pendientes, deshabilitadas, bloqueadas o sin roles', async () => {
    const pending = await addUser(db, email(), 'school', 'pending');
    const disabled = await staff();
    await db.query(`update users set status='disabled' where id=$1`, [disabled]);
    const locked = await staff();
    await db.query(`update users set locked_until = $2 where id=$1`, [
      locked,
      new Date(clock.getTime() + 5 * MIN),
    ]);
    const noRoles = await addUser(db, email(), 'school');

    expect(await svc.create({ userId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      ok: false,
      reason: 'account_inactive',
    });
    expect(await svc.create({ userId: pending })).toEqual({
      ok: false,
      reason: 'account_inactive',
    });
    expect(await svc.create({ userId: disabled })).toEqual({
      ok: false,
      reason: 'account_inactive',
    });
    expect(await svc.create({ userId: locked })).toEqual({ ok: false, reason: 'account_locked' });
    expect(await svc.create({ userId: noRoles })).toEqual({ ok: false, reason: 'no_active_roles' });
    // y ninguno dejo sesiones
    const n = await db.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id = any($1)`,
      [[pending, disabled, locked, noRoles]],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('el bloqueo temporal vence con el tiempo', async () => {
    const id = await staff();
    await db.query(`update users set locked_until = $2 where id=$1`, [
      id,
      new Date(clock.getTime() + 5 * MIN),
    ]);
    expect((await svc.create({ userId: id })).ok).toBe(false);
    const saved = clock;
    clock = new Date(clock.getTime() + 6 * MIN);
    expect((await svc.create({ userId: id })).ok).toBe(true);
    clock = saved;
  });
});

describe('MFA obligatorio (sin sesiones parciales)', () => {
  it('direccion y admin_tecnico no obtienen sesion sin segundo factor verificado', async () => {
    clock = new Date();
    expect(await svc.create({ userId: boss })).toEqual({ ok: false, reason: 'mfa_required' });
    expect(await svc.create({ userId: tech })).toEqual({ ok: false, reason: 'mfa_required' });
    const n = await db.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id = any($1) and revoked_at is null and mfa_verified_at is null`,
      [[boss, tech]],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('una sesion SIN mfa_verified_at no autoriza si el rol lo exige (aunque exista en la base)', async () => {
    clock = new Date();
    const id = await staff('prefectura');
    const { token, session } = await open(id);
    // simula una sesion previa al cambio de politica: el rol pasa a exigir MFA y la sesion no lo tiene verificado
    await db.exec(`alter table roles disable trigger roles_guard`);
    await db.exec(`alter table roles disable trigger roles_audit_update`);
    try {
      await db.exec(`update roles set requires_mfa = true where key = 'prefectura'`);
      expect(await svc.verify(token)).toEqual({ ok: false, reason: 'mfa_required' });
      await db.query(`update sessions set mfa_verified_at = now() where id = $1`, [session.id]);
      expect((await svc.verify(token)).ok).toBe(true);
    } finally {
      await db.exec(`update roles set requires_mfa = false where key = 'prefectura'`);
      await db.exec(`alter table roles enable trigger roles_guard`);
      await db.exec(`alter table roles enable trigger roles_audit_update`);
    }
  });
});
describe('verificar sesiones', () => {
  it('token valido: devuelve cuenta, roles y permisos vigentes (scope incluido)', async () => {
    clock = new Date();
    const id = await staff('prefectura');
    const { token } = await open(id);
    const v = await svc.verify(token);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.user).toEqual({ id, accountDomain: 'school', mustChangePassword: false });
    expect(v.roles).toEqual(['prefectura']);
    expect(v.grants.length).toBeGreaterThan(0);
    expect(v.grants.every((g) => ['all', 'assigned_groups', 'own'].includes(g.scope))).toBe(true);
    // Sin duplicados
    expect(new Set(v.grants.map((g) => `${g.permission}|${g.scope}`)).size).toBe(v.grants.length);
    // Una prefectura no tiene permisos de autoridad
    expect(
      v.grants.some(
        (g) => g.permission.startsWith('users:manage') || g.permission.startsWith('roles:'),
      ),
    ).toBe(false);
    // La respuesta jamas incluye el token ni su hash
    const dump = JSON.stringify(v);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sha256(token).toString('hex'));
  });

  it.each([undefined, null, '', 'no-es-un-token', 'A'.repeat(43), 12345])(
    'token invalido o desconocido (%s) => invalid_token',
    async (bad) => {
      expect(await svc.verify(bad)).toEqual({ ok: false, reason: 'invalid_token' });
    },
  );

  it('direccion recibe permisos de autoridad; prefectura no', async () => {
    const { token } = await open(boss, { mfaVerified: true });
    const v = await svc.verify(token);
    expect(v.ok && v.grants.some((g) => g.permission === 'users:manage_school')).toBe(true);
  });

  it('caduca por inactividad y por tiempo absoluto', async () => {
    const t0 = new Date();
    clock = t0;
    const id = await staff();
    const { token } = await open(id);
    clock = new Date(t0.getTime() + 59 * MIN);
    expect((await svc.verify(token, { touch: false })).ok).toBe(true);
    clock = new Date(t0.getTime() + 61 * MIN);
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'idle_expired' });
    clock = new Date(t0.getTime() + 13 * 60 * MIN);
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'absolute_expired' });
    clock = t0;
  });

  it('la actividad renueva la inactividad pero nunca supera la caducidad absoluta', async () => {
    const t0 = new Date();
    clock = t0;
    const id = await staff();
    const { token, session } = await open(id);
    for (let m = 50; m <= 700; m += 50) {
      clock = new Date(t0.getTime() + m * MIN);
      expect((await svc.verify(token)).ok).toBe(true);
    }
    const r = await row(token);
    expect((r.idle_expires_at as Date).getTime()).toBe(session.expiresAt.getTime()); // topado por la absoluta
    expect((r.idle_expires_at as Date).getTime()).toBeLessThanOrEqual(
      (r.expires_at as Date).getTime(),
    );
    clock = new Date(t0.getTime() + 721 * MIN);
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'absolute_expired' });
    clock = t0;
  });

  it('solo escribe last_seen_at si paso el intervalo; touch:false no escribe', async () => {
    const t0 = new Date();
    clock = t0;
    const quiet = service({ touchIntervalMs: 30_000 });
    const id = await staff();
    const { token } = await open(id);
    const first = (await row(token)).last_seen_at as Date;
    clock = new Date(t0.getTime() + 10_000);
    await quiet.verify(token);
    expect((await row(token)).last_seen_at).toEqual(first); // dentro del intervalo
    clock = new Date(t0.getTime() + 40_000);
    await quiet.verify(token, { touch: false });
    expect((await row(token)).last_seen_at).toEqual(first); // solo lectura
    await quiet.verify(token);
    expect((await row(token)).last_seen_at).toEqual(clock);
    clock = t0;
  });
});

describe('revocacion', () => {
  it('cierre de sesion individual: idempotente y no afecta a otras sesiones', async () => {
    clock = new Date();
    const id = await staff();
    const a = await open(id);
    const b = await open(id);
    expect(await svc.revokeByToken(a.token)).toBe(true);
    expect(await svc.revokeByToken(a.token)).toBe(false);
    expect(await svc.revokeByToken('basura')).toBe(false);
    expect(await svc.verify(a.token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await svc.verify(b.token)).ok).toBe(true);
    expect((await row(a.token)).revoked_reason).toBe('logout');
  });

  it('revocacion por id registra motivo y autor', async () => {
    const id = await staff();
    const { token, session } = await open(id);
    expect(await svc.revokeSession(session.id, { reason: 'admin', by: boss })).toBe(true);
    const r = await row(token);
    expect(r.revoked_reason).toBe('admin');
    expect(r.revoked_by).toBe(boss);
    expect(await svc.revokeSession(session.id)).toBe(false);
    await expect(svc.revokeSession(session.id, { reason: 'inventado' as never })).rejects.toThrow(
      'Motivo',
    );
  });

  it('revocacion global de un usuario (con excepcion opcional) sin tocar a otros', async () => {
    const id = await staff();
    const other = await staff();
    const tokens = [await open(id), await open(id), await open(id)];
    const otherSession = await open(other);
    expect(
      await svc.revokeAllForUser(id, {
        reason: 'admin',
        by: boss,
        exceptSessionId: tokens[0]!.session.id,
      }),
    ).toBe(2);
    expect((await svc.verify(tokens[0]!.token)).ok).toBe(true);
    expect((await svc.verify(tokens[1]!.token)).ok).toBe(false);
    expect((await svc.verify(otherSession.token)).ok).toBe(true);
    expect(await svc.revokeAllForUser(id)).toBe(1);
    expect(await svc.revokeAllForUser(id)).toBe(0);
    expect(await svc.verify(tokens[0]!.token)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('cambios de cuenta, contrasena y roles', () => {
  it('deshabilitar la cuenta invalida sus sesiones (motivo disabled)', async () => {
    const id = await staff();
    const { token } = await open(id);
    await db.query(`update users set status='disabled' where id=$1`, [id]);
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await row(token)).revoked_reason).toBe('disabled');
  });

  it('cambiar la contrasena invalida las sesiones (motivo password_changed) y la nueva sesion funciona', async () => {
    const id = await staff();
    const old = await open(id);
    await db.query(
      `update users set password_hash='otro-hash-ficticio', password_changed_at = now() where id=$1`,
      [id],
    );
    expect(await svc.verify(old.token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await row(old.token)).revoked_reason).toBe('password_changed');
    clock = new Date(Date.now() + 1000);
    const fresh = await open(id);
    expect((await svc.verify(fresh.token)).ok).toBe(true);
  });

  it('defensa adicional: aunque el trigger no hubiera revocado, password_changed_at posterior invalida la sesion', async () => {
    clock = new Date();
    const id = await staff();
    const { token } = await open(id);
    await db.exec(`alter table users disable trigger users_revoke_sessions_on_password`);
    try {
      await db.query(
        `update users set password_hash='otro-hash-ficticio', password_changed_at = now() + interval '1 second' where id=$1`,
        [id],
      );
    } finally {
      await db.exec(`alter table users enable trigger users_revoke_sessions_on_password`);
    }
    expect((await row(token)).revoked_at).toBeNull();
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'password_changed' });
  });

  it('cuenta bloqueada: la sesion existente deja de ser valida mientras dure el bloqueo', async () => {
    clock = new Date();
    const id = await staff();
    const { token } = await open(id);
    await db.query(`update users set locked_until = $2 where id=$1`, [
      id,
      new Date(clock.getTime() + 10 * MIN),
    ]);
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'account_locked' });
    await db.query(`update users set locked_until = null where id=$1`, [id]);
    expect((await svc.verify(token)).ok).toBe(true);
  });

  it('revocar un rol invalida las sesiones (roles_changed); sin roles vigentes no se puede abrir otra', async () => {
    clock = new Date();
    const id = await staff('prefectura');
    const { token } = await open(id);
    await revoke(db, id, 'prefectura', boss);
    expect(await svc.verify(token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await row(token)).revoked_reason).toBe('roles_changed');
    expect(await svc.create({ userId: id })).toEqual({ ok: false, reason: 'no_active_roles' });
    await grant(db, id, 'trabajo_social', boss);
    const again = await open(id);
    const v = await svc.verify(again.token);
    expect(v.ok && v.roles).toEqual(['trabajo_social']);
  });

  it('los permisos se revalidan en cada peticion (cambios en el catalogo se ven de inmediato)', async () => {
    clock = new Date();
    const id = await staff('control_acceso');
    const { token } = await open(id);
    const before = await svc.verify(token);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const victim = before.grants[0]!;
    await db.query(
      `delete from role_permissions rp using roles r, permissions p
        where rp.role_id = r.id and rp.permission_id = p.id and r.key = 'control_acceso' and p.key = $1`,
      [victim.permission],
    );
    try {
      const after = await svc.verify(token);
      expect(after.ok && after.grants.some((g) => g.permission === victim.permission)).toBe(false);
    } finally {
      await db.query(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, $2 from roles r, permissions p where r.key='control_acceso' and p.key=$1`,
        [victim.permission, victim.scope],
      );
    }
  });

  it('una politica mas estricta del rol se aplica a sesiones ya abiertas (sin esperar a revocarlas)', async () => {
    clock = new Date();
    const id = await staff('prefectura');
    const { token } = await open(id);
    // El propietario endurece la politica del rol (migracion): 60 -> 30 min de inactividad.
    await db.exec(`alter table roles disable trigger roles_guard`);
    await db.exec(`alter table roles disable trigger roles_audit_update`);
    try {
      await db.exec(`update roles set session_idle_minutes = 30 where key = 'prefectura'`);
      clock = new Date(clock.getTime() + 40 * MIN); // la sesion se guardo con 60 min, pero la politica vigente permite 30
      expect(await svc.verify(token)).toEqual({ ok: false, reason: 'idle_expired' });
    } finally {
      await db.exec(`update roles set session_idle_minutes = 60 where key = 'prefectura'`);
      await db.exec(`alter table roles enable trigger roles_guard`);
      await db.exec(`alter table roles enable trigger roles_audit_update`);
      clock = new Date();
    }
  });
});
describe('sesiones concurrentes', () => {
  it('maximo 5 vigentes: al crear la sexta se revoca la mas antigua (motivo concurrency)', async () => {
    const id = await staff();
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      clock = new Date(Date.now() + i * 1000);
      created.push((await open(id)).token);
    }
    const active = await db.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
      [id],
    );
    expect(active.rows[0]!.n).toBe(5);
    expect(await svc.verify(created[0]!)).toEqual({ ok: false, reason: 'revoked' });
    expect(await svc.verify(created[1]!)).toEqual({ ok: false, reason: 'revoked' });
    expect((await row(created[0]!)).revoked_reason).toBe('concurrency');
    for (const t of created.slice(2)) expect((await svc.verify(t)).ok).toBe(true);
  });
});

describe('sin fuga de secretos', () => {
  it('ninguna fila de auditoria ni de otra tabla contiene un token en claro', async () => {
    const id = await staff();
    const { token } = await open(id);
    await svc.revokeByToken(token);
    for (const table of ['sessions', 'audit_events', 'users', 'user_roles']) {
      const r = await db.query<{ hit: number }>(
        `select count(*)::int hit from ${table} t where t::text like $1`,
        [`%${token}%`],
      );
      expect(r.rows[0]!.hit).toBe(0);
    }
  });
});
