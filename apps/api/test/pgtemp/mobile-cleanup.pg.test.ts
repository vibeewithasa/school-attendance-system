import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLEANUP_DEFAULTS,
  CleanupBusyError,
  runMobileCleanup,
  type CleanupClient,
  type CleanupOptions,
} from '../../src/db/mobile-cleanup.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { FakeDevice } from '../helpers/fake-device.js';

/**
 * Limpieza del estado efimero movil contra PostgreSQL 18 DESECHABLE con conexiones independientes: exclusion mutua real,
 * concurrencia con la API (eta15_api) y privilegios efectivos. Ficticio. No toca eta15_dev. Ejecutar con: pnpm test:pg-temp
 */
let cluster: ApiCluster;
beforeAll(async () => {
  cluster = await startApiCluster(20, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
    mobileWrite: true,
  });
}, 240_000);
afterAll(async () => {
  if (cluster) await cluster.stop();
}, 60_000);

const opts = (over: Partial<CleanupOptions> = {}): CleanupOptions => ({
  ...CLEANUP_DEFAULTS,
  execute: true,
  ...over,
});
const asClient = (c: {
  query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}): CleanupClient => ({
  query: async (t, p) => {
    const r = await c.query(t, p);
    return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount };
  },
});
const owner = async (sql: string, params: unknown[] = []) =>
  (await cluster.owner.query(sql, params)).rows;
const count = async (table: string, where = 'true') =>
  Number((await owner(`select count(*)::int as n from ${table} where ${where}`))[0]!.n);
const seedOld = async (rows: number, minutesAgo = 600) => {
  for (let i = 0; i < rows; i += 1)
    await owner(
      `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at)
       values ($1, decode(md5(random()::text) || md5(random()::text), 'hex'),
               now() - make_interval(mins => $2) - interval '2 minutes', now() - make_interval(mins => $2))`,
      [new FakeDevice().thumbprint, minutesAgo],
    );
};

describe('limpieza movil en PostgreSQL 18 desechable', () => {
  it('EXCLUSION MUTUA: con el candado tomado por otra conexion, la limpieza se niega y no toca nada; al liberarlo funciona', async () => {
    await seedOld(5);
    const holder = await cluster.pgt.connect('eta15_app', 'eta15_dev');
    const runner = await cluster.pgt.connect('eta15_app', 'eta15_dev');
    try {
      await holder.query('begin');
      await holder.query(
        `select pg_advisory_xact_lock(hashtextextended('eta15:mobile-cleanup', 0))`,
      );
      await expect(runMobileCleanup(asClient(runner), opts())).rejects.toBeInstanceOf(
        CleanupBusyError,
      );
      expect(await count('mobile_proof_jtis')).toBe(5);
      await holder.query('commit');
      const r = await runMobileCleanup(asClient(runner), opts());
      expect(r.deleted.proofJtis).toBe(5);
    } finally {
      await holder.end();
      await runner.end();
    }
  });

  it('DOS EJECUCIONES A LA VEZ: nunca se duplica ni se pierde trabajo; la que llega con el candado ocupado se rechaza', async () => {
    await seedOld(40);
    const a = await cluster.pgt.connect('eta15_app', 'eta15_dev');
    const b = await cluster.pgt.connect('eta15_app', 'eta15_dev');
    try {
      const settle = (p: Promise<unknown>) =>
        p.then(
          (r) => ({ ok: true as const, r: r as { deleted: { proofJtis: number } } }),
          (e: unknown) => ({ ok: false as const, busy: e instanceof CleanupBusyError }),
        );
      const [x, y] = await Promise.all([
        settle(runMobileCleanup(asClient(a), opts())),
        settle(runMobileCleanup(asClient(b), opts())),
      ]);
      for (const res of [x, y]) if (!res.ok) expect(res.busy).toBe(true); // ningun error distinto de "ocupado"
      const deleted = [x, y].reduce((t, res) => t + (res.ok ? res.r.deleted.proofJtis : 0), 0);
      expect(deleted).toBe(40);
      expect(await count('mobile_proof_jtis', `expires_at < now() - interval '2 hours'`)).toBe(0);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('CONCURRENTE con la API: mientras se limpia lo vencido, eta15_api sigue registrando pruebas vigentes y ninguna se pierde', async () => {
    await seedOld(300);
    const keys = Array.from({ length: 25 }, () => new FakeDevice().thumbprint);
    const runner = await cluster.pgt.connect('eta15_app', 'eta15_dev');
    try {
      const insertLive = (k: string, i: number) =>
        cluster.pool.query(
          `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at)
           values ($1, decode(lpad(to_hex($2::int), 64, '0'), 'hex'), now(), now() + interval '2 minutes')`,
          [k, 1000 + i],
        );
      const [r] = await Promise.all([
        runMobileCleanup(asClient(runner), opts({ limit: 100 })),
        ...keys.map(insertLive),
      ]);
      expect(r.deleted.proofJtis).toBe(100);
      expect(r.moreWork).toBe(true);
      expect(await count('mobile_proof_jtis', `expires_at > now()`)).toBeGreaterThanOrEqual(25);
      // las 25 pruebas vigentes siguen: ninguna fue borrada por la limpieza
      for (const k of keys)
        expect(await count('mobile_proof_jtis', `key_thumbprint = '${k}'`)).toBe(1);
    } finally {
      await runner.end();
    }
  });

  it('PRIVILEGIOS: eta15_api no puede borrar, truncar ni anonimizar; solo el propietario retira y anonimiza, y no toca datos escolares', async () => {
    const api = (sql: string) => cluster.pool.query(sql);
    for (const sql of [
      'delete from mobile_proof_jtis',
      'delete from mobile_nonces',
      'truncate mobile_proof_jtis',
      'update mobile_sessions set ip = null where false',
      'update mobile_sessions set user_agent = null where false',
      'update mobile_device_requests set requested_ip = null where false',
    ])
      await expect(api(sql), sql).rejects.toMatchObject({ code: '42501' });
    // el verificador oficial 0006 sigue aprobando el estado exacto de privilegios (la 0012 no concede nada)
    await cluster.owner.query(privilegeFile('0006-mobile-auth-write.verify.sql'));
    const school = await count('students');
    const runner = await cluster.pgt.connect('eta15_app', 'eta15_dev');
    try {
      await runMobileCleanup(asClient(runner), opts());
    } finally {
      await runner.end();
    }
    expect(await count('students')).toBe(school);
  });
});
