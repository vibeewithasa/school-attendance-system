import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSession,
  addUser,
  asApi,
  bootstrap,
  createApiRole,
  grant,
  revoke,
  roleId,
  sessionReasons,
} from './helpers/auth-fixtures.js';
import { failure, freshDb } from './helpers/pglite.js';

/**
 * Pruebas ADVERSARIALES de privilegios (migraciones 0003-0005) en PGlite = PostgreSQL 18.6 en memoria.
 * El "atacante" es el rol de ejecucion de la API SIMULADO: no propietario, con TODOS los privilegios de tabla
 * (peor caso). Si las guardas resisten asi, no dependen de que el rol tenga pocos privilegios.
 * No cubre concurrencia real (ver test/pgtemp) ni la aplicacion HTTP (aun no existe).
 */

describe('bootstrap: primer titular de un dominio', () => {
  let db: PGlite;
  let d1: string, d2: string, t1: string, t2: string, p1: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    d2 = await addUser(db, 'd2@escuela.mx', 'school');
    p1 = await addUser(db, 'p1@escuela.mx', 'school');
    t1 = await addUser(db, 't1@escuela.mx', 'technical');
    t2 = await addUser(db, 't2@escuela.mx', 'technical');
  });
  afterAll(async () => {
    await db.close();
  });

  it('un solicitante anonimo o el rol de la API NO pueden hacer bootstrap aunque el dominio este vacio', async () => {
    for (const [user, role] of [
      [d1, 'direccion'],
      [t1, 'admin_tecnico'],
    ] as const) {
      const f = await failure(asApi(db, () => bootstrap(db, user, role)));
      expect(f.message, role).toMatch(/Solo el propietario del esquema/);
    }
    const r = await db.query<{ n: number }>(`select count(*)::int n from user_roles`);
    expect(r.rows[0]!.n).toBe(0);
  });
  it('exige referencia de acta (3 a 200 caracteres) y concedente nulo', async () => {
    expect(
      (
        await failure(
          db.query(
            `insert into user_roles (user_id, role_id, domain, grant_source) values ($1,$2,'school','bootstrap')`,
            [d1, await roleId(db, 'direccion')],
          ),
        )
      ).code,
    ).toBe('23514');
    expect((await failure(bootstrap(db, d1, 'direccion', 'ab'))).code).toBe('23514');
    expect((await failure(bootstrap(db, d1, 'direccion', 'x'.repeat(201)))).code).toBe('23514');
    expect((await failure(grant(db, d1, 'direccion', d2, 'bootstrap', 'ACTA-1'))).code).toBe(
      '23514',
    );
  });
  it('solo concede un rol con roles:grant_<dominio> (no se inicializa un dominio con un rol operativo)', async () => {
    expect((await failure(bootstrap(db, p1, 'prefectura'))).message).toMatch(
      /solo puede conceder un rol que contenga roles:grant_school/,
    );
  });
  it('no aplica a cuentas deshabilitadas', async () => {
    const dis = await addUser(db, 'dis@escuela.mx', 'school', 'disabled');
    expect((await failure(bootstrap(db, dis, 'direccion'))).message).toMatch(/deshabilitada/);
  });
  it('el propietario con acta inicializa el dominio y queda auditado con su referencia', async () => {
    await bootstrap(db, d1, 'direccion', 'ACTA-2026-001');
    await bootstrap(db, t1, 'admin_tecnico', 'ACTA-2026-002');
    const r = await db.query<{ details: Record<string, string>; actor: string | null }>(
      `select details, actor_user_id actor from audit_events where event_type='role.granted' order by occurred_at`,
    );
    expect(r.rows.map((x) => [x.details.source, x.details.reference, x.actor])).toEqual([
      ['bootstrap', 'ACTA-2026-001', null],
      ['bootstrap', 'ACTA-2026-002', null],
    ]);
  });
  it('se cierra: ni siquiera el propietario puede hacer un segundo bootstrap en el dominio', async () => {
    expect((await failure(bootstrap(db, d2, 'direccion'))).message).toMatch(/Bootstrap cerrado/);
    expect((await failure(bootstrap(db, t2, 'admin_tecnico'))).message).toMatch(
      /Bootstrap cerrado/,
    );
  });
  it('se cierra PARA SIEMPRE: vaciar el dominio revocando al unico titular no lo reabre', async () => {
    await revoke(db, d1, 'direccion', d1); // renuncia del unico titular
    expect((await failure(bootstrap(db, d2, 'direccion'))).message).toMatch(/Bootstrap cerrado/);
  });
  it('el historial no se puede borrar para reabrirlo (DELETE ni TRUNCATE, ni siquiera el propietario)', async () => {
    expect((await failure(db.query(`delete from user_roles`))).message).toMatch(/no se elimina/);
    expect((await failure(db.query(`truncate user_roles`))).message).toMatch(/no se elimina/);
    expect((await failure(asApi(db, () => db.query(`delete from user_roles`)))).message).toMatch(
      /no se elimina/,
    );
  });
});

describe('recovery: rescate presencial cuando se pierden todos los titulares', () => {
  let db: PGlite;
  let d1: string, d2: string, d3: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    d2 = await addUser(db, 'd2@escuela.mx', 'school');
    d3 = await addUser(db, 'd3@escuela.mx', 'school');
  });
  afterAll(async () => {
    await db.close();
  });
  const recover = (user: string, ref: string | null = 'ACTA-RESCATE-01') =>
    db.query(
      `insert into user_roles (user_id, role_id, domain, grant_source, grant_reference)
       values ($1, (select id from roles where key='direccion'), 'school', 'recovery', $2)`,
      [user, ref],
    );

  it('no se puede usar en un dominio nunca inicializado (ahi corresponde bootstrap)', async () => {
    expect((await failure(recover(d1))).message).toMatch(/requiere un dominio ya inicializado/);
  });
  it('no se permite mientras existan titulares activos con autoridad', async () => {
    await bootstrap(db, d1, 'direccion');
    expect((await failure(recover(d2))).message).toMatch(/aun tiene titulares activos/);
  });
  it('tras perder al ultimo titular: la API no puede; el propietario necesita acta', async () => {
    await db.query(`update users set status='disabled' where id=$1`, [d1]); // cuenta del unico titular deshabilitada
    expect((await failure(asApi(db, () => recover(d2)))).message).toMatch(
      /Solo el propietario del esquema/,
    );
    expect((await failure(recover(d2, null))).code).toBe('23514');
    await recover(d2);
    const r = await db.query<{ source: string; ref: string }>(
      `select details->>'source' source, details->>'reference' ref from audit_events where subject_user_id=$1 and event_type='role.granted'`,
      [d2],
    );
    expect(r.rows).toEqual([{ source: 'recovery', ref: 'ACTA-RESCATE-01' }]);
  });
  it('una vez rescatado, el dominio vuelve a tener un titular y el recovery se cierra otra vez', async () => {
    expect((await failure(recover(d3))).message).toMatch(/aun tiene titulares activos/);
  });
});

describe('concesion de roles: escalamiento, dominios y revocacion', () => {
  let db: PGlite;
  let t1: string, t2: string, t3: string, d1: string, d2: string, p1: string, c1: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    t1 = await addUser(db, 't1@escuela.mx', 'technical');
    t2 = await addUser(db, 't2@escuela.mx', 'technical');
    t3 = await addUser(db, 't3@escuela.mx', 'technical');
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    d2 = await addUser(db, 'd2@escuela.mx', 'school');
    p1 = await addUser(db, 'p1@escuela.mx', 'school');
    c1 = await addUser(db, 'c1@escuela.mx', 'school');
    await bootstrap(db, t1, 'admin_tecnico');
    await bootstrap(db, d1, 'direccion');
    await asApi(db, () => grant(db, t2, 'admin_tecnico', t1));
    await asApi(db, () => grant(db, p1, 'prefectura', d1));
  });
  afterAll(async () => {
    await db.close();
  });

  it('autoasignacion: ningun usuario se concede un rol a si mismo (ni tecnico ni escolar)', async () => {
    expect((await failure(asApi(db, () => grant(db, t1, 'admin_tecnico', t1)))).code).toBe('23514');
    expect((await failure(asApi(db, () => grant(db, d1, 'direccion', d1)))).code).toBe('23514');
    // p1 no tiene autoridad: el trigger (BEFORE INSERT) lo rechaza antes que el CHECK; ambos son rechazos.
    expect(['23514', '42501']).toContain(
      (await failure(asApi(db, () => grant(db, p1, 'control_acceso', p1)))).code,
    );
  });
  it('admin_tecnico NO puede conceder acceso escolar a otra cuenta (ningun rol escolar)', async () => {
    for (const role of ['direccion', 'prefectura', 'trabajo_social', 'control_acceso']) {
      const f = await failure(asApi(db, () => grant(db, d2, role, t1)));
      expect(f.message, role).toMatch(/permiso roles:grant_school/);
    }
  });
  it('admin_tecnico tampoco puede crearse un segundo "yo" escolar: la FK de dominio lo impide con cualquier concedente', async () => {
    expect((await failure(asApi(db, () => grant(db, t2, 'direccion', d1)))).code).toBe('23503');
    expect((await failure(asApi(db, () => grant(db, t2, 'direccion', t1)))).message).toMatch(
      /roles:grant_school/,
    );
  });
  it('direccion NO puede obtener ni conceder privilegios tecnicos con sus permisos escolares', async () => {
    expect((await failure(asApi(db, () => grant(db, t3, 'admin_tecnico', d1)))).message).toMatch(
      /roles:grant_technical/,
    );
    expect((await failure(asApi(db, () => grant(db, d2, 'admin_tecnico', d1)))).code).toBe('42501');
    // con autoridad tecnica real, la FK de dominio impide un rol tecnico en una cuenta ESCOLAR
    expect((await failure(asApi(db, () => grant(db, d2, 'admin_tecnico', t1)))).code).toBe('23503');
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from role_permissions rp join roles r on r.id=rp.role_id
        where r.key='direccion' and rp.permission_domain='technical'`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });
  it('cada dominio concede dentro de si mismo', async () => {
    await asApi(db, () => grant(db, t3, 'admin_tecnico', t2));
    await asApi(db, () => grant(db, d2, 'trabajo_social', d1));
  });
  it('un rol operativo (prefectura) no concede nada', async () => {
    expect((await failure(asApi(db, () => grant(db, c1, 'prefectura', p1)))).message).toMatch(
      /permiso roles:grant_school/,
    );
  });
  it('el concedente debe estar activo y la cuenta destino no puede estar deshabilitada', async () => {
    const dis = await addUser(db, 'dis@escuela.mx', 'school', 'disabled');
    expect((await failure(asApi(db, () => grant(db, dis, 'prefectura', d1)))).message).toMatch(
      /deshabilitada/,
    );
    await db.query(`update users set status='disabled' where id=$1`, [t3]);
    const x = await addUser(db, 'x@escuela.mx', 'technical');
    expect((await failure(asApi(db, () => grant(db, x, 'admin_tecnico', t3)))).message).toMatch(
      /cuenta activa/,
    );
    await db.query(`update users set status='active' where id=$1`, [t3]);
  });
  it('revocar: quien no tiene la autoridad no puede, y las asignaciones son inmutables', async () => {
    expect((await failure(asApi(db, () => revoke(db, d1, 'direccion', t1)))).message).toMatch(
      /roles:grant_school/,
    );
    expect((await failure(asApi(db, () => revoke(db, p1, 'prefectura', c1)))).message).toMatch(
      /roles:grant_school/,
    );
    expect(
      (
        await failure(
          asApi(db, () =>
            db.query(`update user_roles set granted_by=$1 where user_id=$2`, [d2, p1]),
          ),
        )
      ).message,
    ).toMatch(/inmutables/);
  });
  it('la revocacion revoca las sesiones, queda auditada y quita las autorizaciones posteriores', async () => {
    await addSession(db, p1, 1);
    await addSession(db, d2, 2);
    await asApi(db, () => revoke(db, d2, 'trabajo_social', d1));
    expect(await sessionReasons(db, d2)).toEqual(['roles_changed']);
    const a = await db.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type='role.revoked' and subject_user_id=$1 and actor_user_id=$2`,
      [d2, d1],
    );
    expect(a.rows[0]!.n).toBe(1);
    // dir pierde la autoridad -> ya no puede conceder
    await grant(db, c1, 'prefectura', d1);
    await asApi(db, () => revoke(db, d1, 'direccion', d1)); // renuncia
    expect((await failure(asApi(db, () => grant(db, d2, 'control_acceso', d1)))).message).toMatch(
      /roles:grant_school/,
    );
  });
  it('una cuenta deshabilitada pierde su autoridad de inmediato', async () => {
    await db.query(`update users set status='disabled' where id=$1`, [t2]);
    const u = await addUser(db, 'nuevo-tec@escuela.mx', 'technical');
    expect((await failure(asApi(db, () => grant(db, u, 'admin_tecnico', t2)))).message).toMatch(
      /cuenta activa/,
    );
  });
  it('la concesion de un rol revoca las sesiones abiertas del destinatario (roles_changed)', async () => {
    const holder = await addUser(db, 'holder@escuela.mx', 'technical');
    await addSession(db, holder, 3);
    expect(await sessionReasons(db, holder)).toEqual([null]);
    // t1 (admin_tecnico activo y vigente) concede otro rol tecnico al destinatario con sesion abierta
    await asApi(db, () => grant(db, holder, 'admin_tecnico', t1));
    expect(await sessionReasons(db, holder)).toEqual(['roles_changed']);
  });
});

describe('permisos de autoridad y edicion de roles', () => {
  let db: PGlite;
  let d1: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    await bootstrap(db, d1, 'direccion');
  });
  afterAll(async () => {
    await db.close();
  });
  const addPerm = (role: string, perm: string, scope = 'all') =>
    db.query(
      `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
       select r.id, r.domain, p.id, p.domain, $3 from roles r, permissions p where r.key=$1 and p.key=$2`,
      [role, perm, scope],
    );
  const delPerm = (role: string, perm: string) =>
    db.query(
      `delete from role_permissions where role_id=(select id from roles where key=$1) and permission_id=(select id from permissions where key=$2)`,
      [role, perm],
    );

  it('la API NO puede delegar autoridad: agregar roles:grant_school a prefectura se rechaza', async () => {
    for (const perm of ['roles:grant_school', 'roles:manage_school', 'users:manage_school']) {
      expect((await failure(asApi(db, () => addPerm('prefectura', perm)))).message, perm).toMatch(
        /permisos de autoridad solo los cambia el propietario/,
      );
    }
  });
  it('la API NO puede quitar autoridad a un rol (denegacion de servicio contra Direccion)', async () => {
    expect(
      (await failure(asApi(db, () => delPerm('direccion', 'roles:grant_school')))).message,
    ).toMatch(/propietario del esquema/);
  });
  it('ampliar indirectamente a un tecnico con permisos escolares es imposible (dominio)', async () => {
    expect((await failure(asApi(db, () => addPerm('admin_tecnico', 'students:read')))).code).toBe(
      '23514',
    );
    expect((await failure(asApi(db, () => addPerm('direccion', 'audit:read')))).code).toBe('23514');
  });
  it('un permiso NO autoridad lo edita quien llame (la autorizacion es de la aplicacion: grant-policy) y queda auditado con atribucion', async () => {
    await db.exec(`select set_config('eta15.actor_id', '${d1}', false)`);
    await asApi(db, () => addPerm('control_acceso', 'students:read', 'assigned_groups'));
    await asApi(db, () => delPerm('control_acceso', 'students:read'));
    await db.exec(`select set_config('eta15.actor_id', '', false)`);
    const r = await db.query<{ change: string; actor: string }>(
      `select details->>'change' change, actor_user_id actor from audit_events
        where event_type='role.permissions_changed' and details->>'role'='control_acceso' order by occurred_at, id`,
    );
    expect(r.rows).toEqual([
      { change: 'add', actor: d1 },
      { change: 'remove', actor: d1 },
    ]);
  });
  it('la atribucion invalida (basura o usuario inexistente) se registra sin actor, nunca falla ni se acepta', async () => {
    for (const bad of ['no-es-uuid', '00000000-0000-7000-8000-000000000000']) {
      await db.exec(`select set_config('eta15.actor_id', '${bad}', false)`);
      await asApi(db, () => addPerm('control_acceso', 'reports:read'));
      await asApi(db, () => delPerm('control_acceso', 'reports:read'));
    }
    await db.exec(`select set_config('eta15.actor_id', '', false)`);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type='role.permissions_changed' and details->>'permission'='reports:read' and actor_user_id is null`,
    );
    expect(r.rows[0]!.n).toBe(4);
  });
  it('role_permissions no admite UPDATE (ensanchar un scope debe ser baja + alta auditadas), ni para el propietario', async () => {
    expect(
      (
        await failure(
          db.query(`update role_permissions set scope='all' where scope='assigned_groups'`),
        )
      ).message,
    ).toMatch(/no se actualiza/);
    expect(
      (await failure(asApi(db, () => db.query(`update role_permissions set scope='all'`)))).message,
    ).toMatch(/no se actualiza/);
  });
  it('el propietario (migracion) SI puede cambiar permisos de autoridad y queda auditado', async () => {
    await addPerm('trabajo_social', 'users:manage_school'); // solo ilustra la via de migracion
    await delPerm('trabajo_social', 'users:manage_school');
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from audit_events where event_type='role.permissions_changed' and details->>'permission'='users:manage_school'`,
    );
    expect(r.rows[0]!.n).toBe(2);
  });
});

describe('altas de cuentas: quien puede crearlas', () => {
  let db: PGlite;
  let t1: string, d1: string, p1: string;
  beforeAll(async () => {
    db = await freshDb();
    await createApiRole(db);
    t1 = await addUser(db, 't1@escuela.mx', 'technical');
    d1 = await addUser(db, 'd1@escuela.mx', 'school');
    p1 = await addUser(db, 'p1@escuela.mx', 'school');
    await bootstrap(db, t1, 'admin_tecnico');
    await bootstrap(db, d1, 'direccion');
    await grant(db, p1, 'prefectura', d1);
  });
  afterAll(async () => {
    await db.close();
  });
  const create = (email: string, domain: string, createdBy: string | null, extra = '') =>
    asApi(db, () =>
      db.query(
        `insert into users (email, display_name, account_domain, created_by${extra ? ', ' + extra.split('=')[0] : ''})
         values ($1, 'X', $2, $3${extra ? ', ' + extra.split('=')[1] : ''})`,
        [email, domain, createdBy],
      ),
    );

  it('sin creador => rechazado', async () => {
    expect((await failure(create('anon@escuela.mx', 'school', null))).message).toMatch(
      /permiso users:manage_school/,
    );
  });
  it('admin_tecnico no crea cuentas escolares; direccion no crea cuentas tecnicas', async () => {
    expect((await failure(create('a@escuela.mx', 'school', t1))).message).toMatch(
      /users:manage_school/,
    );
    expect((await failure(create('b@escuela.mx', 'technical', d1))).message).toMatch(
      /users:manage_technical/,
    );
  });
  it('un rol operativo no crea cuentas', async () => {
    expect((await failure(create('c@escuela.mx', 'school', p1))).message).toMatch(
      /users:manage_school/,
    );
  });
  it('cada dominio crea las suyas, pendientes y sin contrasena', async () => {
    await create('nueva-escolar@escuela.mx', 'school', d1);
    await create('nueva-tecnica@escuela.mx', 'technical', t1);
  });
  it('la API no puede crear cuentas ya activas ni con contrasena', async () => {
    expect(
      (await failure(create('d@escuela.mx', 'school', d1, "status='active'"))).message,
    ).toMatch(/pendientes y sin contrasena/);
    expect(
      (await failure(create('e@escuela.mx', 'school', d1, "password_hash='hash-ficticio'")))
        .message,
    ).toMatch(/pendientes y sin contrasena/);
  });
  it('la API no puede activar una cuenta pendiente a mano', async () => {
    const f = await failure(
      asApi(db, () =>
        db.query(
          `update users set status='active', password_hash='hash-ficticio' where email='nueva-escolar@escuela.mx'`,
        ),
      ),
    );
    expect(f.message).toMatch(/solo se activa al consumir su invitacion autorizada/);
  });
  it('no se asigna un rol a una cuenta pendiente creada por otro dominio (FK de dominio) ni se invierte el dominio', async () => {
    expect(
      (
        await failure(
          db.query(
            `update users set account_domain='technical' where email='nueva-escolar@escuela.mx'`,
          ),
        )
      ).message,
    ).toMatch(/inmutable/);
  });
});
