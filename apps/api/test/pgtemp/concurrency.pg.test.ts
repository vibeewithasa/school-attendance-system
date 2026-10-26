import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTempPostgres, type TempPostgres } from '../helpers/pg-temp.js';

/**
 * Concurrencia REAL de Auth/RBAC: varias conexiones y transacciones simultaneas contra un clúster
 * PostgreSQL 18 desechable (carpeta temporal, puerto propio en loopback). NO usa eta15_dev ni el servicio
 * de Windows. Ejecutar con:  pnpm test:pg-temp   (falla si no encuentra initdb/pg_ctl; define PG_BIN si hace falta).
 * Los "usuarios" son filas ficticias; no hay contrasenas reales.
 */

let pgt: TempPostgres;
let admin: pg.Client;
/** Titular escolar inicial (bootstrap en beforeAll): autoridad estable para las pruebas. */
let schoolBoss: string;

const FAKE = 'hash-ficticio-de-prueba';
const hex = (n: number) => `decode(lpad(to_hex(${n}), 64, '0'), 'hex')`;
let seq = 0;
const email = (p: string) => `${p}-${++seq}@escuela.mx`;

async function addUser(
  c: pg.Client,
  domain: 'school' | 'technical',
  status = 'active',
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into users (email, display_name, account_domain, status, password_hash) values ($1,'Persona de prueba',$2,$3,$4) returning id`,
    [email(domain), domain, status, status === 'pending' ? null : FAKE],
  );
  return r.rows[0]!.id;
}
async function grantTo(
  c: pg.Client,
  user: string,
  roleKey: string,
  by: string | null,
  source = 'grant',
  ref: string | null = null,
) {
  await c.query(
    `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
     select $1, r.id, r.domain, $3, $4, $5 from roles r where r.key = $2`,
    [user, roleKey, by, source, ref],
  );
}
/** Resuelve 'pending' si la promesa sigue bloqueada tras `ms`; si no, devuelve su resultado. */
async function settledWithin<T>(
  p: Promise<T>,
  ms: number,
): Promise<'pending' | { ok: T } | { error: Error }> {
  const timeout = new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms));
  return Promise.race([
    p.then(
      (ok) => ({ ok }),
      (error: Error) => ({ error }),
    ),
    timeout,
  ]);
}

beforeAll(async () => {
  pgt = await startTempPostgres();
  admin = await pgt.connect();
  await applyMigrations(admin);
  await admin.query(`create role api_runtime login`);
  await admin.query(`grant usage on schema public to api_runtime`);
  await admin.query(
    `grant select, insert, update, delete, truncate, references on all tables in schema public to api_runtime`,
  );
  await admin.query(
    `grant execute on function auth_is_schema_owner(), auth_lock_authority(uuid, text), auth_current_actor() to api_runtime`,
  );
  schoolBoss = await addUser(admin, 'school');
  await grantTo(admin, schoolBoss, 'direccion', null, 'bootstrap', 'ACTA-ARRANQUE-PRUEBA');
}, 180_000);
afterAll(async () => {
  await pgt?.stop();
}, 60_000);

describe('motor real', () => {
  it('es PostgreSQL 18 y las migraciones 0000-0005 estan aplicadas', async () => {
    const v = await admin.query<{ v: number }>(
      `select current_setting('server_version_num')::int v`,
    );
    expect(v.rows[0]!.v).toBeGreaterThanOrEqual(180000);
    const t = await admin.query<{ n: number }>(
      `select count(*)::int n from pg_trigger where not tgisinternal`,
    );
    expect(t.rows[0]!.n).toBeGreaterThan(20);
  });
});

describe('bootstrap concurrente', () => {
  it('dos bootstrap simultaneos del mismo dominio: se serializan y solo uno prospera', async () => {
    const a = await addUser(admin, 'technical');
    const b = await addUser(admin, 'technical');
    const c1 = await pgt.connect();
    const c2 = await pgt.connect();
    await c1.query('begin');
    await c2.query('begin');
    await grantTo(c1, a, 'admin_tecnico', null, 'bootstrap', 'ACTA-CONC-1'); // toma el bloqueo consultivo
    const second = grantTo(c2, b, 'admin_tecnico', null, 'bootstrap', 'ACTA-CONC-2');
    expect(await settledWithin(second, 400)).toBe('pending'); // el segundo ESPERA al primero
    await c1.query('commit');
    const outcome = await settledWithin(second, 5000);
    expect(outcome).toHaveProperty('error');
    expect((outcome as { error: Error }).error.message).toMatch(/Bootstrap cerrado/);
    await c2.query('rollback');
    const n = await admin.query<{ n: number }>(
      `select count(*)::int n from user_roles where domain='technical'`,
    );
    expect(n.rows[0]!.n).toBe(1);
  });
  it('el rol de la API (conexion real, no propietario) no puede hacer bootstrap', async () => {
    const api = await pgt.connect('api_runtime');
    const u = await addUser(admin, 'school');
    await expect(grantTo(api, u, 'direccion', null, 'bootstrap', 'ACTA-API')).rejects.toThrow(
      /Solo el propietario del esquema/,
    );
  });
});

describe('consumo concurrente de tokens', () => {
  async function authorizedToken(n: number): Promise<{ user: string }> {
    const user = await addUser(admin, 'school');
    await admin.query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,'password_reset',${hex(n)}, now() + interval '30 minutes')`,
      [user],
    );
    await admin.query(
      `update auth_tokens set authorized_at=now(), authorized_by=$1, verification_method='in_person_id' where token_hash=${hex(n)}`,
      [schoolBoss],
    );
    return { user };
  }
  const consume = (c: pg.Client, n: number) =>
    c.query(
      `update auth_tokens set used_at = now()
        where token_hash = ${hex(n)} and used_at is null and invalidated_at is null and authorized_at is not null and expires_at > now()
        returning id`,
    );

  it('dos transacciones consumen el mismo token: exactamente una lo obtiene', async () => {
    await authorizedToken(1001);
    const c1 = await pgt.connect();
    const c2 = await pgt.connect();
    await c1.query('begin');
    await c2.query('begin');
    const first = await consume(c1, 1001); // bloquea la fila
    const second = consume(c2, 1001);
    expect(await settledWithin(second, 400)).toBe('pending');
    await c1.query('commit');
    const r2 = await second;
    await c2.query('commit');
    expect(first.rowCount).toBe(1);
    expect(r2.rowCount).toBe(0);
  });
  it('20 intentos paralelos desde 8 conexiones: un solo exito', async () => {
    await authorizedToken(1002);
    const clients = await Promise.all(Array.from({ length: 8 }, () => pgt.connect()));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => consume(clients[i % clients.length]!, 1002)),
    );
    expect(results.reduce((acc, r) => acc + (r.rowCount ?? 0), 0)).toBe(1);
  });
  it('si la cuenta no esta autorizada nadie la consume, ni con intentos paralelos', async () => {
    const user = await addUser(admin, 'school');
    await admin.query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,'password_reset',${hex(1003)}, now() + interval '30 minutes')`,
      [user],
    );
    const results = await Promise.all(Array.from({ length: 6 }, () => consume(admin, 1003)));
    expect(results.reduce((acc, r) => acc + (r.rowCount ?? 0), 0)).toBe(0);
  });
});

describe('concesion de roles concurrente con revocacion de la autoridad', () => {
  it('la revocacion del concedente ESPERA a la concesion en curso (sin privilegios inconsistentes)', async () => {
    const d1 = schoolBoss;
    const d2 = await addUser(admin, 'school');
    const p = await addUser(admin, 'school');
    await grantTo(admin, d2, 'direccion', d1);

    const api1 = await pgt.connect('api_runtime');
    const api2 = await pgt.connect('api_runtime');
    await api1.query('begin');
    await api2.query('begin');
    await grantTo(api1, p, 'prefectura', d2); // d2 concede; se toma FOR SHARE sobre la autoridad de d2
    const revokeD2 = api2.query(
      `update user_roles set revoked_at = now(), revoked_by = $1 where user_id = $2 and revoked_at is null`,
      [d1, d2],
    );
    expect(await settledWithin(revokeD2, 400)).toBe('pending'); // la revocacion espera
    await api1.query('commit');
    await revokeD2;
    await api2.query('commit');

    const granted = await admin.query<{ by: string }>(
      `select granted_by by from user_roles where user_id=$1 and revoked_at is null`,
      [p],
    );
    expect(granted.rows[0]!.by).toBe(d2); // la concesion se hizo mientras d2 tenia autoridad
    const after = await admin.query<{ n: number }>(
      `select count(*)::int n from user_roles where user_id=$1 and revoked_at is null`,
      [d2],
    );
    expect(after.rows[0]!.n).toBe(0);
    // Orden inverso: ya sin autoridad, d2 no puede conceder
    await expect(grantTo(api1, await addUser(admin, 'school'), 'prefectura', d2)).rejects.toThrow(
      /roles:grant_school/,
    );
  });

  it('la baja concurrente de la cuenta destino espera a la concesion y termina consistente', async () => {
    const holder = schoolBoss;
    const target = await addUser(admin, 'school');
    const api1 = await pgt.connect('api_runtime');
    const api2 = await pgt.connect('api_runtime');
    await api1.query('begin');
    await api2.query('begin');
    await grantTo(api1, target, 'control_acceso', holder);
    const disable = api2.query(`update users set status='disabled' where id=$1`, [target]);
    expect(await settledWithin(disable, 400)).toBe('pending');
    await api1.query('commit');
    await disable;
    await api2.query('commit');
    const s = await admin.query<{ status: string }>(`select status from users where id=$1`, [
      target,
    ]);
    expect(s.rows[0]!.status).toBe('disabled');
  });
});

describe('sesiones concurrentes', () => {
  it('12 inicios de sesion simultaneos: nunca mas de 5 sesiones vigentes', async () => {
    const holder = schoolBoss;
    const u = await addUser(admin, 'school');
    await grantTo(admin, u, 'prefectura', holder);
    const clients = await Promise.all(Array.from({ length: 12 }, () => pgt.connect('api_runtime')));
    await Promise.all(
      clients.map((c, i) =>
        c.query(
          `insert into sessions (user_id, token_hash, expires_at, idle_expires_at) values ($1, ${hex(5000 + i)}, now() + interval '8 hours', now() + interval '1 hour')`,
          [u],
        ),
      ),
    );
    const active = await admin.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_at is null and now() < least(expires_at, idle_expires_at)`,
      [u],
    );
    expect(active.rows[0]!.n).toBe(5);
    const revoked = await admin.query<{ n: number }>(
      `select count(*)::int n from sessions where user_id=$1 and revoked_reason='concurrency'`,
      [u],
    );
    expect(revoked.rows[0]!.n).toBe(7);
  });
});

describe('proteccion frente al rol de la API en el motor real', () => {
  it('no puede alterar la auditoria ni deshabilitar sus triggers', async () => {
    const api = await pgt.connect('api_runtime');
    await expect(api.query(`update audit_events set outcome='success'`)).rejects.toThrow(
      /solo insercion/,
    );
    await expect(api.query(`delete from audit_events`)).rejects.toThrow(/solo insercion/);
    await expect(api.query(`truncate audit_events`)).rejects.toThrow(/solo insercion/);
    await expect(
      api.query(`alter table audit_events disable trigger audit_events_no_update_delete`),
    ).rejects.toThrow(/must be owner/i);
  });
  it('no puede delegar autoridad ni borrar el historial de roles', async () => {
    const api = await pgt.connect('api_runtime');
    await expect(
      api.query(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key='prefectura' and p.key='roles:grant_school'`,
      ),
    ).rejects.toThrow(/permisos de autoridad solo los cambia el propietario/);
    await expect(api.query(`delete from user_roles`)).rejects.toThrow(/no se elimina/);
  });
  it('el propietario SI puede deshabilitar el trigger de auditoria (limite conocido, no hay inmutabilidad absoluta)', async () => {
    await admin.query(`alter table audit_events disable trigger audit_events_no_update_delete`);
    const r = await admin.query(`update audit_events set outcome = outcome where false`);
    expect(r.rowCount).toBe(0);
    await admin.query(
      `alter table audit_events enable always trigger audit_events_no_update_delete`,
    );
  });
});
