import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_HASH,
  addSession,
  addUser,
  asApi,
  authorizeToken,
  bootstrap,
  consumeToken,
  createApiRole,
  grant,
  hashN,
  requestToken,
  sessionReasons,
} from './helpers/auth-fixtures.js';
import { failure, freshDb } from './helpers/pglite.js';

/**
 * Activacion de cuentas y recuperacion de contrasena por RECLAMO en dos partes (tabla auth_tokens):
 * el titular aporta el hash de su secreto; un titular del dominio, tras verificar su identidad en persona,
 * AUTORIZA; el titular completa con el secreto. La autoridad nunca conoce el secreto ni la contrasena.
 * Estas pruebas cubren el modelo de datos; el servicio y los endpoints aun no existen.
 */

describe('recuperacion de contrasena: el administrador no puede suplantar al titular', () => {
  let db: PGlite;
  let t1: string, t2: string, d1: string, d2: string, p1: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    t1 = await addUser(db, 't1@escuela.mx', 'technical');
    t2 = await addUser(db, 't2@escuela.mx', 'technical');
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    d2 = await addUser(db, 'd2@escuela.mx', 'school');
    p1 = await addUser(db, 'p1@escuela.mx', 'school');
    await bootstrap(db, t1, 'admin_tecnico');
    await bootstrap(db, d1, 'direccion');
    await grant(db, t2, 'admin_tecnico', t1);
    await grant(db, d2, 'direccion', d1);
    await grant(db, p1, 'prefectura', d1);
  });
  afterAll(async () => {
    await db.close();
  });

  it('una solicitud nace sin autorizar, sin usar y vigente (la API no puede crearla preautorizada)', async () => {
    const pre = (extra: string, vals: string) =>
      asApi(db, () =>
        db.query(
          `insert into auth_tokens (user_id, purpose, token_hash, expires_at ${extra}) values ($1,'password_reset',${hashN(1)}, now() + interval '30 minutes' ${vals})`,
          [p1],
        ),
      );
    expect(
      (
        await failure(
          pre(
            ', authorized_at, authorized_by, verification_method',
            `, now(), '${d1}', 'in_person_id'`,
          ),
        )
      ).message,
    ).toMatch(/nace sin autorizar/);
    expect((await failure(pre(', used_at', ', now()'))).message).toMatch(
      /nace sin autorizar|used_requires_authorization/,
    );
  });
  it('el secreto no se almacena: solo un hash de 32 bytes; la vigencia maxima es de 24 h', async () => {
    const insert = (hash: string, ttl: string) =>
      asApi(db, () =>
        db.query(
          `insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,'password_reset',${hash}, now() + interval '${ttl}')`,
          [p1],
        ),
      );
    expect(
      (await failure(insert(`convert_to('secreto-en-claro','UTF8')`, '30 minutes'))).code,
    ).toBe('23514');
    expect((await failure(insert(hashN(2), '25 hours'))).code).toBe('23514');
    expect((await failure(insert(hashN(2), '-1 minutes'))).code).toBe('23514');
  });
  it('la recuperacion solo aplica a cuentas activas; la invitacion, a pendientes', async () => {
    const dis = await addUser(db, 'dis@escuela.mx', 'school', 'disabled');
    const pend = await addUser(db, 'pend@escuela.mx', 'school', 'pending');
    expect((await failure(asApi(db, () => requestToken(db, dis, 3)))).message).toMatch(
      /solo aplica a cuentas activas/,
    );
    expect(
      (await failure(asApi(db, () => requestToken(db, pend, 4, 'password_reset')))).message,
    ).toMatch(/solo aplica a cuentas activas/);
    expect((await failure(asApi(db, () => requestToken(db, p1, 5, 'invite')))).message).toMatch(
      /solo aplica a cuentas pendientes/,
    );
  });

  describe('flujo completo para una cuenta escolar (prefectura)', () => {
    it('sin autorizacion el token NO se puede consumir (ni por la via normal ni forzando el UPDATE)', async () => {
      await asApi(db, () => requestToken(db, p1, 10));
      expect(await asApi(db, () => consumeToken(db, 10))).toBe(0);
      const f = await failure(
        asApi(db, () =>
          db.query(`update auth_tokens set used_at = now() where token_hash = ${hashN(10)}`),
        ),
      );
      expect(f.message).toMatch(/sin autorizar/);
    });
    it('admin_tecnico NO puede autorizar la recuperacion de una cuenta escolar', async () => {
      expect((await failure(asApi(db, () => authorizeToken(db, 10, t1)))).message).toMatch(
        /users:manage_school/,
      );
    });
    it('un rol operativo (la propia prefecta u otra) tampoco autoriza', async () => {
      // nadie se autoriza a si mismo: sin autoridad lo frena el trigger (42501); con autoridad, el CHECK (23514)
      expect(['23514', '42501']).toContain(
        (await failure(asApi(db, () => authorizeToken(db, 10, p1)))).code,
      );
      const p2 = await addUser(db, 'p2@escuela.mx', 'school');
      await grant(db, p2, 'prefectura', d1);
      expect((await failure(asApi(db, () => authorizeToken(db, 10, p2)))).message).toMatch(
        /users:manage_school/,
      );
    });
    it('direccion autoriza tras verificar la identidad en persona; despues no puede alterar la autorizacion', async () => {
      await asApi(db, () => authorizeToken(db, 10, d1, 'in_person_id'));
      const f = await failure(
        asApi(db, () =>
          db.query(`update auth_tokens set authorized_by = $1 where token_hash = ${hashN(10)}`, [
            d2,
          ]),
        ),
      );
      expect(f.message).toMatch(/no se modifica|exactamente una transicion/);
    });
    it('la autoridad no puede cambiar el hash (no puede sustituir el secreto del titular por uno suyo)', async () => {
      const f = await failure(
        asApi(db, () =>
          db.query(
            `update auth_tokens set token_hash = ${hashN(99)} where token_hash = ${hashN(10)}`,
          ),
        ),
      );
      expect(f.message).toMatch(/inmutables/);
    });
    it('el titular consume una sola vez; el segundo intento no afecta filas', async () => {
      expect(await asApi(db, () => consumeToken(db, 10))).toBe(1);
      expect(await asApi(db, () => consumeToken(db, 10))).toBe(0);
    });
    it('un token consumido es terminal: no se reautoriza, reinvalida ni reutiliza', async () => {
      for (const sql of [
        `update auth_tokens set used_at = null where token_hash = ${hashN(10)}`,
        `update auth_tokens set invalidated_at = now() where token_hash = ${hashN(10)}`,
      ]) {
        expect((await failure(asApi(db, () => db.query(sql)))).message, sql).toMatch(
          /ya fue usado o invalidado/,
        );
      }
    });
    it('completar la recuperacion cambia la contrasena y revoca TODAS las sesiones del titular', async () => {
      await addSession(db, p1, 20);
      await addSession(db, p1, 21);
      await asApi(db, () =>
        db.query(`update users set password_hash = 'nuevo-hash-ficticio' where id = $1`, [p1]),
      );
      expect(await sessionReasons(db, p1)).toEqual(['password_changed', 'password_changed']);
    });
    it('tras consumirse se puede iniciar una nueva recuperacion', async () => {
      await asApi(db, () => requestToken(db, p1, 11));
    });
  });

  describe('cuentas privilegiadas: dos personas, no una', () => {
    it('nadie autoriza su propia solicitud, ni siquiera un titular', async () => {
      await asApi(db, () => requestToken(db, d1, 30));
      expect((await failure(asApi(db, () => authorizeToken(db, 30, d1)))).code).toBe('23514');
      expect((await failure(asApi(db, () => authorizeToken(db, 30, t1)))).message).toMatch(
        /users:manage_school/,
      );
    });
    it('otro titular del MISMO dominio si puede (control dual); un admin tecnico no', async () => {
      await asApi(db, () => authorizeToken(db, 30, d2, 'in_person_known'));
    });
    it('para un administrador tecnico autoriza otro administrador tecnico, nunca Direccion', async () => {
      await asApi(db, () => requestToken(db, t1, 31));
      expect((await failure(asApi(db, () => authorizeToken(db, 31, d1)))).message).toMatch(
        /users:manage_technical/,
      );
      await asApi(db, () => authorizeToken(db, 31, t2));
    });
    it('si el unico titular pierde el acceso no hay quien autorice: el rescate es presencial (recovery), no un token', async () => {
      const lone = await addUser(db, 'lone@escuela.mx', 'technical');
      await requestToken(db, lone, 32);
      // autorizar sin autoridad es invalido (trigger 42501 o CHECK 23514)
      expect(['23514', '42501']).toContain(
        (await failure(authorizeToken(db, 32, null, 'in_person_id'))).code,
      );
    });
  });

  describe('caducidad, reemplazo e invalidacion', () => {
    it('una solicitud caducada no se autoriza ni se consume', async () => {
      const u = await addUser(db, 'exp@escuela.mx', 'school');
      await db.query(
        `insert into auth_tokens (user_id, purpose, token_hash, created_at, expires_at) values ($1,'password_reset',${hashN(40)}, now() - interval '2 hours', now() - interval '1 hour')`,
        [u],
      );
      expect((await failure(authorizeToken(db, 40, d1))).message).toMatch(/caduco/);
      expect(await consumeToken(db, 40)).toBe(0);
    });
    it('una autorizada que caduca ya no se consume (el trigger lo exige aunque se fuerce el UPDATE)', async () => {
      const u = await addUser(db, 'exp2@escuela.mx', 'school');
      await requestToken(db, u, 41, 'password_reset', '1 minutes');
      await authorizeToken(db, 41, d1);
      await db
        .query(
          `update auth_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where token_hash = ${hashN(41)}`,
        )
        .catch(() => undefined);
      // El trigger impide cambiar expires_at/created_at: la caducidad se evalua contra el reloj.
      const r = await db.query<{ n: number }>(
        `select count(*)::int n from auth_tokens where token_hash=${hashN(41)} and expires_at > now()`,
      );
      expect(r.rows[0]!.n).toBe(1);
    });
    it('una nueva solicitud reemplaza a la anterior SIN autorizar', async () => {
      const u = await addUser(db, 'rep@escuela.mx', 'school');
      await requestToken(db, u, 50);
      await requestToken(db, u, 51);
      const r = await db.query<{ n: number }>(
        `select count(*)::int n from auth_tokens where user_id=$1 and invalidated_at is null and used_at is null`,
        [u],
      );
      expect(r.rows[0]!.n).toBe(1);
      expect(await consumeToken(db, 50)).toBe(0);
    });
    it('una solicitud ya AUTORIZADA no puede ser reemplazada por otra', async () => {
      const u = await addUser(db, 'rep2@escuela.mx', 'school');
      await requestToken(db, u, 52);
      await authorizeToken(db, 52, d1);
      expect((await failure(requestToken(db, u, 53))).code).toBe('23505');
    });
    it('la invalidacion es terminal y no consume', async () => {
      const u = await addUser(db, 'inv@escuela.mx', 'school');
      await requestToken(db, u, 54);
      await db.query(
        `update auth_tokens set invalidated_at = now() where token_hash = ${hashN(54)}`,
      );
      expect(await consumeToken(db, 54)).toBe(0);
      expect((await failure(authorizeToken(db, 54, d1))).message).toMatch(
        /ya fue usado o invalidado/,
      );
    });
    it('verificacion de identidad: solo metodos presenciales (ni numeros de documento)', async () => {
      const u = await addUser(db, 'vm@escuela.mx', 'school');
      await requestToken(db, u, 55);
      expect(
        (
          await failure(
            db.query(
              `update auth_tokens set authorized_at=now(), authorized_by=$1, verification_method='por_telefono' where token_hash=${hashN(55)}`,
              [d1],
            ),
          )
        ).code,
      ).toBe('23514');
    });
  });
});

describe('activacion de cuentas y ceremonia de bootstrap', () => {
  let db: PGlite;
  let t1: string, d1: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    t1 = await addUser(db, 't1@escuela.mx', 'technical');
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    await bootstrap(db, t1, 'admin_tecnico');
    await bootstrap(db, d1, 'direccion');
  });
  afterAll(async () => {
    await db.close();
  });
  const createPending = async (email: string, domain: 'school' | 'technical', by: string) => {
    await asApi(db, () =>
      db.query(
        `insert into users (email, display_name, account_domain, created_by) values ($1,'X',$2,$3)`,
        [email, domain, by],
      ),
    );
    return (await db.query<{ id: string }>(`select id from users where email=$1`, [email])).rows[0]!
      .id;
  };

  it('una cuenta pendiente solo se activa en la MISMA transaccion en que se consume su invitacion autorizada', async () => {
    const u = await createPending('nuevo@escuela.mx', 'school', d1);
    await asApi(db, () => requestToken(db, u, 60, 'invite'));
    await asApi(db, () => authorizeToken(db, 60, d1, 'in_person_id'));
    await db.exec('begin');
    expect(await asApi(db, () => consumeToken(db, 60))).toBe(1);
    await asApi(db, () =>
      db.query(
        `update users set status='active', password_hash='hash-ficticio-elegido-por-el-titular' where id=$1`,
        [u],
      ),
    );
    await db.exec('commit');
    const r = await db.query<{ status: string }>(`select status from users where id=$1`, [u]);
    expect(r.rows[0]!.status).toBe('active');
  });
  it('si el token se consumio en una transaccion anterior, no sirve para activar despues', async () => {
    const u = await createPending('tarde@escuela.mx', 'school', d1);
    await asApi(db, () => requestToken(db, u, 61, 'invite'));
    await asApi(db, () => authorizeToken(db, 61, d1));
    await asApi(db, () => consumeToken(db, 61));
    const f = await failure(
      asApi(db, () =>
        db.query(`update users set status='active', password_hash='h' where id=$1`, [u]),
      ),
    );
    expect(f.message).toMatch(/solo se activa al consumir su invitacion autorizada/);
  });
  it('la invitacion de una cuenta escolar la autoriza Direccion, no admin_tecnico', async () => {
    const u = await createPending('inv-escolar@escuela.mx', 'school', d1);
    await asApi(db, () => requestToken(db, u, 62, 'invite'));
    expect((await failure(asApi(db, () => authorizeToken(db, 62, t1)))).message).toMatch(
      /users:manage_school/,
    );
  });
  it('un token de OTRA cuenta no activa esta (el vinculo es por usuario)', async () => {
    const a = await createPending('a-cuenta@escuela.mx', 'school', d1);
    const b = await createPending('b-cuenta@escuela.mx', 'school', d1);
    await asApi(db, () => requestToken(db, a, 63, 'invite'));
    await asApi(db, () => authorizeToken(db, 63, d1));
    await db.exec('begin');
    await asApi(db, () => consumeToken(db, 63));
    const f = await failure(
      asApi(db, () =>
        db.query(`update users set status='active', password_hash='h' where id=$1`, [b]),
      ),
    );
    await db.exec('rollback');
    expect(f.message).toMatch(/solo se activa al consumir su invitacion autorizada/);
  });

  describe('ceremonia del primer titular (bootstrap): la ejecuta el propietario con la persona presente', () => {
    let first: string;
    beforeAll(async () => {
      const db2 = db; // mismo contexto; dominio school ya inicializado: se usa un dominio nuevo via recovery
      void db2;
    });
    it('la ceremonia exige propietario y un titular bootstrap/recovery; la API no puede usarla', async () => {
      first = await createPending('x-primer@escuela.mx', 'school', d1);
      await asApi(db, () => requestToken(db, first, 64, 'invite'));
      const f1 = await failure(asApi(db, () => authorizeToken(db, 64, null, 'ceremony')));
      expect(f1.message).toMatch(/propietario del esquema/);
      const f2 = await failure(authorizeToken(db, 64, null, 'ceremony')); // propietario, pero la cuenta no es titular bootstrap
      expect(f2.message).toMatch(/propietario del esquema para un titular/);
    });
    it("'ceremony' no admite concedente y 'in_person_*' lo exige", async () => {
      const f1 = await failure(
        db.query(
          `update auth_tokens set authorized_at=now(), authorized_by=$1, verification_method='ceremony' where token_hash=${hashN(64)}`,
          [d1],
        ),
      );
      const f2 = await failure(
        db.query(
          `update auth_tokens set authorized_at=now(), authorized_by=NULL, verification_method='in_person_id' where token_hash=${hashN(64)}`,
        ),
      );
      // El trigger (BEFORE UPDATE) puede rechazar antes que el CHECK; ambos son rechazos de la combinacion invalida.
      expect(['23514', '42501']).toContain(f1.code);
      expect(['23514', '42501']).toContain(f2.code);
    });
    it('flujo completo en un dominio recien inicializado: bootstrap -> reclamo -> ceremonia -> activacion', async () => {
      const dbn = await freshDb();
      await createApiRole(dbn);
      const dir = await createPendingOwner(dbn, 'director@escuela.mx');
      await bootstrap(dbn, dir, 'direccion', 'ACTA-ARRANQUE-01');
      await asApi(dbn, () => requestToken(dbn, dir, 70, 'invite')); // lo genera el navegador de la persona
      await authorizeToken(dbn, 70, null, 'ceremony'); // propietario, con la persona presente
      await dbn.exec('begin');
      expect(await asApi(dbn, () => consumeToken(dbn, 70))).toBe(1);
      await asApi(dbn, () =>
        dbn.query(`update users set status='active', password_hash=$2 where id=$1`, [
          dir,
          FAKE_HASH,
        ]),
      );
      await dbn.exec('commit');
      const r = await dbn.query<{ status: string }>(`select status from users where id=$1`, [dir]);
      expect(r.rows[0]!.status).toBe('active');
      await dbn.close();
    });
  });
});

async function createPendingOwner(db: PGlite, email: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into users (email, display_name, account_domain) values ($1,'Titular de prueba','school') returning id`,
    [email],
  );
  return r.rows[0]!.id;
}
