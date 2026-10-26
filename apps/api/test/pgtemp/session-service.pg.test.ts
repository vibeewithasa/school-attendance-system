import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSessionService,
  type SessionService,
} from '../../src/modules/auth/session-service.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { applyMigrations, startTempPostgres, type TempPostgres } from '../helpers/pg-temp.js';

/**
 * Servicio de sesiones contra PostgreSQL 18 REAL desechable, con la disposicion de roles real:
 * base `eta15_dev` de `eta15_app` y la API conectada como `eta15_api` con EXACTAMENTE los privilegios de la
 * propuesta (tools/db/proposals/eta15_api-roles.proposal.sql). Varias conexiones simultaneas del pool.
 * No toca el eta15_dev real: los usuarios son filas ficticias de un clúster temporal que se destruye al terminar.
 */

let pgt: TempPostgres;
let superuser: pg.Client;
let owner: pg.Client; // eta15_app
let pool: pg.Pool; // eta15_api
let svc: SessionService;
let boss: string;

const proposal = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'tools',
    'db',
    'proposals',
    'eta15_api-roles.proposal.sql',
  ),
  'utf8',
);
const step = (name: 'PASO 1' | 'PASO 2' | 'PASO 3') =>
  proposal
    .split(/^-- ===== /m)
    .find((s) => s.startsWith(name))!
    .split('\n')
    .slice(1)
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\'))
    .join('\n')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);

const FAKE = 'hash-ficticio-de-prueba';
let seq = 0;
const sha256 = (token: string) =>
  createHash('sha256').update(Buffer.from(token, 'base64url')).digest();

async function addStaff(roleKey = 'prefectura'): Promise<string> {
  const r = await owner.query<{ id: string }>(
    `insert into users (email, display_name, account_domain, status, password_hash)
     values ($1,'Persona de prueba','school','active',$2) returning id`,
    [`persona-${++seq}@escuela.mx`, FAKE],
  );
  const id = r.rows[0]!.id;
  await owner.query(
    `insert into user_roles (user_id, role_id, domain, granted_by, grant_source)
     select $1, r.id, r.domain, $3, 'grant' from roles r where r.key = $2`,
    [id, roleKey, boss],
  );
  return id;
}
const activeCount = async (userId: string) =>
  (
    await owner.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null`,
      [userId],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  pgt = await startTempPostgres();
  superuser = await pgt.connect();
  await superuser.query(`create role eta15_app login`);
  await superuser.query(`create database eta15_dev owner eta15_app`);
  owner = await pgt.connect('eta15_app', 'eta15_dev');
  await applyMigrations(owner);
  for (const stmt of step('PASO 1')) await superuser.query(stmt);
  for (const stmt of step('PASO 2')) await owner.query(stmt);
  for (const stmt of step('PASO 3')) await superuser.query(stmt);

  pool = new pg.Pool({
    host: '127.0.0.1',
    port: pgt.port,
    user: 'eta15_api',
    database: 'eta15_dev',
    max: 20,
  });
  svc = createSessionService({ store: createPgSessionStore(pool) });

  // Titular escolar (acta ficticia) como propietario: la API no puede autoconcederse autoridad.
  const b = await owner.query<{ id: string }>(
    `insert into users (email, display_name, account_domain, status, password_hash)
     values ('direccion@escuela.mx','Titular de prueba','school','active',$1) returning id`,
    [FAKE],
  );
  boss = b.rows[0]!.id;
  await owner.query(
    `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
     select $1, r.id, r.domain, null, 'bootstrap', 'ACTA-PRUEBA-001' from roles r where r.key='direccion'`,
    [boss],
  );
}, 240_000);
afterAll(async () => {
  await pool?.end();
  await pgt?.stop();
}, 60_000);

describe('con los privilegios EXACTOS de eta15_api', () => {
  it('conecta como eta15_api (no propietario) y el flujo completo funciona', async () => {
    const who = await pool.query<{ u: string }>(`select current_user as u`);
    expect(who.rows[0]!.u).toBe('eta15_api');

    const id = await addStaff();
    const created = await svc.create({ userId: id, ip: '10.0.0.5', userAgent: 'prueba' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const v = await svc.verify(created.token);
    expect(v.ok && v.roles).toEqual(['prefectura']);
    expect(await svc.revokeByToken(created.token)).toBe(true);
    expect(await svc.verify(created.token)).toEqual({ ok: false, reason: 'revoked' });
    const stored = await owner.query<{ h: Buffer; dump: string }>(
      `select token_hash as h, s::text as dump from sessions s where id=$1`,
      [created.session.id],
    );
    expect(stored.rows[0]!.h.equals(sha256(created.token))).toBe(true);
    expect(stored.rows[0]!.dump).not.toContain(created.token);
  });

  it('la API no puede alterar token, usuario ni caducidad absoluta de una sesion (privilegio por columna)', async () => {
    const id = await addStaff();
    const created = await svc.create({ userId: id });
    if (!created.ok) throw new Error('no se creo');
    const denied = async (sql: string, params: unknown[] = []) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(sql, params);
        return 'permitido';
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    expect(
      await denied(`update sessions set token_hash = $1 where id = $2`, [
        Buffer.alloc(32, 9),
        created.session.id,
      ]),
    ).toBe('42501');
    expect(
      await denied(`update sessions set user_id = $1 where id = $2`, [boss, created.session.id]),
    ).toBe('42501');
    expect(
      await denied(
        `update sessions set expires_at = expires_at + interval '30 days' where id = $1`,
        [created.session.id],
      ),
    ).toBe('42501');
    expect(
      await denied(`update sessions set last_seen_at = now() where id = $1`, [created.session.id]),
    ).toBe('permitido');
  });
});

describe('concurrencia real (varias conexiones)', () => {
  it('12 inicios de sesion simultaneos del mismo usuario => exactamente 5 vigentes y 7 revocadas por concurrency', async () => {
    const id = await addStaff();
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.create({ userId: id })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await activeCount(id)).toBe(5);
    const r = await owner.query<{ reason: string | null; n: number }>(
      `select revoked_reason as reason, count(*)::int n from sessions where user_id=$1 group by 1`,
      [id],
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.reason ?? 'activa', x.n]))).toEqual({
      activa: 5,
      concurrency: 7,
    });
    // los tokens de las 5 vigentes verifican; los otros 7 no
    const verdicts = await Promise.all(
      results.map((x) => (x.ok ? svc.verify(x.token) : Promise.resolve({ ok: false }))),
    );
    expect(verdicts.filter((v) => v.ok)).toHaveLength(5);
  });

  it('creaciones simultaneas de usuarios distintos no se interfieren', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await addStaff());
    await Promise.all(
      ids.flatMap((id) => [svc.create({ userId: id }), svc.create({ userId: id })]),
    );
    for (const id of ids) expect(await activeCount(id)).toBe(2);
  });

  it('20 verificaciones simultaneas del mismo token: todas validas, sin bloqueos ni errores', async () => {
    const id = await addStaff();
    const c = await svc.create({ userId: id });
    if (!c.ok) throw new Error('no se creo');
    const out = await Promise.all(Array.from({ length: 20 }, () => svc.verify(c.token)));
    expect(out.every((v) => v.ok)).toBe(true);
  });

  it('revocaciones simultaneas de la misma sesion: exactamente una la revoca', async () => {
    const id = await addStaff();
    const c = await svc.create({ userId: id });
    if (!c.ok) throw new Error('no se creo');
    const out = await Promise.all(Array.from({ length: 10 }, () => svc.revokeByToken(c.token)));
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(await svc.verify(c.token)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('verificacion vs revocacion global simultaneas: nunca falla y despues nada queda vigente', async () => {
    const id = await addStaff();
    const created = await Promise.all(Array.from({ length: 5 }, () => svc.create({ userId: id })));
    const tokens = created.map((x) => (x.ok ? x.token : ''));
    const [verifications, revoked] = await Promise.all([
      Promise.all(tokens.flatMap((t) => [svc.verify(t), svc.verify(t), svc.verify(t)])),
      svc.revokeAllForUser(id, { reason: 'admin', by: boss }),
    ]);
    expect(revoked).toBe(5);
    for (const v of verifications) expect(v.ok || v.reason === 'revoked').toBe(true);
    for (const t of tokens) expect(await svc.verify(t)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('inicios de sesion vs inhabilitacion de la cuenta: al terminar no queda ninguna sesion vigente', async () => {
    const id = await addStaff();
    const creators = Array.from({ length: 10 }, () => svc.create({ userId: id }));
    const disabling = owner.query(`update users set status = 'disabled' where id = $1`, [id]);
    const results = await Promise.all([...creators, disabling]);
    const created = results.slice(0, 10) as Awaited<ReturnType<SessionService['create']>>[];
    expect(created.every((r) => r.ok || r.reason === 'account_inactive')).toBe(true);
    expect(await activeCount(id)).toBe(0);
    for (const r of created) if (r.ok) expect((await svc.verify(r.token)).ok).toBe(false);
  });

  it('inicios de sesion vs cambio de contrasena: ningun token anterior sigue siendo valido', async () => {
    const id = await addStaff();
    const creators = Array.from({ length: 8 }, () => svc.create({ userId: id }));
    const changing = owner.query(
      `update users set password_hash = 'otro-hash-ficticio', password_changed_at = now() where id = $1`,
      [id],
    );
    const results = (await Promise.all([...creators, changing])).slice(0, 8) as Awaited<
      ReturnType<SessionService['create']>
    >[];
    // Las sesiones abiertas ANTES del cambio quedaron revocadas por el trigger; las abiertas despues (estado nuevo) son legitimas.
    const stillValid = await Promise.all(
      results.map((r) => (r.ok ? svc.verify(r.token) : Promise.resolve({ ok: false }))),
    );
    const changedAt = (
      await owner.query<{ t: Date }>(`select password_changed_at t from users where id=$1`, [id])
    ).rows[0]!.t;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (!r.ok || !stillValid[i]!.ok) continue;
      expect(r.session.createdAt.getTime()).toBeGreaterThanOrEqual(changedAt.getTime());
    }
  });

  it('inicios de sesion vs revocacion del rol: ninguna sesion llega a autorizar sin rol vigente', async () => {
    const id = await addStaff('trabajo_social');
    const creators = Array.from({ length: 8 }, () => svc.create({ userId: id }));
    const revoking = owner.query(
      `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
      [id, boss],
    );
    const results = (await Promise.all([...creators, revoking])).slice(0, 8) as Awaited<
      ReturnType<SessionService['create']>
    >[];
    for (const r of results) {
      if (!r.ok) continue;
      const v = await svc.verify(r.token);
      expect(v.ok).toBe(false); // revoked (trigger) o no_active_roles (revalidacion): jamas autoriza
    }
    expect(await svc.create({ userId: id })).toEqual({ ok: false, reason: 'no_active_roles' });
  });

  it('un error en mitad de la transaccion no deja sesiones a medias', async () => {
    const id = await addStaff();
    const before = await owner.query<{ n: number }>(`select count(*)::int n from sessions`);
    const bad = await svc.create({ userId: id, ip: 'no-es-una-ip' }).then(
      () => 'ok',
      (e: { code?: string; message: string }) => e.code,
    );
    expect(bad).toBe('22P02');
    const after = await owner.query<{ n: number }>(`select count(*)::int n from sessions`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect((await pool.query(`select 1 as ok`)).rows[0]).toEqual({ ok: 1 }); // el pool sigue sano
  });
});
