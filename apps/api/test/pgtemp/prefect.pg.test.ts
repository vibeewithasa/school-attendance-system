import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { definePrefectTests } from '../helpers/prefect-suite.js';
import { addDays, todayIso } from '../helpers/students-suite.js';

/**
 * Asignaciones de prefectura contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria):
 *  - CON la propuesta 0004 (acceso por columna): suite HTTP completa, matriz de privilegios y concurrencia REAL.
 *  - SIN ella (estado de eta15_dev tras 0009 y antes de 0004): administracion 503 y la prefectura ve cero filas.
 * Siempre con 0002 y 0003 aplicadas (como eta15_dev). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

function suite(label: string, mode: 'full' | 'unavailable') {
  let cluster: ApiCluster;
  beforeAll(async () => {
    cluster = await startApiCluster(20, {
      catalogWrite: true,
      studentsWrite: true,
      prefectWrite: mode === 'full',
      attendanceWrite: true, // los triggers de fechas del ciclo (0010) leen la asistencia
    });
    clusters.push(cluster);
  }, 240_000);

  defineAdminHttpSuite(
    label,
    async () => ({
      harness: {
        store: createPgSessionStore(cluster.pool),
        owner: async (sql, params) =>
          (await cluster.owner.query(sql, params)) as { rows: Array<Record<string, unknown>> },
      },
      teardown: async () => undefined,
    }),
    { onlyExtra: true, extra: (kit) => definePrefectTests(kit, { mode }) },
  );

  describe(`${label}: privilegios y concurrencia reales de eta15_api`, () => {
    const api = (sql: string, params: unknown[] = []) => cluster.pool.query(sql, params);
    const denied = (sql: string) => expect(api(sql)).rejects.toMatchObject({ code: '42501' });
    const verify = () =>
      cluster.owner.query(privilegeFile('0004-prefect-assignments-write.verify.sql'));

    if (mode === 'unavailable') {
      it('estado de eta15_dev antes de 0004: sin acceso a la tabla y el verificador lo senala', async () => {
        for (const sql of [
          'select count(*) from prefect_group_assignments',
          'select id from prefect_group_assignments',
          'update prefect_group_assignments set ends_on = ends_on where false',
        ])
          await denied(sql);
        await expect(verify()).rejects.toThrow(/Privilegios efectivos de eta15_api inesperados/);
      });
      return;
    }

    const today = todayIso();
    const ids: Record<string, string> = {};
    const owner = async (sql: string, params: unknown[] = []) =>
      (await cluster.owner.query(sql, params)).rows;

    beforeAll(async () => {
      // Cuentas y roles ficticios sembrados como propietario (equivale a consola/semilla de pruebas).
      const user = async (key: string, email: string, domain = 'school') => {
        ids[key] = (
          await owner(
            `insert into users (email, display_name, account_domain, status, password_hash)
             values ($1, 'Persona ficticia', $2, 'active', 'hash-ficticio-de-prueba') returning id`,
            [email, domain],
          )
        )[0]!.id as string;
      };
      // La suite HTTP ya hizo el bootstrap escolar de este clúster: se reutiliza la primera autoridad (Direccion).
      ids.boss = (
        await owner(
          `select ur.user_id as id from user_roles ur join roles r on r.id = ur.role_id
            where r.key = 'direccion' and ur.revoked_at is null order by ur.granted_at limit 1`,
        )
      )[0]!.id as string;
      const prefect = async (key: string) => {
        await user(key, `${key}.pg@escuela.test`);
        await owner(
          `insert into user_roles (user_id, role_id, domain, granted_by, grant_source)
           select $1, id, 'school', $2, 'grant' from roles where key = 'prefectura'`,
          [ids[key], ids.boss],
        );
      };
      for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await prefect(k);
      // Ciclo futuro (no se traslapa con los de la suite HTTP): las asignaciones pueden empezar en su primer dia.
      ids.start = addDays(today, 2000);
      ids.year = (
        await owner(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo PG prefectura', $1, $2) returning id`,
          [ids.start, addDays(today, 2300)],
        )
      )[0]!.id as string;
      for (const c of ['A', 'B', 'C', 'D', 'E', 'F'])
        ids[`g${c}`] = (
          await owner(
            `insert into groups (school_year_id, grade, code) values ($1, 1, $2) returning id`,
            [ids.year, c],
          )
        )[0]!.id as string;
    }, 60_000);

    const insertSql = `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by)
                       values ($1, $2, $3, $4::date, $5) returning id`;
    const insertAs = (
      c: { query: pg.Pool['query'] },
      user: string,
      group: string,
      startsOn = ids.start,
    ) =>
      (c.query as (s: string, p: unknown[]) => Promise<{ rows: Array<{ id: string }> }>)(
        insertSql,
        [ids[user], ids.year, ids[group], startsOn, ids.boss],
      );
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (x: { code: string; constraint: string }) => `${x.code}:${x.constraint}`,
      );
    async function twoConnections(run: (c1: pg.PoolClient, c2: pg.PoolClient) => Promise<void>) {
      const c1 = await cluster.pool.connect();
      const c2 = await cluster.pool.connect();
      try {
        await run(c1, c2);
      } finally {
        for (const c of [c1, c2]) {
          await c.query('rollback').catch(() => undefined);
          c.release();
        }
      }
    }
    const wait = () => new Promise((r) => setTimeout(r, 300));

    it('matriz exacta por columna: el verificador oficial aprueba y las operaciones aprobadas funcionan', async () => {
      await verify();
      const { rows } = await insertAs(cluster.pool, 'p1', 'gA');
      await api(`update prefect_group_assignments set ends_on = $2 where id = $1`, [
        rows[0]!.id,
        addDays(ids.start!, 30),
      ]);
      await api(
        `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Prueba de privilegios' where id = $1`,
        [rows[0]!.id, ids.boss],
      );
      const r = await api(
        `select id, user_id, school_year_id, group_id, starts_on, ends_on, created_by, revoked_at, revoked_by, revocation_reason, created_at
           from prefect_group_assignments where id = $1`,
        [rows[0]!.id],
      );
      expect(r.rows[0].revoked_at).toBeTruthy(); // lo fijo el trigger, no el cliente
    });

    it('columnas NO aprobadas: ni se escriben (alta y cambio) ni, en updated_at, se leen (42501)', async () => {
      await denied('select updated_at from prefect_group_assignments');
      await denied('select * from prefect_group_assignments');
      await expect(
        api(
          `insert into prefect_group_assignments (id, user_id, school_year_id, group_id, starts_on, created_by)
           values (gen_random_uuid(), '${ids.p2}', '${ids.year}', '${ids.gB}', '${ids.start}', '${ids.boss}')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api(
          `insert into prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by, revoked_at)
           values ('${ids.p2}', '${ids.year}', '${ids.gB}', '${ids.start}', '${ids.boss}', now())`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      for (const col of [
        'user_id',
        'group_id',
        'starts_on',
        'created_by',
        'revoked_at',
        'created_at',
        'updated_at',
        'school_year_id',
        'id',
      ])
        await denied(`update prefect_group_assignments set ${col} = ${col} where false`);
    });

    it('DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE, SET ROLE y autorizacion: denegados (42501)', async () => {
      await denied('delete from prefect_group_assignments');
      await denied('truncate prefect_group_assignments');
      await denied(
        'create trigger t_x before insert on prefect_group_assignments for each row execute function set_updated_at()',
      );
      await denied('create table public.tmp_fk (a uuid references prefect_group_assignments(id))');
      await denied('create table tmp_x (id int)');
      await denied('set role eta15_app');
      await denied(
        `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
         select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p
          where r.key = 'prefectura' and p.key = 'prefect_assignments:manage'`,
      );
      await denied('update role_permissions set scope = scope where false');
      await denied('delete from permissions');
      await denied('select * from extensions.gist_uuid_ops limit 1');
    });

    it('el verificador detecta un privilegio de mas (DELETE y columna) y de menos', async () => {
      await owner('grant delete on prefect_group_assignments to eta15_api');
      await expect(verify()).rejects.toThrow(/DELETE sobre prefect_group_assignments/);
      await owner('revoke delete on prefect_group_assignments from eta15_api');
      await owner('grant update (starts_on) on prefect_group_assignments to eta15_api');
      await expect(verify()).rejects.toThrow(/UPDATE starts_on efectivo=t/);
      await owner('revoke update (starts_on) on prefect_group_assignments from eta15_api');
      await owner('revoke select (created_at) on prefect_group_assignments from eta15_api');
      await expect(verify()).rejects.toThrow(/SELECT created_at efectivo=f/);
      await owner('grant select (created_at) on prefect_group_assignments to eta15_api');
      await verify();
    });

    it('carrera real: dos altas simultaneas del mismo par -> exactamente una; la otra espera y recibe 23P01', async () => {
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await insertAs(c1, 'p2', 'gB');
        await c2.query('begin');
        const second = settle(insertAs(c2, 'p2', 'gB'));
        await wait();
        await c1.query('commit');
        expect(await second).toMatch(/^23P01:pga_no_overlap$/);
      });
      const n = await owner(
        `select count(*)::int n from prefect_group_assignments where user_id = $1 and group_id = $2`,
        [ids.p2, ids.gB],
      );
      expect(n[0]!.n).toBe(1);
    });

    it('carrera real: varias prefectas en el mismo grupo no se bloquean (cobertura)', async () => {
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await c2.query('begin');
        await insertAs(c1, 'p3', 'gC');
        await insertAs(c2, 'p4', 'gC'); // no espera: pares distintos
        await c1.query('commit');
        await c2.query('commit');
      });
      const n = await owner(
        `select count(*)::int n from prefect_group_assignments where group_id = $1`,
        [ids.gC],
      );
      expect(n[0]!.n).toBe(2);
    });

    it('carrera real: revocar el rol de prefectura vs asignar -> la asignacion nunca queda sobre una cuenta sin rol', async () => {
      const owner2 = cluster.owner;
      await owner2.query('begin');
      await owner2.query(
        `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
        [ids.p5, ids.boss],
      );
      const pending = settle(insertAs(cluster.pool, 'p5', 'gD'));
      await wait();
      await owner2.query('commit');
      expect(await pending).toBe('23514:pga_user_role');
      expect(
        (
          await owner(`select count(*)::int n from prefect_group_assignments where user_id = $1`, [
            ids.p5,
          ])
        )[0]!.n,
      ).toBe(0);
    });

    it('carrera real: asignar vs revocar el rol (orden inverso) -> la asignacion queda, pero deja de dar acceso', async () => {
      await twoConnections(async (c1) => {
        await c1.query('begin');
        await insertAs(c1, 'p6', 'gD');
        const revoking = settle(
          cluster.owner.query(
            `update user_roles set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null`,
            [ids.p6, ids.boss],
          ),
        );
        await wait();
        await c1.query('commit');
        expect(await revoking).toBe('ok');
      });
      const eff = await owner(
        `select count(*)::int n from prefect_group_assignments a
           where a.user_id = $1 and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                             where ur.user_id = a.user_id and ur.revoked_at is null and r.key = 'prefectura')`,
        [ids.p6],
      );
      expect(eff[0]!.n).toBe(0);
    });

    it('carrera real: cerrar vs revocar la misma asignacion -> la fila revocada es inmutable, el cierre pierde', async () => {
      const id = (await insertAs(cluster.pool, 'p1', 'gE')).rows[0]!.id;
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await c1.query(
          `update prefect_group_assignments set revoked_by = $2, revocation_reason = 'Revocacion simultanea' where id = $1`,
          [id, ids.boss],
        );
        await c2.query('begin');
        const closing = settle(
          c2.query('update prefect_group_assignments set ends_on = $2 where id = $1', [
            id,
            addDays(ids.start!, 10),
          ]),
        );
        await wait();
        await c1.query('commit');
        expect(await closing).toMatch(/^42501:/);
      });
      const row = await owner(
        `select ends_on, revoked_at from prefect_group_assignments where id = $1`,
        [id],
      );
      expect(row[0]!.ends_on).toBeNull();
      expect(row[0]!.revoked_at).toBeTruthy();
    });

    it('carrera real: desactivar el grupo vs asignar -> no se asigna a un grupo inactivo', async () => {
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await c1.query('update groups set is_active = false where id = $1', [ids.gF]);
        await c2.query('begin');
        const pending = settle(insertAs(c2, 'p1', 'gF'));
        await wait();
        await c1.query('commit');
        expect(await pending).toBe('23514:pga_group_active');
      });
    });

    it('carrera real: acortar el ciclo vs asignar, y asignar vs acortar -> nunca queda una asignacion fuera de las fechas', async () => {
      const y2 = (
        await owner(
          `insert into school_years (name, starts_on, ends_on) values ('Ciclo PG carreras', $1, $2) returning id`,
          [addDays(today, 3000), addDays(today, 3300)],
        )
      )[0]!.id as string;
      const g2 = (
        await owner(
          `insert into groups (school_year_id, grade, code) values ($1, 2, 'Z') returning id`,
          [y2],
        )
      )[0]!.id as string;
      const ins = (c: pg.PoolClient, user: string, startsOn: string) =>
        c.query(insertSql, [ids[user], y2, g2, startsOn, ids.boss]);
      // a) acortar primero (sin asignaciones todavia), asignar despues -> la asignacion fuera del nuevo fin falla
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await c1.query(`update school_years set ends_on = $2 where id = $1`, [
          y2,
          addDays(today, 3100),
        ]);
        await c2.query('begin');
        const pending = settle(ins(c2, 'p1', addDays(today, 3200)));
        await wait();
        await c1.query('commit');
        expect(await pending).toBe('23514:pga_within_year');
      });
      // b) asignar primero, acortar despues -> el cambio de fechas falla
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await ins(c1, 'p1', addDays(today, 3090));
        await c2.query('begin');
        const pending = settle(
          c2.query(`update school_years set ends_on = $2 where id = $1`, [
            y2,
            addDays(today, 3050),
          ]),
        );
        await wait();
        await c1.query('commit');
        expect(await pending).toBe('23514:school_years_prefect_within');
      });
    });
  });
}

suite('PostgreSQL desechable + privilegios 0004 (prefectura)', 'full');
suite('PostgreSQL desechable sin privilegios 0004 (prefectura)', 'unavailable');
