import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privilegeFile, startApiCluster, type ApiCluster } from '../helpers/api-cluster.js';
import { defineAdminHttpSuite } from '../helpers/admin-http-suite.js';
import { defineCatalogTests } from '../helpers/catalog-suite.js';
import { createPgSessionStore } from '../../src/modules/auth/session-store-pg.js';

/**
 * Catalogo escolar contra PostgreSQL 18 DESECHABLE con la API como `eta15_api`:
 *  - con la propuesta de privilegios 0002 aplicada (escritura por columna, sin DELETE), y
 *  - SIN ella (estado REAL actual de eta15_dev): las lecturas funcionan y las escrituras responden 503.
 * No toca eta15_dev. Ejecutar con:  pnpm test:pg-temp
 */
const clusters: ApiCluster[] = [];
afterAll(async () => {
  await Promise.all(clusters.map((c) => c.stop()));
}, 60_000);

function suite(label: string, privileges: 'full' | 'none') {
  let cluster: ApiCluster;
  beforeAll(async () => {
    // Estado objetivo: 0002 (catalogo), 0003 (alumnos) y 0004 (prefectura); cambiar fechas de un ciclo lee matriculas y asignaciones
    // de prefectura con los privilegios de la API (triggers de 0007 y 0009).
    cluster = await startApiCluster(20, {
      catalogWrite: privileges === 'full',
      studentsWrite: privileges === 'full',
      prefectWrite: privileges === 'full',
      attendanceWrite: privileges === 'full',
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
    { onlyExtra: true, extra: (kit) => defineCatalogTests(kit, { privileges }) },
  );
  describe(`${label}: privilegios reales del rol de la API`, () => {
    const api = (sql: string) => cluster.pool.query(sql);
    const denied = (sql: string) => expect(api(sql)).rejects.toMatchObject({ code: '42501' });
    const verify = () => cluster.owner.query(privilegeFile('0002-school-catalog-write.verify.sql'));
    if (privileges === 'full') {
      it('INSERT y UPDATE solo en las columnas concedidas (tabla y columna evaluadas juntas)', async () => {
        await verify();
        await api(
          "insert into school_years (name, starts_on, ends_on) values ('P', '2200-01-01', '2200-12-31')",
        );
        await api(
          "insert into groups (school_year_id, grade, code, shift, expected_entry_time) select id, 1, 'P', 'matutino', '07:50' from school_years where name = 'P'",
        );
        await api(
          "update groups set expected_entry_time = '07:00', is_active = false where code = 'P'",
        );
        await api("update school_years set name = 'P2', starts_on = '2200-01-02' where name = 'P'");
        // columnas NO concedidas: no se pueden escribir ni al insertar ni al actualizar
        await denied(
          "insert into school_years (name, starts_on, ends_on, is_active) values ('Q', '2201-01-01', '2201-12-31', true)",
        );
        await denied(
          "insert into school_years (id, name, starts_on, ends_on) values (gen_random_uuid(), 'R', '2202-01-01', '2202-12-31')",
        );
        await denied(
          "insert into school_years (name, starts_on, ends_on, created_at) values ('S', '2203-01-01', '2203-12-31', now())",
        );
        await denied(
          "insert into groups (school_year_id, grade, code, is_active) select id, 1, 'Z', true from school_years limit 1",
        );
        await denied("update groups set grade = 2 where code = 'P'");
        await denied('update groups set school_year_id = school_year_id');
        await denied('update groups set id = id');
        await denied('update groups set created_at = now()');
        await denied('update school_years set id = id');
        await denied('update school_years set updated_at = now()');
        // "nombre" que no existe en la lista de columnas: nunca llega a escribirse
        expect(
          Number(
            (
              await cluster.owner.query(
                "select count(*)::int n from school_years where name in ('Q','R','S')",
              )
            ).rows[0].n,
          ),
        ).toBe(0);
      });
      it('DELETE, TRUNCATE, TRIGGER y REFERENCES denegados; sin CREATE ni SET ROLE privilegiado', async () => {
        await denied('delete from groups');
        await denied('delete from school_years');
        await denied('truncate groups');
        await denied('truncate school_years');
        await denied(
          'create trigger t_x before insert on groups for each row execute function pg_catalog.suppress_redundant_updates_trigger()',
        );
        await denied(
          'alter table groups add constraint x foreign key (id) references school_years(id)',
        );
        await denied('create table pwn (id int)');
        await denied('set role eta15_app');
        await denied('alter table groups disable trigger all');
      });
      it('no puede tocar la autorizacion: role_permissions, permissions ni roles (sin escalamiento)', async () => {
        await denied(
          "insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope) select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = 'prefectura' and p.key = 'catalog:manage_school'",
        );
        await denied("update role_permissions set scope = 'all'");
        await denied('delete from role_permissions');
        await denied("update permissions set description = 'x'");
        await denied(
          "insert into permissions (key, description, domain, is_authority) values ('catalog:pwn', 'x', 'school', true)",
        );
        await denied('update roles set requires_mfa = false');
        await denied('update users set account_domain = account_domain');
      });
      it('el script de verificacion detecta un privilegio de mas (DELETE) y uno de menos', async () => {
        await cluster.owner.query('grant delete on groups to eta15_api');
        await expect(verify()).rejects.toThrow(/DELETE sobre groups/);
        await cluster.owner.query('revoke delete on groups from eta15_api');
        await verify();
        await cluster.owner.query('grant update (grade) on groups to eta15_api');
        await expect(verify()).rejects.toThrow(/UPDATE groups.grade/);
        await cluster.owner.query('revoke update (grade) on groups from eta15_api');
        await cluster.owner.query('revoke update (is_active) on groups from eta15_api');
        await expect(verify()).rejects.toThrow(/UPDATE groups.is_active/);
        await cluster.owner.query('grant update (is_active) on groups to eta15_api');
        await verify();
      });
    } else {
      it('estado real (eta15_dev hoy): solo lectura del catalogo y el verificador lo senala', async () => {
        await denied(
          "insert into school_years (name, starts_on, ends_on) values ('X','2200-01-01','2200-12-31')",
        );
        await denied('update groups set is_active = false');
        await expect(api('select count(*) from groups')).resolves.toBeTruthy();
        await expect(verify()).rejects.toThrow(/Privilegios efectivos de eta15_api inesperados/);
      });
    }
  });
}

suite('PostgreSQL desechable + privilegios 0002', 'full');
suite('PostgreSQL desechable, estado real (sin 0002)', 'none');
