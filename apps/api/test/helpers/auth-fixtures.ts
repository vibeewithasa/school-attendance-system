import type { PGlite } from '@electric-sql/pglite';

/** Fixtures para pruebas de Auth con cuentas, hashes y actas FICTICIOS. No hay secretos reales. */
export const FAKE_HASH = 'hash-ficticio-de-prueba'; // no es el hash de ninguna contrasena
/** 32 bytes unicos por n (hash ficticio, no es SHA-256 de nada). */
export const hashN = (n: number) => `decode(lpad(to_hex(${n}), 64, '0'), 'hex')`;

export type Domain = 'school' | 'technical';

/** Alta directa como propietario (equivale a datos sembrados / consola). */
export async function addUser(
  db: PGlite,
  email: string,
  domain: Domain,
  status: 'pending' | 'active' | 'disabled' = 'active',
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into users (email, display_name, account_domain, status, password_hash)
     values ($1, 'Persona de prueba', $2, $3, $4) returning id`,
    [email, domain, status, status === 'pending' ? null : FAKE_HASH],
  );
  return r.rows[0]!.id;
}

export async function roleId(db: PGlite, key: string): Promise<string> {
  return (await db.query<{ id: string }>(`select id from roles where key=$1`, [key])).rows[0]!.id;
}

export async function grant(
  db: PGlite,
  userId: string,
  roleKey: string,
  by: string | null,
  source: 'grant' | 'bootstrap' | 'recovery' = 'grant',
  reference: string | null = null,
): Promise<void> {
  const d = (await db.query<{ domain: string }>(`select domain from roles where key=$1`, [roleKey]))
    .rows[0]!.domain;
  await db.query(
    `insert into user_roles (user_id, role_id, domain, granted_by, grant_source, grant_reference)
     values ($1,$2,$3,$4,$5,$6)`,
    [userId, await roleId(db, roleKey), d, by, source, reference],
  );
}

export const bootstrap = (db: PGlite, userId: string, roleKey: string, ref = 'ACTA-PRUEBA-001') =>
  grant(db, userId, roleKey, null, 'bootstrap', ref);

export async function revoke(
  db: PGlite,
  userId: string,
  roleKey: string,
  by: string,
): Promise<void> {
  await db.query(
    `update user_roles set revoked_at = now(), revoked_by = $3 where user_id=$1 and role_id=$2 and revoked_at is null`,
    [userId, await roleId(db, roleKey), by],
  );
}

/**
 * Rol de ejecucion SIMULADO de la API: NO propietario y con el peor caso de privilegios de DATOS
 * (todo salvo TRIGGER: ese privilegio permite adjuntar triggers propios y NUNCA debe concederse; ver auth-functions.test.ts).
 */
export async function createApiRole(db: PGlite): Promise<void> {
  await db.exec(`create role api_runtime nologin`);
  await db.exec(`grant usage on schema public to api_runtime`);
  await db.exec(
    `grant select, insert, update, delete, truncate, references on all tables in schema public to api_runtime`,
  );
  // Unicos EXECUTE necesarios (los ayudantes que invocan los triggers); el resto de funciones no se conceden.
  await db.exec(
    `grant execute on function auth_is_schema_owner(), auth_lock_authority(uuid, text), auth_current_actor() to api_runtime`,
  );
}

/** Ejecuta `fn` con el rol de la API (no propietario) y restaura al propietario. */
export async function asApi<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role api_runtime`);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // En una transaccion abortada RESET ROLE falla: no debe ocultar el error original (ROLLBACK lo deshace).
    await db.exec(`reset role`).catch(() => undefined);
    throw error;
  }
  await db.exec(`reset role`);
  return result;
}

export async function addSession(
  db: PGlite,
  userId: string,
  n: number,
  createdMinutesAgo = 0,
): Promise<void> {
  await db.query(
    `insert into sessions (user_id, token_hash, created_at, last_seen_at, expires_at, idle_expires_at)
     values ($1, ${hashN(n)}, now() - ($2 || ' minutes')::interval, now() - ($2 || ' minutes')::interval,
             now() + interval '8 hours', now() + interval '1 hour')`,
    [userId, String(createdMinutesAgo)],
  );
}

export async function sessionReasons(db: PGlite, userId: string): Promise<Array<string | null>> {
  const r = await db.query<{ revoked_reason: string | null }>(
    `select revoked_reason from sessions where user_id=$1 order by token_hash`,
    [userId],
  );
  return r.rows.map((x) => x.revoked_reason);
}

/** Solicitud de activacion/recuperacion: el hash lo aporta el titular (aqui, un hash ficticio). */
export async function requestToken(
  db: PGlite,
  userId: string,
  n: number,
  purpose: 'invite' | 'password_reset' = 'password_reset',
  ttl = '30 minutes',
): Promise<void> {
  await db.query(
    `insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,$2,${hashN(n)}, now() + interval '${ttl}')`,
    [userId, purpose],
  );
}

export async function authorizeToken(
  db: PGlite,
  n: number,
  by: string | null,
  method: 'in_person_id' | 'in_person_known' | 'ceremony' = 'in_person_id',
): Promise<void> {
  await db.query(
    `update auth_tokens set authorized_at = now(), authorized_by = $1, verification_method = $2 where token_hash = ${hashN(n)}`,
    [by, method],
  );
}

/** Consumo atomico: devuelve cuantas filas se consumieron (0 o 1). */
export async function consumeToken(db: PGlite, n: number): Promise<number> {
  const r = await db.query(
    `update auth_tokens set used_at = now()
      where token_hash = ${hashN(n)} and used_at is null and invalidated_at is null
        and authorized_at is not null and expires_at > now()
      returning id`,
  );
  return r.rows.length;
}
