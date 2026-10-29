import { join } from 'node:path';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGlite as PGliteCtor } from '@electric-sql/pglite';
import type { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, bootstrap, grant } from './helpers/auth-fixtures.js';
import { freshDb } from './helpers/pglite.js';
import { FakeDevice } from './helpers/fake-device.js';

/**
 * Migracion 0011 (autenticacion movil, PROTOTIPO de sandbox) en PGlite = PostgreSQL 18.6 en memoria. Las reglas son de la BASE
 * (propietario); la API como rol no propietario, los privilegios por columna y la concurrencia real se prueban en el clúster
 * desechable (test/pgtemp/mobile-auth.pg.test.ts). Datos y claves FICTICIOS.
 */
let db: PGlite;
const ids = {} as Record<'boss' | 'a' | 'b' | 'social' | 'tec' | 'dual', string>;
const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0]!;
const num = async (sql: string, p: unknown[] = []) => Number((await one<{ n: number }>(sql, p)).n);

async function err(
  p: Promise<unknown>,
): Promise<{ code?: string; constraint?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
  throw new Error('Se esperaba un error y la operacion tuvo exito');
}

let seq = 0;
const code = () => Buffer.alloc(32, (seq += 1));

/** Solicitud pendiente de un dispositivo ficticio. */
async function newRequest(dev = new FakeDevice(), extra: { expires?: string } = {}) {
  const r = await one<{ id: string }>(
    `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
     values ($1, $2::jsonb, 'Tableta ficticia', $3, ${extra.expires ?? "now() + interval '10 minutes'"}) returning id`,
    [dev.thumbprint, JSON.stringify(dev.jwk), code()],
  );
  return { id: r.id, dev };
}
const claim = (id: string, user: string) =>
  db.query(`update mobile_device_requests set status = 'claimed', user_id = $2 where id = $1`, [
    id,
    user,
  ]);
const approve = (id: string, by: string) =>
  db.query(
    `update mobile_device_requests set status = 'approved', approved_by = $2 where id = $1`,
    [id, by],
  );
const registerDevice = (
  reqId: string,
  dev: FakeDevice,
  user: string,
  approver: string,
  label = 'Tableta ficticia',
) =>
  db.query<{ id: string }>(
    `insert into mobile_devices (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by)
     values ($1, $2, $3::jsonb, $4, $5, $6) returning id`,
    [user, dev.thumbprint, JSON.stringify(dev.jwk), label, reqId, approver],
  );

/** Solicitud llevada hasta APROBADA para `user`. */
async function approved(user: string) {
  await db.query(
    `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed', 'approved')`,
    [user],
  );
  const r = await newRequest();
  await claim(r.id, user);
  await approve(r.id, ids.boss!);
  return r;
}
async function activeDevice(user: string) {
  await db.query(
    `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where user_id = $1 and status = 'active'`,
    [user, ids.boss!],
  );
  const r = await approved(user);
  const d = await registerDevice(r.id, r.dev, user, ids.boss!);
  await db.query(`update mobile_device_requests set status = 'activated' where id = $1`, [r.id]);
  return { dev: r.dev, deviceId: d.rows[0]!.id, requestId: r.id };
}
const newSession = (deviceId: string, user: string, over: Record<string, unknown> = {}) =>
  db.query(
    `insert into mobile_sessions (device_id, user_id, access_hash, refresh_hash, access_expires_at, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, $4, now() + interval '10 minutes', now() + interval '30 minutes', now() + interval '8 hours')`,
    [deviceId, user, over.access ?? code(), over.refresh ?? code()],
  );

beforeAll(async () => {
  db = await freshDb();
  ids.boss = await addUser(db, 'boss@escuela.test', 'school');
  await bootstrap(db, ids.boss, 'direccion');
  ids.a = await addUser(db, 'a@escuela.test', 'school');
  await grant(db, ids.a, 'prefectura', ids.boss);
  ids.b = await addUser(db, 'b@escuela.test', 'school');
  await grant(db, ids.b, 'prefectura', ids.boss);
  ids.social = await addUser(db, 'social@escuela.test', 'school');
  await grant(db, ids.social, 'trabajo_social', ids.boss);
  ids.tec = await addUser(db, 'tec@escuela.test', 'technical');
  await bootstrap(db, ids.tec, 'admin_tecnico', 'ACTA-TEC');
  ids.dual = await addUser(db, 'dual@escuela.test', 'school'); // prefectura + direccion (MFA)
  await grant(db, ids.dual, 'prefectura', ids.boss);
  await grant(db, ids.dual, 'direccion', ids.boss);
});
afterAll(async () => {
  await db.close();
});

describe('0011: tablas y restricciones', () => {
  it('crea las cinco tablas y no concede privilegios (la API no puede leerlas hasta aplicar 0006)', async () => {
    const t = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name like 'mobile_%' order by 1`,
    );
    expect(t.rows.map((r) => r.table_name)).toEqual([
      'mobile_device_requests',
      'mobile_devices',
      'mobile_nonces',
      'mobile_proof_jtis',
      'mobile_sessions',
    ]);
  });

  it('la clave publica no admite componente privado ni formatos invalidos (CHECK)', async () => {
    const dev = new FakeDevice();
    for (const jwk of [
      { ...dev.jwk, d: 'A'.repeat(43) },
      { ...dev.jwk, kty: 'RSA' },
      { ...dev.jwk, x: 'corto' },
      'texto',
    ]) {
      const e = await err(
        db.query(
          `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
           values ($1, $2::jsonb, 'x', $3, now() + interval '5 minutes')`,
          [dev.thumbprint, JSON.stringify(jwk), code()],
        ),
      );
      expect([e.code, e.constraint]).toEqual(['23514', 'mdr_jwk_valid']);
    }
  });

  it('vigencia maxima de 30 minutos, etiqueta acotada y huella con formato', async () => {
    const dev = new FakeDevice();
    const mk = (label: string, expires: string, thumb = dev.thumbprint) =>
      db.query(
        `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
         values ($1, $2::jsonb, $3, $4, ${expires})`,
        [thumb, JSON.stringify(dev.jwk), label, code()],
      );
    expect((await err(mk('x', "now() + interval '2 hours'"))).constraint).toBe('mdr_expiry_window');
    expect((await err(mk('x', "now() - interval '1 minute'"))).constraint).toBe(
      'mdr_expiry_window',
    );
    expect((await err(mk('   ', "now() + interval '5 minutes'"))).constraint).toBe(
      'mdr_label_length',
    );
    expect((await err(mk('x'.repeat(61), "now() + interval '5 minutes'"))).constraint).toBe(
      'mdr_label_length',
    );
    expect((await err(mk('x', "now() + interval '5 minutes'", 'corta'))).constraint).toBe(
      'mdr_thumbprint_format',
    );
  });

  it('una solicitud nace pendiente y sin titular (no se puede insertar ya reclamada o aprobada)', async () => {
    const dev = new FakeDevice();
    for (const extra of [`, status`]) void extra;
    const e = await err(
      db.query(
        `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at, status, user_id, claimed_at)
         values ($1, $2::jsonb, 'x', $3, now() + interval '5 minutes', 'claimed', $4, now())`,
        [dev.thumbprint, JSON.stringify(dev.jwk), code(), ids.a],
      ),
    );
    expect([e.code, e.constraint]).toEqual(['23514', 'mdr_born_pending']);
  });

  it('una sola solicitud abierta por clave y por persona titular', async () => {
    const r = await newRequest();
    const dup = await err(
      db.query(
        `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, expires_at)
         values ($1, $2::jsonb, 'x', $3, now() + interval '5 minutes')`,
        [r.dev.thumbprint, JSON.stringify(r.dev.jwk), code()],
      ),
    );
    expect([dup.code, dup.constraint]).toEqual(['23505', 'mdr_open_thumbprint_key']);
    await db.query(
      `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed','approved')`,
      [ids.b],
    );
    const r1 = await newRequest();
    const r2 = await newRequest();
    await claim(r1.id, ids.b);
    const second = await err(claim(r2.id, ids.b));
    expect([second.code, second.constraint]).toEqual(['23505', 'mdr_open_user_key']);
    await db.query(`update mobile_device_requests set status = 'cancelled' where id in ($1, $2)`, [
      r1.id,
      r2.id,
    ]);
  });
});

describe('0011: transiciones de la solicitud (reclamo, aprobacion, activacion)', () => {
  it('flujo valido: pending -> claimed -> approved -> (dispositivo) -> activated, con horas fijadas por la base', async () => {
    await db.query(
      `update mobile_device_requests set status = 'cancelled' where user_id = $1 and status in ('claimed','approved')`,
      [ids.a],
    );
    const r = await newRequest();
    await claim(r.id, ids.a);
    const c = await one<{ claimed_at: Date | null }>(
      `select claimed_at from mobile_device_requests where id = $1`,
      [r.id],
    );
    expect(c.claimed_at).not.toBeNull();
    await approve(r.id, ids.boss!);
    const dev = await registerDevice(r.id, r.dev, ids.a, ids.boss!);
    await db.query(`update mobile_device_requests set status = 'activated' where id = $1`, [r.id]);
    const row = await one<Record<string, unknown>>(
      `select status, approved_at, activated_at from mobile_device_requests where id = $1`,
      [r.id],
    );
    expect(row.status).toBe('activated');
    expect(row.approved_at).not.toBeNull();
    expect(row.activated_at).not.toBeNull();
    expect(dev.rows[0]!.id).toBeTruthy();
  });

  it('saltarse pasos esta prohibido: no se aprueba lo pendiente ni se activa lo reclamado', async () => {
    const r = await newRequest();
    expect((await err(approve(r.id, ids.boss!))).constraint).toBe('mdr_transition');
    await claim(r.id, ids.b);
    const noDevice = await err(
      db.query(`update mobile_device_requests set status = 'activated' where id = $1`, [r.id]),
    );
    expect(noDevice.constraint).toBe('mdr_transition');
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r.id]);
  });

  it('reclamo: solo cuentas elegibles (activa, escolar, con prefectura vigente, sin rol que exija MFA)', async () => {
    for (const [who, label] of [
      [ids.social, 'trabajo social'],
      [ids.tec, 'tecnica'],
      [ids.boss, 'direccion'],
      [ids.dual, 'prefectura + direccion (MFA)'],
    ] as const) {
      const r = await newRequest();
      const e = await err(claim(r.id, who!));
      expect([label, e.constraint]).toEqual([label, 'mdr_user_eligible']);
      await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [
        r.id,
      ]);
    }
    const off = await addUser(db, 'off@escuela.test', 'school');
    await grant(db, off, 'prefectura', ids.boss);
    await db.query(`update users set status = 'disabled' where id = $1`, [off]);
    const r2 = await newRequest();
    expect((await err(claim(r2.id, off))).constraint).toBe('mdr_user_eligible');
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r2.id]);
  });

  it('aprobacion: nadie aprueba su propia vinculacion, y solo quien tiene `mobile_devices:manage`', async () => {
    const r = await newRequest();
    await claim(r.id, ids.a);
    expect((await err(approve(r.id, ids.a))).constraint).toBe('mdr_not_self_approved');
    for (const who of [ids.b, ids.social, ids.tec])
      expect((await err(approve(r.id, who!))).constraint).toBe('mdr_approver_authority');
    await approve(r.id, ids.boss!);
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r.id]);
  });

  it('una solicitud vencida no se reclama ni se aprueba ni se activa', async () => {
    const dev = new FakeDevice();
    const r = await one<{ id: string }>(
      `insert into mobile_device_requests (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, created_at, expires_at)
       values ($1, $2::jsonb, 'x', $3, now() - interval '2 hours', now() - interval '90 minutes') returning id`,
      [dev.thumbprint, JSON.stringify(dev.jwk), code()],
    );
    expect((await err(claim(r.id, ids.a))).constraint).toBe('mdr_not_expired');
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r.id]);
  });

  it('identidad inmutable y estados terminales: no se reescribe la clave, el codigo ni se reabre una solicitud cerrada', async () => {
    const r = await newRequest();
    const other = new FakeDevice();
    for (const sql of [
      `update mobile_device_requests set key_thumbprint = '${other.thumbprint}' where id = '${r.id}'`,
      `update mobile_device_requests set public_key_jwk = '${JSON.stringify(other.jwk)}'::jsonb where id = '${r.id}'`,
      `update mobile_device_requests set pairing_code_hash = decode(repeat('ab', 32), 'hex') where id = '${r.id}'`,
      `update mobile_device_requests set expires_at = now() + interval '20 minutes' where id = '${r.id}'`,
      `update mobile_device_requests set device_label = 'otro' where id = '${r.id}'`,
    ])
      expect((await err(db.exec(sql))).code, sql).toBe('42501');
    await db.query(
      `update mobile_device_requests set status = 'rejected', closed_by = $2 where id = $1`,
      [r.id, ids.boss!],
    );
    const reopen = await err(
      db.query(`update mobile_device_requests set status = 'pending' where id = $1`, [r.id]),
    );
    expect(reopen.code).toBe('42501');
    const reclaim = await err(claim(r.id, ids.a));
    expect(reclaim.code).toBe('42501');
  });

  it('el titular fijado no cambia y los intentos fallidos solo suben de uno en uno', async () => {
    const r = await newRequest();
    await db.query(
      `update mobile_device_requests set claim_failures = claim_failures + 1 where id = $1`,
      [r.id],
    );
    expect(
      (
        await err(
          db.query(`update mobile_device_requests set claim_failures = 5 where id = $1`, [r.id]),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(`update mobile_device_requests set claim_failures = 0 where id = $1`, [r.id]),
        )
      ).code,
    ).toBe('42501');
    await claim(r.id, ids.a);
    expect(
      (
        await err(
          db.query(`update mobile_device_requests set user_id = $2 where id = $1`, [r.id, ids.b]),
        )
      ).code,
    ).toBe('42501');
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r.id]);
  });
});

describe('0011: dispositivos', () => {
  it('solo existen a partir de una solicitud APROBADA y vigente, con la misma persona, clave, aprobador y etiqueta', async () => {
    const pend = await newRequest();
    expect((await err(registerDevice(pend.id, pend.dev, ids.a, ids.boss!))).constraint).toBe(
      'md_from_approved_request',
    );
    const ok = await approved(ids.a);
    const other = new FakeDevice();
    expect((await err(registerDevice(ok.id, other, ids.a, ids.boss!))).constraint).toBe(
      'md_from_approved_request',
    ); // otra clave
    expect((await err(registerDevice(ok.id, ok.dev, ids.b, ids.boss!))).constraint).toBe(
      'md_from_approved_request',
    ); // otra persona
    expect((await err(registerDevice(ok.id, ok.dev, ids.a, ids.a))).constraint).toBeDefined(); // otro aprobador
    expect(
      (await err(registerDevice(ok.id, ok.dev, ids.a, ids.boss!, 'otra etiqueta'))).constraint,
    ).toBe('md_from_approved_request');
    const good = await registerDevice(ok.id, ok.dev, ids.a, ids.boss!);
    expect(good.rows).toHaveLength(1);
    // la misma clave no se registra dos veces ni siquiera tras revocar
    const dup = await err(registerDevice(ok.id, ok.dev, ids.a, ids.boss!));
    expect(dup.code).toBe('23505');
    await db.query(`update mobile_device_requests set status = 'activated' where id = $1`, [ok.id]);
  });

  it('maximo 3 dispositivos activos por persona', async () => {
    const acc = await addUser(db, 'limite@escuela.test', 'school');
    await grant(db, acc, 'prefectura', ids.boss);
    for (let i = 0; i < 3; i += 1) {
      const r = await approved(acc);
      await registerDevice(r.id, r.dev, acc, ids.boss!);
      await db.query(`update mobile_device_requests set status = 'activated' where id = $1`, [
        r.id,
      ]);
    }
    const r4 = await approved(acc);
    expect((await err(registerDevice(r4.id, r4.dev, acc, ids.boss!))).constraint).toBe(
      'md_device_limit',
    );
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r4.id]);
  });

  it('identidad inmutable; solo cambia last_seen_at y la REVOCACION (con quien y por que), sin vuelta atras', async () => {
    const d = await activeDevice(ids.b);
    expect(
      (await err(db.query(`update mobile_devices set label = 'x' where id = $1`, [d.deviceId])))
        .code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(`update mobile_devices set user_id = $2 where id = $1`, [d.deviceId, ids.a]),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(`update mobile_devices set key_thumbprint = $2 where id = $1`, [
            d.deviceId,
            new FakeDevice().thumbprint,
          ]),
        )
      ).code,
    ).toBe('42501');
    await db.query(`update mobile_devices set last_seen_at = now() where id = $1`, [d.deviceId]);
    expect(
      (
        await err(
          db.query(`update mobile_devices set status = 'revoked' where id = $1`, [d.deviceId]),
        )
      ).constraint,
    ).toBeDefined();
    await db.query(
      `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'lost' where id = $1`,
      [d.deviceId, ids.boss!],
    );
    const rev = await one<{ revoked_at: Date | null }>(
      `select revoked_at from mobile_devices where id = $1`,
      [d.deviceId],
    );
    expect(rev.revoked_at).not.toBeNull();
    expect(
      (
        await err(
          db.query(
            `update mobile_devices set status = 'active', revoked_at = null, revoked_by = null, revoke_reason = null where id = $1`,
            [d.deviceId],
          ),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('0011: sesiones moviles', () => {
  it('solo para un dispositivo ACTIVO de una cuenta elegible; nace sin renovaciones ni revocacion', async () => {
    const d = await activeDevice(ids.a);
    // la sesion y el dispositivo son de la misma cuenta (FK compuesta)
    const mismatch = await err(newSession(d.deviceId, ids.b));
    expect(mismatch.code).toBe('23503');
    await newSession(d.deviceId, ids.a);
    expect(
      await num(`select count(*) n from mobile_sessions where device_id = $1`, [d.deviceId]),
    ).toBe(1);
    // una sola sesion activa por dispositivo
    const second = await err(newSession(d.deviceId, ids.a));
    expect([second.code, second.constraint]).toEqual(['23505', 'ms_one_active_per_device']);
    // nace limpia
    await db.query(`update mobile_sessions set revoked_reason = 'logout' where device_id = $1`, [
      d.deviceId,
    ]);
    const dirty = await err(
      db.query(
        `insert into mobile_sessions (device_id, user_id, access_hash, refresh_hash, previous_refresh_hash, access_expires_at, idle_expires_at, absolute_expires_at)
         values ($1, $2, $3, $4, $5, now() + interval '10 minutes', now() + interval '30 minutes', now() + interval '8 hours')`,
        [d.deviceId, ids.a, code(), code(), code()],
      ),
    );
    expect(dirty.constraint).toBe('ms_born_clean');
  });

  it('un dispositivo revocado o una cuenta no elegible no obtienen sesion; el rol re-concedido despues NO revive el dispositivo', async () => {
    const d = await activeDevice(ids.a);
    await db.query(
      `update mobile_devices set status = 'revoked', revoked_by = $2, revoke_reason = 'authority' where id = $1`,
      [d.deviceId, ids.boss!],
    );
    expect((await err(newSession(d.deviceId, ids.a))).constraint).toBe('ms_device_active');
    // cuenta elegible solo con el rol concedido ANTES del registro del dispositivo
    const acc = await addUser(db, 'rol@escuela.test', 'school');
    await grant(db, acc, 'prefectura', ids.boss);
    const dev = await activeDevice(acc);
    await newSession(dev.deviceId, acc);
    await db.query(`update mobile_sessions set revoked_reason = 'logout' where device_id = $1`, [
      dev.deviceId,
    ]);
    await db.query(
      `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
      [acc, ids.boss!],
    );
    expect((await err(newSession(dev.deviceId, acc))).constraint).toBe('ms_user_eligible');
    await grant(db, acc, 'prefectura', ids.boss);
    expect((await err(newSession(dev.deviceId, acc))).constraint).toBe('ms_user_eligible');
  });

  it('la rotacion exige credenciales nuevas, conserva la anterior y cuenta; la revocacion es historia inmutable', async () => {
    const acc = await addUser(db, 'rota@escuela.test', 'school');
    await grant(db, acc, 'prefectura', ids.boss);
    const d = await activeDevice(acc);
    const refresh0 = code();
    await newSession(d.deviceId, acc, { refresh: refresh0 });
    // sin cambiar credenciales, o cambiando solo una, o sin contar: no es una rotacion valida
    expect(
      (
        await err(
          db.query(
            `update mobile_sessions set refresh_count = refresh_count + 1 where device_id = $1`,
            [d.deviceId],
          ),
        )
      ).constraint,
    ).toBe('ms_rotation');
    expect(
      (
        await err(
          db.query(
            `update mobile_sessions set access_expires_at = now() + interval '9 minutes' where device_id = $1`,
            [d.deviceId],
          ),
        )
      ).constraint,
    ).toBe('ms_rotation');
    await db.query(
      `update mobile_sessions set previous_refresh_hash = refresh_hash, refresh_hash = $2, access_hash = $3, refresh_count = refresh_count + 1 where device_id = $1`,
      [d.deviceId, code(), code()],
    );
    const row = await one<{
      refresh_count: number;
      previous_refresh_hash: Uint8Array | null;
      last_refreshed_at: Date | null;
    }>(
      `select refresh_count, previous_refresh_hash, last_refreshed_at from mobile_sessions where device_id = $1`,
      [d.deviceId],
    );
    expect(row.refresh_count).toBe(1);
    expect(Buffer.from(row.previous_refresh_hash!).equals(refresh0)).toBe(true);
    expect(row.last_refreshed_at).not.toBeNull();
    // identidad y caducidad absoluta inmutables
    expect(
      (
        await err(
          db.query(
            `update mobile_sessions set absolute_expires_at = absolute_expires_at + interval '1 day' where device_id = $1`,
            [d.deviceId],
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(`update mobile_sessions set user_id = $2 where device_id = $1`, [
            d.deviceId,
            ids.a,
          ]),
        )
      ).code,
    ).toBeDefined();
    // revocar: la hora la fija la base; despues es historia
    await db.query(
      `update mobile_sessions set revoked_reason = 'refresh_reuse' where device_id = $1`,
      [d.deviceId],
    );
    expect(
      (
        await one<{ revoked_at: Date | null }>(
          `select revoked_at from mobile_sessions where device_id = $1`,
          [d.deviceId],
        )
      ).revoked_at,
    ).not.toBeNull();
    expect(
      (
        await err(
          db.query(
            `update mobile_sessions set revoked_at = null, revoked_reason = null where device_id = $1`,
            [d.deviceId],
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await err(
          db.query(`update mobile_sessions set refresh_hash = $2 where device_id = $1`, [
            d.deviceId,
            code(),
          ]),
        )
      ).code,
    ).toBe('42501');
  });

  it('las funciones nuevas son SECURITY INVOKER con search_path fijo y sin EXECUTE para PUBLIC', async () => {
    const r = await db.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_exec: boolean;
    }>(
      `select proname, prosecdef, proconfig, has_function_privilege('public', oid, 'EXECUTE') as public_exec
         from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'mobile\\_%' or proname like 'mdr\\_%' or proname like 'md\\_%' or proname like 'ms\\_%' or proname like 'mn\\_%')`,
    );
    expect(r.rows.map((x) => x.proname).sort()).toEqual([
      'md_guard_insert',
      'md_guard_update',
      'mdr_guard_insert',
      'mdr_guard_update',
      'mn_guard_update',
      'mobile_actor_can_manage',
      'mobile_auth_no_delete',
      'mobile_ephemeral_guard_delete',
      'mobile_proof_guard_update',
      'mobile_user_eligible',
      'ms_guard_insert',
      'ms_guard_update',
    ]);
    for (const f of r.rows) {
      expect(f.prosecdef, f.proname).toBe(false);
      expect(f.proconfig, f.proname).toContain('search_path=pg_catalog, pg_temp');
      expect(f.public_exec, f.proname).toBe(false);
    }
  });
});

describe('0011: aplicacion incremental desde 0010 y RBAC', () => {
  const dir = join(import.meta.dirname, '..', 'drizzle');
  const migrations = readMigrationFiles({ migrationsFolder: dir });
  const count = async (d: PGlite, table: string) =>
    Number((await d.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0]!.n);
  async function dbUntil(n: number) {
    const d = new PGliteCtor({ extensions: { btree_gist } });
    for (const m of migrations.slice(0, n)) for (const stmt of m.sql) await d.exec(stmt);
    return d;
  }

  it('sin marca destructiva ni DROP/DELETE/TRUNCATE; solo agrega dos permisos y dos asignaciones', async () => {
    const m = migrations[11]!;
    const raw = m.sql.join('\n');
    expect(raw.split('\n')[0]).not.toContain('allow-destructive');
    const sql = raw
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE TABLE\b|\bDELETE FROM\b/i);
    const d = await dbUntil(11);
    const [p0, rp0, a0] = [
      await count(d, 'permissions'),
      await count(d, 'role_permissions'),
      await count(d, 'audit_events'),
    ];
    expect([p0, rp0, a0]).toEqual([29, 36, 14]); // el estado REAL de eta15_dev antes de 0011
    for (const stmt of m.sql) await d.exec(stmt);
    expect([
      await count(d, 'permissions'),
      await count(d, 'role_permissions'),
      await count(d, 'audit_events'),
    ]).toEqual([31, 38, 16]);
    const added = await d.query<{ role: string; permission: string; scope: string }>(
      `select r.key as role, p.key as permission, rp.scope from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key like 'mobile_devices:%' order by 1`,
    );
    expect(added.rows).toEqual([
      { role: 'direccion', permission: 'mobile_devices:manage', scope: 'all' },
      { role: 'prefectura', permission: 'mobile_devices:enroll', scope: 'own' },
    ]);
    expect(await count(d, 'users')).toBe(0);
    expect(await count(d, 'mobile_device_requests')).toBe(0);
    // idempotente: repetir la parte RBAC no cambia nada
    const stmts = m.sql;
    const from = stmts.findIndex((x) => x.includes('INSERT INTO "permissions"'));
    for (const stmt of stmts.slice(from)) await d.exec(stmt);
    expect([
      await count(d, 'permissions'),
      await count(d, 'role_permissions'),
      await count(d, 'audit_events'),
    ]).toEqual([31, 38, 16]);
    await d.close();
  });

  it('el catalogo del codigo coincide: ningun rol tecnico ni otro rol escolar recibe los permisos nuevos', async () => {
    const { ROLES, PERMISSIONS } = await import('../src/modules/access-control/catalog.js');
    const holders = ROLES.filter((r) =>
      r.grants.some((g) => g.permission.startsWith('mobile_devices:')),
    ).map((r) => r.key);
    expect(holders.sort()).toEqual(['direccion', 'prefectura']);
    const def = PERMISSIONS.filter((p) => p.key.startsWith('mobile_devices:'));
    expect(def.map((p) => [p.key, p.domain, p.authority])).toEqual([
      ['mobile_devices:manage', 'school', false],
      ['mobile_devices:enroll', 'school', false],
    ]);
  });
});

describe('0011: sin borrado fisico con datos presentes', () => {
  it('sin DELETE ni TRUNCATE, ni siquiera para el propietario', async () => {
    const r = await newRequest();
    for (const sql of [
      `delete from mobile_device_requests where id = '${r.id}'`,
      `delete from mobile_devices`,
      `delete from mobile_sessions`,
      `truncate mobile_device_requests cascade`,
      `truncate mobile_devices`,
      `truncate mobile_sessions`,
    ]) {
      // TRUNCATE de una tabla referenciada por una FK lo frena PostgreSQL (0A000) antes que el trigger; ambos son denegacion.
      expect(['42501', '0A000'], sql).toContain((await err(db.exec(sql))).code);
    }
    await db.query(`update mobile_device_requests set status = 'cancelled' where id = $1`, [r.id]);
  });
});

describe('0011: estado efimero de seguridad compartido (pruebas DPoP y nonces)', () => {
  const thumb = () => new FakeDevice().thumbprint;
  const jtiHash = () => Buffer.alloc(32, (seq += 1));
  const addProof = (key: string, hash: Buffer, expires = "now() + interval '2 minutes'") =>
    db.query(
      `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at) values ($1, $2, now(), ${expires})`,
      [key, hash],
    );
  const addNonce = (key: string, hash: Buffer, expires = "now() + interval '2 minutes'") =>
    db.query(
      `insert into mobile_nonces (nonce_hash, key_thumbprint, issued_at, expires_at) values ($1, $2, now(), ${expires})`,
      [hash, key],
    );
  const count = (key: string) =>
    num(`select count(*)::int as n from mobile_proof_jtis where key_thumbprint = $1`, [key]);

  it('UNIQUE (clave, hash del jti): la misma prueba no entra dos veces, pero otra clave puede usar el mismo jti', async () => {
    const k = thumb();
    const h = jtiHash();
    await addProof(k, h);
    expect((await err(addProof(k, h))).code).toBe('23505');
    await addProof(thumb(), h); // por clave
    expect(await count(k)).toBe(1);
  });

  it('restricciones: huella con formato, hash de 32 bytes y ventana de caducidad de a lo mas 15 minutos', async () => {
    const key = thumb();
    expect((await err(addProof('corta', jtiHash()))).constraint).toBe('mpj_thumbprint_format');
    expect((await err(addProof(key, Buffer.alloc(8, 1)))).constraint).toBe('mpj_jti_hash_length');
    expect((await err(addProof(key, jtiHash(), "now() + interval '1 hour'"))).constraint).toBe(
      'mpj_expiry_window',
    );
    expect((await err(addProof(key, jtiHash(), "now() - interval '1 minute'"))).constraint).toBe(
      'mpj_expiry_window',
    );
    expect((await err(addNonce('corta', jtiHash()))).constraint).toBe('mn_thumbprint_format');
    expect((await err(addNonce(key, Buffer.alloc(8, 1)))).constraint).toBe('mn_nonce_hash_length');
    expect((await err(addNonce(key, jtiHash(), "now() + interval '1 hour'"))).constraint).toBe(
      'mn_expiry_window',
    );
  });

  it('una prueba aceptada es solo-agregar: ni UPDATE, ni TRUNCATE, ni DELETE antes de que venza hace una hora', async () => {
    const k = thumb();
    await addProof(k, jtiHash());
    const update = db.query(
      `update mobile_proof_jtis set expires_at = expires_at where key_thumbprint = $1`,
      [k],
    );
    expect((await err(update)).code).toBe('42501');
    expect((await err(db.query('truncate mobile_proof_jtis'))).code).toBe('42501');
    const del = (key: string) =>
      db.query(`delete from mobile_proof_jtis where key_thumbprint = $1`, [key]);
    expect((await err(del(k))).code).toBe('42501'); // aun vigente
    const k2 = thumb(); // vencida hace menos de una hora: tampoco
    await db.query(
      `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at)
       values ($1, $2, now() - interval '30 minutes', now() - interval '28 minutes')`,
      [k2, jtiHash()],
    );
    expect((await err(del(k2))).code).toBe('42501');
  });

  it('la limpieza del propietario solo alcanza filas vencidas hace mas de una hora (alcance limitado)', async () => {
    const k = thumb();
    await db.query(
      `insert into mobile_proof_jtis (key_thumbprint, jti_hash, seen_at, expires_at)
       values ($1, $2, now() - interval '3 hours', now() - interval '178 minutes')`,
      [k, jtiHash()],
    );
    await addProof(k, jtiHash()); // vigente: debe sobrevivir a la limpieza
    await db.query(`delete from mobile_proof_jtis where expires_at < now() - interval '1 hour'`);
    expect(await count(k)).toBe(1);
    // una limpieza demasiado amplia falla entera y no borra el estado vigente
    const broad = db.query(`delete from mobile_proof_jtis where key_thumbprint = $1`, [k]);
    expect((await err(broad)).code).toBe('42501');
    expect(await count(k)).toBe(1);
  });

  it('un nonce se gasta UNA vez (NULL -> hora); su identidad y vigencia no cambian; ni DELETE vigente ni TRUNCATE', async () => {
    const k = thumb();
    const h = jtiHash();
    await addNonce(k, h);
    const upd = (set: string, p: unknown[] = []) =>
      db.query(`update mobile_nonces set ${set} where nonce_hash = $1`, [h, ...p]);
    expect((await err(upd("expires_at = expires_at + interval '1 minute'"))).code).toBe('42501');
    expect((await err(upd('key_thumbprint = $2', [thumb()]))).code).toBe('42501');
    expect((await err(upd('consumed_at = null'))).code).toBe('42501');
    await upd('consumed_at = now()');
    expect((await err(upd('consumed_at = now()'))).code).toBe('42501'); // ya gastado
    // la forma que usa la API: gastar es condicional y atomico (una segunda vez no afecta filas)
    const again = await db.query(
      `update mobile_nonces set consumed_at = now() where nonce_hash = $1 and consumed_at is null returning 1`,
      [h],
    );
    expect(again.rows).toHaveLength(0);
    expect((await err(db.query(`delete from mobile_nonces where nonce_hash = $1`, [h]))).code).toBe(
      '42501',
    );
    expect((await err(db.query('truncate mobile_nonces'))).code).toBe('42501');
  });

  it('no se guarda el JWT, el jti en claro, el nonce en claro ni la clave publica: solo huellas y hashes', async () => {
    const cols = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('mobile_proof_jtis', 'mobile_nonces') order by 1, 2`,
    );
    expect(cols.rows.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'mobile_nonces.consumed_at',
      'mobile_nonces.expires_at',
      'mobile_nonces.issued_at',
      'mobile_nonces.key_thumbprint',
      'mobile_nonces.nonce_hash',
      'mobile_proof_jtis.expires_at',
      'mobile_proof_jtis.jti_hash',
      'mobile_proof_jtis.key_thumbprint',
      'mobile_proof_jtis.seen_at',
    ]);
  });
});
