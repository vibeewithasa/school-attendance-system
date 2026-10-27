import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineStudentsTests } from '../helpers/students-suite.js';

/**
 * Alumnos, matriculas e historial de grupo contra PostgreSQL 18 DESECHABLE con la API como `eta15_api` (no propietaria):
 *  - CON la propuesta de privilegios 0003 (acceso por columna): suite HTTP completa con concurrencia REAL, y matriz de privilegios.
 *  - SIN ella (estado real de eta15_dev tras 0007-0008): el modulo responde 503 sin cambiar nada.
 * Siempre con la migracion RBAC 0008 aplicada (politica cerrada por defecto). No toca eta15_dev.  Ejecutar con: pnpm test:pg-temp
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
      studentsWrite: mode === 'full',
      prefectWrite: true, // los triggers de fechas del ciclo (0009) leen las asignaciones de prefectura
      attendanceWrite: true, // y los de la 0010 leen la asistencia
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
    { onlyExtra: true, extra: (kit) => defineStudentsTests(kit, { mode }) },
  );

  describe(`${label}: privilegios y concurrencia reales de eta15_api`, () => {
    const api = (sql: string) => cluster.pool.query(sql);
    const denied = (sql: string) => expect(api(sql)).rejects.toMatchObject({ code: '42501' });
    const verify = () => cluster.owner.query(privilegeFile('0003-students-write.verify.sql'));

    if (mode === 'unavailable') {
      it('estado real: sin acceso a las tablas nuevas y el verificador lo senala', async () => {
        for (const sql of [
          'select count(*) from students',
          "insert into students (given_names, family_name) values ('Ana', 'Ficticia')",
          'select count(*) from enrollments',
          'select count(*) from student_group_assignments',
        ])
          await denied(sql);
        await expect(verify()).rejects.toThrow(/Privilegios efectivos de eta15_api inesperados/);
      });
      return;
    }

    it('matriz exacta por columna: el verificador oficial aprueba y las operaciones aprobadas funcionan', async () => {
      await verify();
      const year = (
        await cluster.owner.query<{ id: string }>(
          `insert into school_years (name, starts_on, ends_on) values ('Priv', '2200-01-01', '2200-12-31') returning id`,
        )
      ).rows[0]!.id;
      const grp = (
        await cluster.owner.query<{ id: string }>(
          `insert into groups (school_year_id, grade, code) values ('${year}', 1, 'PV') returning id`,
        )
      ).rows[0]!.id;
      const s = (
        await api(
          "insert into students (given_names, family_name, school_code) values ('Priv', 'Ficticia', 'PRIV-1') returning id",
        )
      ).rows[0].id;
      await api(`update students set given_names = 'Priva', is_active = true where id = '${s}'`);
      const e = (
        await api(
          `insert into enrollments (student_id, school_year_id, starts_on) values ('${s}', '${year}', '2200-01-02') returning id`,
        )
      ).rows[0].id;
      const a = (
        await api(
          `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) values ('${e}', '${year}', '${grp}', '2200-01-02') returning id`,
        )
      ).rows[0].id;
      await api(`update student_group_assignments set ends_on = '2200-02-01' where id = '${a}'`);
      await api(`update enrollments set ends_on = '2200-02-01' where id = '${e}'`);
      await api(
        `select id, enrollment_id, school_year_id, group_id, starts_on, ends_on, created_at from student_group_assignments`,
      );
    });

    it('columnas NO aprobadas: ni se escriben (alta y cambio) ni, en el historial de grupo, se leen (42501)', async () => {
      for (const sql of [
        "insert into students (id, given_names, family_name) values (gen_random_uuid(), 'X', 'Y')",
        "insert into students (given_names, family_name, is_active) values ('X', 'Y', false)",
        "insert into students (given_names, family_name, created_at) values ('X', 'Y', now())",
        'update students set id = id',
        'update students set created_at = now()',
        'update students set updated_at = now()',
        'update enrollments set student_id = student_id',
        'update enrollments set school_year_id = school_year_id',
        'update enrollments set starts_on = starts_on',
        'update student_group_assignments set group_id = group_id',
        'update student_group_assignments set starts_on = starts_on',
        'update student_group_assignments set enrollment_id = enrollment_id',
        'insert into enrollments (student_id, school_year_id, starts_on, ends_on) values (gen_random_uuid(), gen_random_uuid(), now(), now())',
        'select updated_at from student_group_assignments',
        'select * from student_group_assignments',
      ])
        await denied(sql);
    });

    it('DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE, SET ROLE, esquema extensions y autorizacion: denegados (42501)', async () => {
      for (const t of ['students', 'enrollments', 'student_group_assignments']) {
        await denied(`delete from ${t}`);
        await denied(`truncate ${t}`);
        await denied(`alter table ${t} disable trigger all`);
      }
      await denied(
        'create trigger t_x before insert on students for each row execute function pg_catalog.suppress_redundant_updates_trigger()',
      );
      await denied(
        'alter table enrollments add constraint x foreign key (student_id) references students(id)',
      );
      await denied('create table pwn (id int)');
      await denied('set role eta15_app');
      await denied('select * from extensions.gist_uuid_ops');
      await denied(
        "insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope) select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = 'trabajo_social' and p.key = 'students:read'",
      );
      await denied('delete from role_permissions');
      await denied("update permissions set description = 'x'");
    });

    it('el verificador detecta un privilegio de mas (DELETE y columna) y de menos', async () => {
      await cluster.owner.query('grant delete on students to eta15_api');
      await expect(verify()).rejects.toThrow(/DELETE sobre students/);
      await cluster.owner.query('revoke delete on students from eta15_api');
      await cluster.owner.query('grant update (student_id) on enrollments to eta15_api');
      await expect(verify()).rejects.toThrow(/UPDATE enrollments.student_id/);
      await cluster.owner.query('revoke update (student_id) on enrollments from eta15_api');
      await cluster.owner.query('revoke select (school_code) on students from eta15_api');
      await expect(verify()).rejects.toThrow(/SELECT students.school_code/);
      await cluster.owner.query('grant select (school_code) on students to eta15_api');
      await cluster.owner.query('grant usage on schema extensions to eta15_api');
      await expect(verify()).rejects.toThrow(/extensions/);
      await cluster.owner.query('revoke usage on schema extensions from eta15_api');
      await verify();
    });

    it('carrera real: dos transacciones que insertan periodos traslapados -> la segunda espera y recibe 23P01', async () => {
      const year = (
        await cluster.owner.query<{ id: string }>(
          `insert into school_years (name, starts_on, ends_on) values ('Carrera', '2210-01-01', '2210-12-31') returning id`,
        )
      ).rows[0]!.id;
      const g1 = (
        await cluster.owner.query<{ id: string }>(
          `insert into groups (school_year_id, grade, code) values ('${year}', 1, 'R1') returning id`,
        )
      ).rows[0]!.id;
      const g2 = (
        await cluster.owner.query<{ id: string }>(
          `insert into groups (school_year_id, grade, code) values ('${year}', 1, 'R2') returning id`,
        )
      ).rows[0]!.id;
      const s = (
        await api(
          "insert into students (given_names, family_name) values ('Carrera', 'Ficticia') returning id",
        )
      ).rows[0].id;
      const e = (
        await api(
          `insert into enrollments (student_id, school_year_id, starts_on) values ('${s}', '${year}', '2210-01-01') returning id`,
        )
      ).rows[0].id;
      const ins = (group: string) =>
        `insert into student_group_assignments (enrollment_id, school_year_id, group_id, starts_on, ends_on) values ('${e}', '${year}', '${group}', '2210-02-01', '2210-02-10')`;
      // dos conexiones del PROPIETARIO: la API nunca inserta periodos cerrados (no tiene INSERT de ends_on)
      const c1 = await cluster.pgt.connect('eta15_app', 'eta15_dev');
      const c2 = await cluster.pgt.connect('eta15_app', 'eta15_dev');
      try {
        await c1.query('begin');
        await c1.query(ins(g1));
        await c2.query('begin');
        const second = c2.query(ins(g2)).then(
          () => 'ok',
          (x: { code: string }) => x.code,
        ); // espera al commit de c1
        await new Promise((r) => setTimeout(r, 300));
        await c1.query('commit');
        expect(await second).toBe('23P01');
        await c2.query('rollback');
      } finally {
        await c1.end();
        await c2.end();
      }
      const n = await cluster.owner.query<{ n: number }>(
        `select count(*)::int n from student_group_assignments where enrollment_id = '${e}'`,
      );
      expect(n.rows[0]!.n).toBe(1);
    });

    it('carrera real: desactivar al alumno vs inscribirlo -> no queda un alumno inactivo con matricula nueva', async () => {
      const year = (
        await cluster.owner.query<{ id: string }>(
          `insert into school_years (name, starts_on, ends_on) values ('Carrera2', '2220-01-01', '2220-12-31') returning id`,
        )
      ).rows[0]!.id;
      const s = (
        await api(
          "insert into students (given_names, family_name) values ('Carrera', 'Dos') returning id",
        )
      ).rows[0].id;
      const c1 = await cluster.pool.connect();
      const c2 = await cluster.pool.connect();
      try {
        await c1.query('begin');
        await c1.query(`update students set is_active = false where id = '${s}'`);
        await c2.query('begin');
        const enr = c2
          .query(
            `insert into enrollments (student_id, school_year_id, starts_on) values ('${s}', '${year}', '2220-01-02')`,
          )
          .then(
            () => 'ok',
            (x: { code: string; constraint: string }) => `${x.code}:${x.constraint}`,
          );
        await new Promise((r) => setTimeout(r, 300));
        await c1.query('commit');
        expect(await enr).toBe('23514:enrollments_student_active');
        await c2.query('rollback');
      } finally {
        for (const c of [c1, c2]) {
          await c.query('rollback').catch(() => undefined);
          c.release();
        }
      }
    });

    // Fechas del ciclo vs matriculas simultaneas: ambas ordenes se serializan por el bloqueo FOR SHARE del ciclo / de sus matriculas.
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
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (x: { code: string; constraint: string }) => `${x.code}:${x.constraint}`,
      );
    const newYear = async (name: string, startsOn: string, endsOn: string) =>
      (
        await cluster.owner.query<{ id: string }>(
          `insert into school_years (name, starts_on, ends_on) values ('${name}', '${startsOn}', '${endsOn}') returning id`,
        )
      ).rows[0]!.id;
    const newStudent = async (family: string) =>
      (
        await api(
          `insert into students (given_names, family_name) values ('Anio', '${family}') returning id`,
        )
      ).rows[0].id as string;

    it('carrera real: acortar el ciclo vs inscribir -> la matricula nunca queda fuera de las fechas finales', async () => {
      const year = await newYear('Carrera3', '2230-01-01', '2230-12-31');
      const s = await newStudent('Tres');
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await c1.query(`update school_years set ends_on = '2230-06-30' where id = '${year}'`);
        await c2.query('begin');
        const enr = settle(
          c2.query(
            `insert into enrollments (student_id, school_year_id, starts_on) values ('${s}', '${year}', '2230-09-01')`,
          ),
        );
        await new Promise((r) => setTimeout(r, 300));
        await c1.query('commit');
        expect(await enr).toBe('23514:enrollments_within_year');
      });
    });

    it('carrera real: inscribir vs acortar el ciclo -> el cambio de fechas falla si la matricula ya existe', async () => {
      const year = await newYear('Carrera4', '2240-01-01', '2240-12-31');
      const s = await newStudent('Cuatro');
      await twoConnections(async (c1, c2) => {
        await c1.query('begin');
        await c1.query(
          `insert into enrollments (student_id, school_year_id, starts_on) values ('${s}', '${year}', '2240-09-01')`,
        );
        await c2.query('begin');
        const upd = settle(
          c2.query(`update school_years set ends_on = '2240-06-30' where id = '${year}'`),
        );
        await new Promise((r) => setTimeout(r, 300));
        await c1.query('commit');
        expect(await upd).toBe('23514:school_years_enrollments_within');
      });
    });

    it('la API no puede desactivar a un alumno con matricula sin baja aunque salte el servicio (23514)', async () => {
      const year = await newYear('Carrera5', '2250-01-01', '2250-12-31');
      const s = await newStudent('Cinco');
      await api(
        `insert into enrollments (student_id, school_year_id, starts_on) values ('${s}', '${year}', '2250-02-01')`,
      );
      await expect(
        api(`update students set is_active = false where id = '${s}'`),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'students_deactivate_open_enrollment',
      });
    });
  });
}

suite('PostgreSQL desechable + privilegios 0003 (alumnos)', 'full');
suite('PostgreSQL desechable sin privilegios 0003 (alumnos)', 'unavailable');
