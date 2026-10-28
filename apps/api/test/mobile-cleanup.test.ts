import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLEANUP_DEFAULTS,
  CleanupBusyError,
  runMobileCleanup,
  validateCleanupOptions,
  type CleanupClient,
  type CleanupOptions,
} from '../src/db/mobile-cleanup.js';
import { addUser, bootstrap, grant } from './helpers/auth-fixtures.js';
import { FakeDevice } from './helpers/fake-device.js';
import { freshDb } from './helpers/pglite.js';

/**
 * Limpieza operativa del estado efimero y retencion de datos de red del canal movil, sobre PGlite con la migracion 0011 y 0012.
 * Todo ficticio. La exclusion mutua entre dos conexiones reales se prueba en el clúster desechable (test/pgtemp).
 */
let db: PGlite;
let boss: string;
let pref: string;
const client: CleanupClient = {
  query: async (text, params) => {
    const r = await db.query<Record<string, unknown>>(text, params);
    return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
  },
};
const opts = (over: Partial<CleanupOptions> = {}): CleanupOptions => ({
  ...CLEANUP_DEFAULTS,
  execute: true,
  ...over,
});
const n = async (sql: string, p: unknown[] = []) =>
  Number((await db.query<{ n: number }>(sql, p)).rows[0]!.n);

let seq = 0;
const hash = () => Buffer.alloc(32, (seq += 1) % 250 || 1);
const thumb = () => new FakeDevice().thumbprint;

/** Prueba/nonce con vencimiento relativo a ahora (minutos; negativo = ya vencio). */
const addProof = (minutesFromNow: number) =>
  db.query(
    `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at)
     values ($1, $2, now() + make_interval(mins => $3) - interval '2 minutes', now() + make_interval(mins => $3))`,
    [thumb(), hash(), minutesFromNow],
  );
const addNonce = (minutesFromNow: number) =>
  db.query(
    `insert into mobile_nonces (nonce_hash, key_thumbprint, issued_at, expires_at)
     values ($1, $2, now() + make_interval(mins => $3) - interval '2 minutes', now() + make_interval(mins => $3))`,
    [hash(), thumb(), minutesFromNow],
  );

/** Solicitud con IP, creada hace `ageDays`; si `closedDaysAgo` se indica, queda cancelada con esa antiguedad (sin pasar por el trigger). */
async function request(
  opt: { ageDays?: number; closedDaysAgo?: number; ip?: string | null; open?: boolean } = {},
) {
  const dev = new FakeDevice();
  const age = opt.ageDays ?? 0;
  const r = await db.query<{ id: string }>(
    `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, created_at, expires_at, requested_ip)
     values ($1, $2::jsonb, 'Prueba', $3, now() - make_interval(days => $4), now() - make_interval(days => $4) + interval '10 minutes', $5::inet)
     returning id`,
    [
      dev.thumbprint,
      JSON.stringify(dev.jwk),
      hash(),
      age,
      opt.ip === undefined ? '10.1.2.3' : opt.ip,
    ],
  );
  const id = r.rows[0]!.id;
  if (opt.closedDaysAgo !== undefined) {
    await db.query('alter table mobile_device_requests disable trigger mdr_guard_update');
    await db.query(
      `update mobile_device_requests set status = 'cancelled', closed_at = now() - make_interval(days => $2) where id = $1`,
      [id, opt.closedDaysAgo],
    );
    await db.query('alter table mobile_device_requests enable trigger mdr_guard_update');
  }
  return { id, dev };
}

/** Sesion de un dispositivo activo; termino hace `endedDaysAgo` (vencida o revocada) con IP y agente. */
async function session(endedDaysAgo: number | null, revoked = false) {
  const dev = new FakeDevice();
  const pref = await addUser(db, `p${(seq += 1)}@escuela.test`, 'school');
  await grant(db, pref, 'prefectura', boss);
  const req = await db.query<{ id: string }>(
    `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
     values ($1, $2::jsonb, 'Disp', $3, now() + interval '10 minutes') returning id`,
    [dev.thumbprint, JSON.stringify(dev.jwk), hash()],
  );
  const rid = req.rows[0]!.id;
  await db.query(
    `update mobile_device_requests set status = 'claimed', user_id = $2 where id = $1`,
    [rid, pref],
  );
  await db.query(
    `update mobile_device_requests set status = 'approved', approved_by = $2 where id = $1`,
    [rid, boss],
  );
  const d = await db.query<{ id: string }>(
    `insert into mobile_devices (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by)
     values ($1, $2, $3::jsonb, 'Disp', $4, $5) returning id`,
    [pref, dev.thumbprint, JSON.stringify(dev.jwk), rid, boss],
  );
  await db.query(`update mobile_device_requests set status = 'activated' where id = $1`, [rid]);
  const deviceId = d.rows[0]!.id;
  const ago = endedDaysAgo === null ? -1 : endedDaysAgo; // negativo = termina en el futuro (vigente)
  const s = await db.query<{ id: string }>(
    `insert into mobile_sessions (device_id, user_id, access_hash, refresh_hash, created_at, access_expires_at, idle_expires_at,
                                  absolute_expires_at, ip, user_agent)
     values ($1, $2, $3, $4, now() - make_interval(days => $5 + 1), now() - make_interval(days => $5 + 1) + interval '10 minutes',
             now() - make_interval(days => $5 + 1) + interval '30 minutes', now() - make_interval(days => $5), '10.9.8.7'::inet, 'AgenteFicticio/1.0')
     returning id`,
    [deviceId, pref, hash(), hash(), ago],
  );
  const id = s.rows[0]!.id;
  if (revoked && endedDaysAgo !== null) {
    await db.query('alter table mobile_sessions disable trigger ms_guard_update');
    await db.query(
      `update mobile_sessions set revoked_at = now() - make_interval(days => $2), revoked_reason = 'logout' where id = $1`,
      [id, endedDaysAgo],
    );
    await db.query('alter table mobile_sessions enable trigger ms_guard_update');
  }
  return id;
}

beforeAll(async () => {
  db = await freshDb();
  boss = await addUser(db, 'boss@escuela.test', 'school');
  await bootstrap(db, boss, 'direccion');
  pref = await addUser(db, 'pref@escuela.test', 'school');
  await grant(db, pref, 'prefectura', boss);
});
afterAll(async () => {
  await db.close();
});

describe('opciones y seguridad de la limpieza', () => {
  it('valida limites y exige un margen de al menos 60 minutos (la base tambien lo exige)', () => {
    expect(() => validateCleanupOptions(opts())).not.toThrow();
    for (const bad of [
      { marginMinutes: 59 },
      { marginMinutes: 20_000 },
      { limit: 0 },
      { limit: 100_000 },
      { requestIpDays: 0 },
      { sessionIpDays: 1.5 },
    ])
      expect(() => validateCleanupOptions(opts(bad)), JSON.stringify(bad)).toThrow();
  });

  it('si las tablas moviles no existen (0011/0012 sin aplicar) no hace nada y lo informa', async () => {
    const calls: string[] = [];
    const fake: CleanupClient = {
      query: async (text) => {
        calls.push(text.trim().split('\n')[0]!.slice(0, 40));
        if (/to_regclass/.test(text)) return { rows: [{ ok: false }] };
        if (/pg_try_advisory/.test(text)) return { rows: [{ ok: true }] };
        return { rows: [] };
      },
    };
    const r = await runMobileCleanup(fake, opts());
    expect(r.skipped).toBe('tablas-moviles-ausentes');
    expect(calls.some((c) => /DELETE|UPDATE|INSERT/i.test(c))).toBe(false);
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it('si otra limpieza tiene el candado, falla con CleanupBusyError sin tocar nada', async () => {
    const busy: CleanupClient = {
      query: async (text) =>
        /pg_try_advisory/.test(text) ? { rows: [{ ok: false }] } : { rows: [{ ok: true }] },
    };
    await expect(runMobileCleanup(busy, opts())).rejects.toBeInstanceOf(CleanupBusyError);
  });
});

describe('estado efimero: retira solo lo vencido hace mas del margen', () => {
  it('ENSAYO: informa conteos exactos y no cambia nada (ROLLBACK)', async () => {
    for (let i = 0; i < 3; i += 1) await addProof(-300); // vencidas hace 5 horas
    for (let i = 0; i < 2; i += 1) await addNonce(-300);
    const before = await n(
      'select (select count(*) from mobile_proof_jtis) + (select count(*) from mobile_nonces) as n',
    );
    const r = await runMobileCleanup(client, opts({ execute: false }));
    expect(r.mode).toBe('ensayo');
    expect(r.deleted).toEqual({ proofJtis: 3, nonces: 2 });
    expect(
      await n(
        'select (select count(*) from mobile_proof_jtis) + (select count(*) from mobile_nonces) as n',
      ),
    ).toBe(before);
    expect(
      await n(`select count(*) as n from audit_events where event_type = 'mobile.cleanup_run'`),
    ).toBe(0);
  });

  it('EJECUCION: borra lo vencido hace mas del margen y conserva lo vigente y lo vencido hace poco', async () => {
    await addProof(+5); // vigente
    await addProof(-10); // vencida hace 10 minutos: dentro del margen
    await addProof(-90); // vencida hace 90 minutos: dentro del margen de 120
    await addNonce(+1);
    await addNonce(-30);
    const keep = await n(
      "select count(*) as n from mobile_proof_jtis where expires_at > now() - interval '2 hours'",
    );
    const r = await runMobileCleanup(client, opts({ marginMinutes: 120 }));
    expect(r.mode).toBe('ejecucion');
    expect(r.deleted.proofJtis).toBe(3); // las 3 de hace 5 horas del ensayo
    expect(r.deleted.nonces).toBe(2);
    expect(await n('select count(*) as n from mobile_proof_jtis')).toBe(keep);
    expect(
      await n(
        "select count(*) as n from mobile_proof_jtis where expires_at < now() - interval '2 hours'",
      ),
    ).toBe(0);
    // nada vigente fue tocado
    expect(await n(`select count(*) as n from mobile_proof_jtis where expires_at > now()`)).toBe(1);
    expect(await n(`select count(*) as n from mobile_nonces where expires_at > now()`)).toBe(1);
  });

  it('el margen mas corto permitido (60 min) tampoco alcanza lo vencido hace menos de una hora', async () => {
    await addProof(-50);
    await runMobileCleanup(client, opts({ marginMinutes: 60 }));
    expect(
      await n(
        `select count(*) as n from mobile_proof_jtis where expires_at between now() - interval '55 minutes' and now() - interval '45 minutes'`,
      ),
    ).toBe(1);
  });

  it('LIMITE por ejecucion: procesa a lo mas `limit` filas, avisa que queda trabajo y la siguiente ejecucion continua', async () => {
    for (let i = 0; i < 7; i += 1) await addProof(-600);
    const first = await runMobileCleanup(client, opts({ limit: 3 }));
    expect(first.deleted.proofJtis).toBe(3);
    expect(first.moreWork).toBe(true);
    const second = await runMobileCleanup(client, opts({ limit: 3 }));
    expect(second.deleted.proofJtis).toBe(3);
    const third = await runMobileCleanup(client, opts({ limit: 3 }));
    expect(third.deleted.proofJtis).toBe(1);
    expect(third.moreWork).toBe(false);
  });
});

describe('solicitudes vencidas y retencion de datos de red', () => {
  it('cierra (no borra) las solicitudes abiertas ya vencidas y no toca las vigentes', async () => {
    const stale = await request({ ageDays: 1 }); // pendiente que vencio hace un dia
    const live = await request({ ageDays: 0 }); // pendiente vigente
    const total = await n('select count(*) as n from mobile_device_requests');
    const r = await runMobileCleanup(client, opts());
    expect(r.closedExpiredRequests).toBeGreaterThanOrEqual(1);
    const st = await db.query<{ status: string }>(
      'select status from mobile_device_requests where id = $1',
      [stale.id],
    );
    const lv = await db.query<{ status: string }>(
      'select status from mobile_device_requests where id = $1',
      [live.id],
    );
    expect(st.rows[0]!.status).toBe('cancelled');
    expect(lv.rows[0]!.status).toBe('pending');
    expect(await n('select count(*) as n from mobile_device_requests')).toBe(total); // historia conservada
  });

  it('ANONIMIZA la IP de solicitudes cerradas tras el plazo y conserva la fila; no toca las recientes ni las abiertas', async () => {
    const old = await request({ ageDays: 20, closedDaysAgo: 10 });
    const recent = await request({ ageDays: 2, closedDaysAgo: 1 });
    const open = await request({ ageDays: 0 });
    const r = await runMobileCleanup(client, opts({ requestIpDays: 7 }));
    expect(r.anonymized.requestIps).toBeGreaterThanOrEqual(1);
    const ip = async (id: string) =>
      (
        await db.query<{ ip: string | null; k: string }>(
          'select host(requested_ip) as ip, key_thumbprint as k from mobile_device_requests where id = $1',
          [id],
        )
      ).rows[0]!;
    expect((await ip(old.id)).ip).toBeNull();
    expect((await ip(old.id)).k).toBe(old.dev.thumbprint); // la fila y su identidad siguen
    expect((await ip(recent.id)).ip).toBe('10.1.2.3');
    expect((await ip(open.id)).ip).toBe('10.1.2.3');
  });

  it('ANONIMIZA IP y agente de sesiones terminadas (vencidas o revocadas) tras el plazo, sin tocar credenciales ni la sesion vigente', async () => {
    const expired = await session(40); // vencio hace 40 dias
    const revokedOld = await session(35, true);
    const recent = await session(3);
    const live = await session(null);
    const before = JSON.stringify(
      (
        await db.query(
          'select access_hash, refresh_hash, refresh_count, revoked_at, absolute_expires_at from mobile_sessions where id = $1',
          [expired],
        )
      ).rows,
    );
    const r = await runMobileCleanup(client, opts({ sessionIpDays: 30 }));
    expect(r.anonymized.sessionRows).toBeGreaterThanOrEqual(2);
    const row = async (id: string) =>
      (
        await db.query<{ ip: string | null; ua: string | null }>(
          'select host(ip) as ip, user_agent as ua from mobile_sessions where id = $1',
          [id],
        )
      ).rows[0]!;
    expect(await row(expired)).toEqual({ ip: null, ua: null });
    expect(await row(revokedOld)).toEqual({ ip: null, ua: null });
    expect((await row(recent)).ip).toBe('10.9.8.7');
    expect((await row(live)).ip).toBe('10.9.8.7');
    // la anonimizacion no cambia credenciales, caducidades ni revocacion
    const after = JSON.stringify(
      (
        await db.query(
          'select access_hash, refresh_hash, refresh_count, revoked_at, absolute_expires_at from mobile_sessions where id = $1',
          [expired],
        )
      ).rows,
    );
    expect(after).toBe(before);
  });

  it('la base solo admite ANONIMIZAR (a NULL): cambiar o inventar una IP o un agente sigue prohibido (42501)', async () => {
    const s = await session(5);
    for (const sql of [
      `update mobile_sessions set ip = '1.1.1.1'::inet where id = '${s}'`,
      `update mobile_sessions set user_agent = 'otro' where id = '${s}'`,
    ])
      await expect(db.query(sql)).rejects.toMatchObject({ code: '42501' });
    const rq = await request();
    await expect(
      db.query(
        `update mobile_device_requests set requested_ip = '1.1.1.1'::inet where id = '${rq.id}'`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // y NULLear la IP no permite colar otros cambios en la misma sentencia
    await expect(
      db.query(
        `update mobile_sessions set ip = null, refresh_count = refresh_count + 5 where id = '${s}'`,
      ),
    ).rejects.toBeTruthy();
  });
});

describe('registro de seguridad de la limpieza', () => {
  it('la ejecucion deja UN evento de auditoria con solo conteos y parametros (sin IP, tokens ni identificadores)', async () => {
    await addProof(-900);
    const before = await n(
      `select count(*) as n from audit_events where event_type = 'mobile.cleanup_run'`,
    );
    await runMobileCleanup(client, opts());
    expect(
      await n(`select count(*) as n from audit_events where event_type = 'mobile.cleanup_run'`),
    ).toBe(before + 1);
    const ev = (
      await db.query<{
        details: Record<string, unknown>;
        ip: string | null;
        actor_user_id: string | null;
      }>(
        `select details, ip, actor_user_id from audit_events where event_type = 'mobile.cleanup_run' order by occurred_at desc limit 1`,
      )
    ).rows[0]!;
    expect(ev.ip).toBeNull();
    expect(ev.actor_user_id).toBeNull();
    expect(Object.keys(ev.details).sort()).toEqual(
      [
        'anonymized',
        'closedExpiredRequests',
        'deleted',
        'limit',
        'marginMinutes',
        'mode',
        'moreWork',
        'requestIpDays',
        'sessionIpDays',
      ].sort(),
    );
    expect(JSON.stringify(ev.details)).not.toMatch(/\d+\.\d+\.\d+\.\d+|[A-Za-z0-9_-]{43}/);
  });

  it('el ensayo no deja evento', async () => {
    const before = await n(
      `select count(*) as n from audit_events where event_type = 'mobile.cleanup_run'`,
    );
    await runMobileCleanup(client, opts({ execute: false }));
    expect(
      await n(`select count(*) as n from audit_events where event_type = 'mobile.cleanup_run'`),
    ).toBe(before);
  });
});
