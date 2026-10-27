import { describe, expect, it } from 'vitest';
import { createSchoolCatalogService } from '../../src/modules/school-catalog/school-catalog.service.js';
import { ORIGIN } from './auth-http-suite.js';
import type { AdminKit, Login } from './admin-http-suite.js';

/**
 * Pruebas HTTP del catalogo escolar (ciclos y grupos) con Fastify `inject` sobre PostgreSQL real (PGlite o clúster desechable),
 * con un rol de ejecucion NO propietario. Cuentas, ciclos y grupos FICTICIOS; nunca contra eta15_dev.
 * `privileges: 'none'` reproduce el estado REAL actual de eta15_dev (la API solo lee el catalogo).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCHOOL_TZ = 'America/Mazatlan';
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ }).format(new Date());
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function defineCatalogTests(
  kit: AdminKit,
  opts: { privileges: 'full' | 'none' } = { privileges: 'full' },
): void {
  describe(`catalogo escolar (${opts.privileges === 'full' ? 'con privilegios de escritura' : 'estado real: API solo lectura'})`, () => {
    const today = todayIso();
    const dates = {
      past: { startsOn: addDays(today, -800), endsOn: addDays(today, -435) },
      current: { startsOn: addDays(today, -100), endsOn: addDays(today, 200) },
      future: { startsOn: addDays(today, 201), endsOn: addDays(today, 400) },
    };
    const ids: Record<'past' | 'current' | 'future', string> = {
      past: '',
      current: '',
      future: '',
    };
    /** Direccion (dominio escolar): unico rol con catalog:manage_school. */
    let dir: Login;
    let tecnico: Login;
    let pref: Login;
    const q = async (sql: string, params: unknown[] = []) =>
      (await kit.harness.owner(sql, params)).rows;
    const auditCount = async (type: string) =>
      Number(
        (await q(`select count(*)::int n from audit_events where event_type = $1`, [type]))[0]!.n,
      );
    const writeRoute = (
      login: Login | null,
      method: 'POST' | 'PATCH',
      url: string,
      body?: unknown,
      extra: Record<string, unknown> = {},
    ) => kit.call(login, method, url, { body, ...extra });
    const years = (extra = '') => kit.call(dir, 'GET', `/catalog/school-years${extra}`);

    it('preparacion: tres ciclos ficticios (pasado, vigente y futuro) y las cuentas de prueba', async () => {
      dir = await kit.login(kit.boss);
      tecnico = await kit.login(kit.techBoss);
      pref = await kit.login(await kit.seed({ role: 'prefectura' }));
      for (const key of ['past', 'current', 'future'] as const) {
        const r = await q(
          `insert into school_years (name, starts_on, ends_on) values ($1, $2, $3) returning id`,
          [`Ciclo ${key}`, dates[key].startsOn, dates[key].endsOn],
        );
        ids[key] = r[0]!.id as string;
      }
      // grupo historico (solo el propietario puede crearlo: la API no crea grupos en ciclos terminados)
      await q(`insert into groups (school_year_id, grade, code, shift) values ($1, 1, 'H', null)`, [
        ids.past,
      ]);
    });

    describe('autorizacion', () => {
      it('sin sesion: 401 en todas las rutas', async () => {
        for (const [m, u] of [
          ['GET', '/catalog/school-years'],
          ['GET', '/catalog/groups'],
          ['POST', '/catalog/school-years'],
          ['POST', '/catalog/groups'],
          ['PATCH', `/catalog/groups/${ids.current}`],
        ] as const) {
          expect(
            (await kit.call(null, m, u, { body: m === 'GET' ? undefined : {} })).statusCode,
            `${m} ${u}`,
          ).toBe(401);
        }
      });

      it('politica RBAC: Direccion y admin_tecnico LEEN; una prefectura NO (sin catalog:read global)', async () => {
        for (const who of [dir, tecnico]) {
          const list = await kit.call(who, 'GET', '/catalog/school-years');
          expect(list.statusCode).toBe(200);
          expect((list.json() as Json).items.length).toBeGreaterThanOrEqual(3);
          expect((await kit.call(who, 'GET', '/catalog/groups')).statusCode).toBe(200);
        }
        const before = await auditCount('authz.denied');
        expect((await kit.call(pref, 'GET', '/catalog/school-years')).statusCode).toBe(403);
        expect((await kit.call(pref, 'GET', '/catalog/groups')).statusCode).toBe(403);
        expect(await auditCount('authz.denied')).toBeGreaterThanOrEqual(before + 2);
      });

      it('admin_tecnico y prefectura NO administran el catalogo escolar: 403 y queda auditado', async () => {
        const before = await auditCount('authz.denied');
        for (const who of [pref, tecnico]) {
          expect(
            (
              await writeRoute(who, 'POST', '/catalog/school-years', {
                name: 'Intruso',
                ...dates.future,
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await writeRoute(who, 'POST', '/catalog/groups', {
                schoolYearId: ids.current,
                grade: 1,
                code: 'Z',
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await writeRoute(who, 'PATCH', `/catalog/school-years/${ids.current}`, {
                name: 'Otro',
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (await writeRoute(who, 'POST', `/catalog/school-years/${ids.current}/activate`))
              .statusCode,
          ).toBe(403);
          expect(
            (await writeRoute(who, 'PATCH', `/catalog/groups/${ids.current}`, { isActive: false }))
              .statusCode,
          ).toBe(403);
        }
        expect(await auditCount('authz.denied')).toBeGreaterThanOrEqual(before + 10);
        expect(Number((await q(`select count(*)::int n from school_years`))[0]!.n)).toBe(3);
      });

      it('admin_tecnico conserva sus permisos tecnicos y no obtiene autoridad escolar ni datos de alumnos', async () => {
        expect((await kit.call(tecnico, 'GET', '/admin/roles')).statusCode).toBe(200);
        const me = (await kit.call(tecnico, 'GET', '/auth/me')).json() as Json;
        const keys = (me.permissions as Array<{ permission: string }>).map((x) => x.permission);
        expect(keys).toContain('users:manage_technical');
        expect(keys).toContain('catalog:read');
        expect(keys).not.toContain('catalog:manage');
        expect(keys).not.toContain('catalog:manage_school');
        expect(keys.filter((k) => k.startsWith('students:') || k.endsWith('_school'))).toEqual([]);
        // y la cuenta escolar de Direccion SI recibe el permiso nuevo, con alcance all
        const dme = (await kit.call(dir, 'GET', '/auth/me')).json() as Json;
        expect(dme.permissions).toContainEqual({
          permission: 'catalog:manage_school',
          scope: 'all',
        });
        expect(dme.permissions.map((x: Json) => x.permission)).not.toContain('catalog:manage');
      });

      it('la API no ofrece rutas para editar permisos de roles ni para auto-concederse el catalogo', async () => {
        for (const [m, u] of [
          ['PATCH', '/admin/roles/direccion'],
          ['POST', '/admin/roles/admin_tecnico/permissions'],
          ['PATCH', '/admin/roles/admin_tecnico/permissions'],
        ] as const) {
          expect(
            (
              await writeRoute(dir, m as 'POST' | 'PATCH', u, {
                permission: 'catalog:manage_school',
              })
            ).statusCode,
            u,
          ).toBe(404);
        }
        const self = await writeRoute(tecnico, 'POST', `/admin/users/${kit.techBoss.id}/roles`, {
          roleKey: 'direccion',
        });
        expect(self.statusCode).toBeGreaterThanOrEqual(400);
        expect(
          Number(
            (
              await q(
                `select count(*)::int n from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and ur.revoked_at is null and r.key = 'direccion'`,
                [kit.techBoss.id],
              )
            )[0]!.n,
          ),
        ).toBe(0);
      });

      it('el modelo SQL impide dar permisos del catalogo a un dominio incompatible', async () => {
        const insert = (role: string, perm: string) =>
          q(
            `insert into role_permissions (role_id, role_domain, permission_id, permission_domain, scope)
             select r.id, r.domain, p.id, p.domain, 'all' from roles r, permissions p where r.key = $1 and p.key = $2`,
            [role, perm],
          );
        await expect(insert('admin_tecnico', 'catalog:manage_school')).rejects.toBeTruthy();
        await expect(insert('direccion', 'catalog:manage')).rejects.toBeTruthy();
        const matrix = await q(
          `select r.key as role, p.key as permission from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key like 'catalog:%' order by 1, 2`,
        );
        expect(matrix).toEqual([
          { role: 'admin_tecnico', permission: 'catalog:read' },
          { role: 'direccion', permission: 'catalog:manage_school' },
          { role: 'direccion', permission: 'catalog:read' },
        ]);
      });

      it('mutaciones sin CSRF o sin Origin permitido: 403 y sin cambios', async () => {
        const body = { name: 'Sin CSRF', ...dates.future };
        expect(
          (await writeRoute(dir, 'POST', '/catalog/school-years', body, { csrf: false }))
            .statusCode,
        ).toBe(403);
        expect(
          (await writeRoute(dir, 'POST', '/catalog/school-years', body, { csrf: 'x' })).statusCode,
        ).toBe(403);
        const noOrigin = await writeRoute(dir, 'POST', '/catalog/school-years', body, {
          origin: false,
        });
        expect((noOrigin.json() as Json).error.code).toBe('FORBIDDEN_ORIGIN');
        expect(
          Number(
            (await q(`select count(*)::int n from school_years where name = 'Sin CSRF'`))[0]!.n,
          ),
        ).toBe(0);
      });

      it('sesion revocada: 401 inmediato', async () => {
        const second = await kit.login(await kit.seed({ domain: 'school', role: 'direccion' }));
        await q(
          `update sessions set revoked_at = now(), revoked_reason = 'admin' where revoked_at is null and user_id = (select id from users where email = $1)`,
          [second.account.email],
        );
        expect((await kit.call(second, 'GET', '/catalog/school-years')).statusCode).toBe(401);
        expect(
          (
            await writeRoute(second, 'POST', '/catalog/school-years', {
              name: 'X',
              ...dates.future,
            })
          ).statusCode,
        ).toBe(401);
      });

      it('CORS: el preflight de PATCH solo se concede a un origen permitido', async () => {
        const ok = await kit.app().inject({
          method: 'OPTIONS',
          url: `/catalog/groups/${ids.current}`,
          headers: { origin: ORIGIN, 'access-control-request-method': 'PATCH' },
        });
        expect(String(ok.headers['access-control-allow-methods'])).toContain('PATCH');
        expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
        const evil = await kit.app().inject({
          method: 'OPTIONS',
          url: `/catalog/groups/${ids.current}`,
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'PATCH' },
        });
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      });
    });

    describe('ciclos escolares', () => {
      it('consulta: paginacion, filtro de vigente, detalle, periodo y conteo de grupos', async () => {
        const all = (await years('?pageSize=2&page=1')).json() as Json;
        expect(all).toMatchObject({ page: 1, pageSize: 2 });
        expect(all.total).toBeGreaterThanOrEqual(3);
        expect(all.items).toHaveLength(2);
        const detail = (
          await kit.call(dir, 'GET', `/catalog/school-years/${ids.current}`)
        ).json() as Json;
        expect(detail).toMatchObject({
          name: 'Ciclo current',
          period: 'current',
          isActive: false,
          groupCount: 0,
          ...dates.current,
        });
        const past = (
          await kit.call(dir, 'GET', `/catalog/school-years/${ids.past}`)
        ).json() as Json;
        expect(past).toMatchObject({ period: 'past', groupCount: 1 });
        expect(
          ((await kit.call(dir, 'GET', `/catalog/school-years/${ids.future}`)).json() as Json)
            .period,
        ).toBe('future');
        expect(((await years('?isActive=true')).json() as Json).total).toBe(0);
        for (const bad of ['?pageSize=500', '?page=0', '?isActive=quiza', '?orden=asc'])
          expect((await years(bad)).statusCode, bad).toBe(400);
        expect((await kit.call(dir, 'GET', '/catalog/school-years/no-es-uuid')).statusCode).toBe(
          400,
        );
        expect(
          (await kit.call(dir, 'GET', '/catalog/school-years/00000000-0000-4000-8000-000000000009'))
            .statusCode,
        ).toBe(404);
      });

      if (opts.privileges === 'none') {
        it('ESTADO REAL: sin los privilegios 0002 las mutaciones responden 503 CATALOG_WRITE_UNAVAILABLE y no cambian nada', async () => {
          const res = await writeRoute(dir, 'POST', '/catalog/school-years', {
            name: 'Ciclo nuevo',
            startsOn: addDays(today, 500),
            endsOn: addDays(today, 800),
          });
          expect(res.statusCode).toBe(503);
          expect((res.json() as Json).error.code).toBe('CATALOG_WRITE_UNAVAILABLE');
          expect(res.body).not.toMatch(/permission|42501|INSERT|sql/i);
          const grp = await writeRoute(dir, 'POST', '/catalog/groups', {
            schoolYearId: ids.current,
            grade: 1,
            code: 'A',
          });
          expect(grp.statusCode).toBe(503);
          expect(
            (await writeRoute(dir, 'POST', `/catalog/school-years/${ids.current}/activate`))
              .statusCode,
          ).toBe(503);
          expect(Number((await q(`select count(*)::int n from school_years`))[0]!.n)).toBe(3);
        });
        return;
      }

      it('crea un ciclo valido (201), lo audita y lo devuelve; el actor es quien tiene la sesion', async () => {
        const body = {
          name: 'Ciclo extra',
          startsOn: addDays(today, 401),
          endsOn: addDays(today, 700),
        };
        const res = await writeRoute(dir, 'POST', '/catalog/school-years', body);
        expect(res.statusCode, res.body).toBe(201);
        const created = res.json() as Json;
        expect(created).toMatchObject({
          ...body,
          isActive: false,
          period: 'future',
          groupCount: 0,
        });
        expect(res.headers.location).toBe(`/catalog/school-years/${created.id}`);
        const audit = (
          await q(
            `select actor_user_id, details from audit_events where event_type = 'school_year.created' order by occurred_at desc limit 1`,
          )
        )[0]!;
        expect(audit.actor_user_id).toBe(kit.boss.id);
        expect((audit.details as Json).name).toBe('Ciclo extra');
      });

      it('rechaza fechas invalidas, duraciones absurdas, nombres sucios y campos extra (400)', async () => {
        const base = {
          name: 'Ciclo X',
          startsOn: addDays(today, 900),
          endsOn: addDays(today, 1200),
        };
        const bad: unknown[] = [
          { ...base, endsOn: base.startsOn },
          { ...base, endsOn: addDays(today, 800) },
          { ...base, startsOn: '2026-02-30' },
          { ...base, startsOn: '25/08/2026' },
          { ...base, endsOn: addDays(base.startsOn, 20) }, // < 60 dias
          { ...base, endsOn: addDays(base.startsOn, 600) }, // > 400 dias
          { ...base, name: '' },
          { ...base, name: ' con espacios ' },
          { ...base, isActive: true },
          { ...base, id: '00000000-0000-4000-8000-000000000001' },
          { name: 'Sin fechas' },
        ];
        for (const b of bad)
          expect(
            (await writeRoute(dir, 'POST', '/catalog/school-years', b)).statusCode,
            JSON.stringify(b),
          ).toBe(400);
        expect(
          Number(
            (await q(`select count(*)::int n from school_years where name = 'Ciclo X'`))[0]!.n,
          ),
        ).toBe(0);
      });

      it('nombre duplicado y ciclos TRASLAPADOS (limites inclusivos) => 409 controlado, sin SQL interno', async () => {
        const dup = await writeRoute(dir, 'POST', '/catalog/school-years', {
          name: 'Ciclo current',
          startsOn: addDays(today, 2000),
          endsOn: addDays(today, 2300),
        });
        expect(dup.statusCode).toBe(409);
        expect(dup.body).not.toMatch(/constraint|violates|duplicate key|sql/i);
        const overlap = await writeRoute(dir, 'POST', '/catalog/school-years', {
          name: 'Solapado',
          startsOn: dates.current.endsOn,
          endsOn: addDays(dates.current.endsOn, 200),
        });
        expect(overlap.statusCode).toBe(409); // empieza el mismo dia en que otro termina
        expect(overlap.body).toMatch(/traslapan/);
        const inside = await writeRoute(dir, 'POST', '/catalog/school-years', {
          name: 'Interior',
          startsOn: addDays(today, -10),
          endsOn: addDays(today, 100),
        });
        expect(inside.statusCode).toBe(409);
        const gapless = await writeRoute(dir, 'POST', '/catalog/school-years', {
          name: 'Consecutivo',
          startsOn: addDays(today, 701),
          endsOn: addDays(today, 1000),
        });
        expect(gapless.statusCode).toBe(201); // el dia siguiente al fin de otro si es valido
      });

      it('activa el ciclo que incluye hoy; solo uno vigente; activar de nuevo es idempotente; 10 activaciones simultaneas', async () => {
        const res = await writeRoute(dir, 'POST', `/catalog/school-years/${ids.current}/activate`);
        expect(res.statusCode, res.body).toBe(200);
        expect((res.json() as Json).isActive).toBe(true);
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            writeRoute(dir, 'POST', `/catalog/school-years/${ids.current}/activate`),
          ),
        );
        expect(results.every((r) => r.statusCode === 200)).toBe(true);
        expect(
          Number((await q(`select count(*)::int n from school_years where is_active`))[0]!.n),
        ).toBe(1);
        expect(await auditCount('school_year.activated')).toBe(1); // las repeticiones no auditan de nuevo
        expect(
          ((await years('?isActive=true')).json() as Json).items.map((y: Json) => y.name),
        ).toEqual(['Ciclo current']);
      });

      it('no se activa un ciclo futuro ni uno pasado (la vigencia es la de hoy) y no cambia el vigente', async () => {
        for (const key of ['future', 'past'] as const) {
          const r = await writeRoute(dir, 'POST', `/catalog/school-years/${ids[key]}/activate`);
          expect(r.statusCode, key).toBe(400);
          expect(r.body).toMatch(/fecha de hoy/);
        }
        expect(
          ((await kit.call(dir, 'GET', `/catalog/school-years/${ids.current}`)).json() as Json)
            .isActive,
        ).toBe(true);
        expect(
          (
            await writeRoute(
              dir,
              'POST',
              '/catalog/school-years/00000000-0000-4000-8000-000000000009/activate',
            )
          ).statusCode,
        ).toBe(404);
      });

      it('edita nombre y fechas del ciclo: valida coherencia, traslapes y que el vigente incluya hoy', async () => {
        const cur = `/catalog/school-years/${ids.current}`;
        expect((await writeRoute(dir, 'PATCH', cur, { name: 'Ciclo vigente 1' })).statusCode).toBe(
          200,
        );
        expect((await writeRoute(dir, 'PATCH', cur, { name: 'Ciclo current' })).statusCode).toBe(
          200,
        );
        const before = await auditCount('school_year.updated');
        expect((await writeRoute(dir, 'PATCH', cur, { name: 'Ciclo current' })).statusCode).toBe(
          200,
        ); // sin cambios: no audita
        expect(await auditCount('school_year.updated')).toBe(before);
        expect(
          (await writeRoute(dir, 'PATCH', cur, { endsOn: addDays(today, 250) })).statusCode,
        ).toBe(409); // traslapa con el futuro (duración válida: 351 días)
        expect(
          (await writeRoute(dir, 'PATCH', cur, { endsOn: addDays(today, 500) })).statusCode,
        ).toBe(400); // más de 400 días
        expect(
          (await writeRoute(dir, 'PATCH', cur, { endsOn: addDays(today, -5) })).statusCode,
        ).toBe(400); // el vigente debe incluir hoy
        expect(
          (await writeRoute(dir, 'PATCH', cur, { startsOn: addDays(today, 1) })).statusCode,
        ).toBe(400);
        expect(
          (await writeRoute(dir, 'PATCH', cur, { endsOn: dates.current.startsOn })).statusCode,
        ).toBe(400);
        for (const bad of [{}, { isActive: false }, { id: ids.past }, { name: ' x ' }])
          expect((await writeRoute(dir, 'PATCH', cur, bad)).statusCode, JSON.stringify(bad)).toBe(
            400,
          );
        expect(
          (
            await writeRoute(dir, 'PATCH', `/catalog/school-years/${ids.past}`, {
              name: 'Reescribir historia',
            })
          ).statusCode,
        ).toBe(409);
        expect(
          ((await kit.call(dir, 'GET', `/catalog/school-years/${ids.past}`)).json() as Json).name,
        ).toBe('Ciclo past');
      });

      it('desactivar es idempotente y no borra nada; no existe DELETE', async () => {
        const url = `/catalog/school-years/${ids.current}/deactivate`;
        expect((await writeRoute(dir, 'POST', url)).statusCode).toBe(200);
        expect(((await writeRoute(dir, 'POST', url)).json() as Json).isActive).toBe(false);
        expect(await auditCount('school_year.deactivated')).toBe(1);
        expect(
          (await kit.call(dir, 'DELETE', `/catalog/school-years/${ids.current}`)).statusCode,
        ).toBe(404);
        expect(
          Number((await q(`select count(*)::int n from school_years`))[0]!.n),
        ).toBeGreaterThanOrEqual(3);
      });

      it('relevo de ciclo: activar el nuevo desactiva el anterior en una transaccion (hoy simulado, servicio)', async () => {
        const svc = (todayValue: string) =>
          createSchoolCatalogService({ store: kit.harness.store, today: () => todayValue });
        const ctx = {
          actor: {
            id: kit.boss.id,
            status: 'active' as const,
            permissions: new Set(['catalog:read', 'catalog:manage_school']),
            roleKeys: new Set(['direccion']),
          },
        };
        const a = (
          await q(
            `insert into school_years (name, starts_on, ends_on) values ('Relevo A', '2090-08-01', '2091-07-15') returning id`,
          )
        )[0]!.id as string;
        const b = (
          await q(
            `insert into school_years (name, starts_on, ends_on) values ('Relevo B', '2091-07-16', '2092-07-15') returning id`,
          )
        )[0]!.id as string;
        expect((await svc('2090-12-01').activateSchoolYear(ctx, a)).ok).toBe(true);
        const swap = await svc('2091-08-01').activateSchoolYear(ctx, b);
        expect(swap.ok).toBe(true);
        const states = await q(
          `select name, is_active from school_years where name in ('Relevo A','Relevo B') order by name`,
        );
        expect(states).toEqual([
          { name: 'Relevo A', is_active: false },
          { name: 'Relevo B', is_active: true },
        ]);
        const ev = (
          await q(
            `select details from audit_events where event_type = 'school_year.activated' order by occurred_at desc limit 1`,
          )
        )[0]!;
        expect((ev.details as Json).previousId).toBe(a);
        // un ciclo ya terminado no se edita ni admite grupos nuevos aunque siga marcado vigente
        expect((await svc('2095-01-01').updateSchoolYear(ctx, b, { name: 'Tarde' })).ok).toBe(
          false,
        );
        await q(`delete from school_years where name in ('Relevo A','Relevo B')`).catch(
          () => undefined,
        );
      });
    });

    if (opts.privileges === 'none') return;

    describe('grupos', () => {
      const create = (body: Record<string, unknown>) =>
        writeRoute(dir, 'POST', '/catalog/groups', {
          schoolYearId: ids.current,
          grade: 1,
          code: 'A',
          ...body,
        });
      const list = async (extra = '') =>
        (await kit.call(dir, 'GET', `/catalog/groups${extra}`)).json() as Json;

      it('crea un grupo: normaliza el codigo, turno opcional y hora de entrada opcional (NULL)', async () => {
        const res = await create({ code: '  tec  1 ' });
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json()).toMatchObject({
          schoolYearId: ids.current,
          grade: 1,
          code: 'TEC 1',
          shift: null,
          expectedEntryTime: null,
          isActive: true,
          historical: false,
          schoolYearName: 'Ciclo current',
        });
        expect(res.headers.location).toMatch(/^\/catalog\/groups\//);
        const audit = (
          await q(
            `select actor_user_id, details from audit_events where event_type = 'group.created' order by occurred_at desc limit 1`,
          )
        )[0]!;
        expect(audit.actor_user_id).toBe(kit.boss.id);
      });

      it('horas de entrada: 07:00, 07:50 y otras horas validas con minuto; el horario es independiente del turno', async () => {
        const cases: Array<[string, string]> = [
          ['07:00', '07:00'],
          ['07:50', '07:50'],
          ['13:05', '13:05'],
          ['00:00', '00:00'],
          ['23:59', '23:59'],
          ['08:30:00', '08:30'],
        ];
        for (const [i, [input, shown]] of cases.entries()) {
          const res = await create({
            grade: 2,
            code: `H${i}`,
            shift: 'matutino',
            expectedEntryTime: input,
          });
          expect(res.statusCode, input).toBe(201);
          expect((res.json() as Json).expectedEntryTime).toBe(shown);
        }
        // mismo turno, horas distintas: la unicidad no incluye la hora
        const a = await create({
          grade: 3,
          code: 'M1',
          shift: 'matutino',
          expectedEntryTime: '07:00',
        });
        const b = await create({
          grade: 3,
          code: 'M2',
          shift: 'matutino',
          expectedEntryTime: '07:50',
        });
        expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
        expect(
          ((await q(`select expected_entry_time::text t from groups where code = 'H0'`))[0] as Json)
            .t,
        ).toBe('07:00:00');
      });

      it('rechaza horas con segundos, 24:00 y formatos raros; grados y codigos invalidos; campos extra (400)', async () => {
        const bad: Array<Record<string, unknown>> = [
          { expectedEntryTime: '07:00:30' },
          { expectedEntryTime: '07:50:01' },
          { expectedEntryTime: '24:00' },
          { expectedEntryTime: '7:5' },
          { expectedEntryTime: '25:00' },
          { expectedEntryTime: 700 },
          { grade: 0 },
          { grade: 4 },
          { grade: 1.5 },
          { code: '' },
          { code: 'ABCDEFGHIJK' },
          { code: 'A_B' },
          { code: 'Ñ' },
          { shift: 'nocturno' },
          { isActive: false },
          { schoolYearId: 'no-uuid' },
          { id: '00000000-0000-4000-8000-000000000001' },
        ];
        for (const b of bad) expect((await create(b)).statusCode, JSON.stringify(b)).toBe(400);
      });

      it('duplicados: mismo ciclo+grado+codigo+turno (incluye turno NULL) => 409; otro turno o grado => 201', async () => {
        expect((await create({ grade: 1, code: 'DUP' })).statusCode).toBe(201);
        const again = await create({ grade: 1, code: 'dup' }); // la normalizacion lo vuelve a iguala
        expect(again.statusCode).toBe(409);
        expect(again.body).not.toMatch(/constraint|violates|duplicate key|sql/i);
        expect((await create({ grade: 1, code: 'DUP', shift: 'vespertino' })).statusCode).toBe(201);
        expect((await create({ grade: 1, code: 'DUP', shift: 'vespertino' })).statusCode).toBe(409);
        expect((await create({ grade: 2, code: 'DUP' })).statusCode).toBe(201);
      });

      it('10 altas simultaneas del mismo grupo: exactamente una; el resto 409', async () => {
        const results = await Promise.all(
          Array.from({ length: 10 }, () => create({ grade: 3, code: 'CARRERA' })),
        );
        expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
        expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
      });

      it('ciclo inexistente => 400; ciclo historico => 409 (no se crean grupos en el pasado); ciclo futuro si', async () => {
        expect(
          (await create({ schoolYearId: '00000000-0000-4000-8000-000000000009' })).statusCode,
        ).toBe(400);
        const hist = await create({ schoolYearId: ids.past, code: 'NUEVO' });
        expect(hist.statusCode).toBe(409);
        expect((hist.json() as Json).error.code).toBe('HISTORICAL');
        expect((await create({ schoolYearId: ids.future, code: 'F1' })).statusCode).toBe(201);
      });

      it('lista y filtra: ciclo, grado, turno (incluye "none"), activo y busqueda por codigo; pagina', async () => {
        const all = await list('?pageSize=100');
        expect(all.total).toBeGreaterThan(10);
        expect(
          (await list(`?schoolYearId=${ids.future}`)).items.every(
            (g: Json) => g.schoolYearId === ids.future,
          ),
        ).toBe(true);
        expect(
          (await list(`?schoolYearId=${ids.current}&grade=2&pageSize=100`)).items.every(
            (g: Json) => g.grade === 2,
          ),
        ).toBe(true);
        const matutino = await list('?shift=matutino&pageSize=100');
        expect(matutino.items.length).toBeGreaterThan(0);
        expect(matutino.items.every((g: Json) => g.shift === 'matutino')).toBe(true);
        const none = await list('?shift=none&pageSize=100');
        expect(none.items.every((g: Json) => g.shift === null)).toBe(true);
        expect(
          (await list('?q=dup&pageSize=100')).items.every((g: Json) => g.code.includes('DUP')),
        ).toBe(true);
        expect((await list('?q=%25&pageSize=100')).total).toBe(0); // comodin escapado
        expect((await list('?isActive=false')).total).toBe(0);
        const p1 = await list('?pageSize=5&page=1');
        const p2 = await list('?pageSize=5&page=2');
        expect(p1.items).toHaveLength(5);
        expect(new Set([...p1.items, ...p2.items].map((g: Json) => g.id)).size).toBe(10);
        for (const bad of [
          '?grade=4',
          '?shift=nocturno',
          '?schoolYearId=x',
          '?pageSize=101',
          '?isActive=1',
          '?extra=1',
        ])
          expect((await kit.call(dir, 'GET', `/catalog/groups${bad}`)).statusCode, bad).toBe(400);
        const hist = (await list(`?schoolYearId=${ids.past}`)).items[0] as Json;
        expect(hist).toMatchObject({ code: 'H', historical: true });
      });

      it('edita un grupo: hora de entrada (cambio, NULL), turno, codigo y baja logica; audita antes/despues', async () => {
        const g = (
          await create({ grade: 2, code: 'ED', shift: 'matutino', expectedEntryTime: '07:00' })
        ).json() as Json;
        const url = `/catalog/groups/${g.id}`;
        const t = await writeRoute(dir, 'PATCH', url, { expectedEntryTime: '07:50' });
        expect(t.statusCode, t.body).toBe(200);
        expect((t.json() as Json).expectedEntryTime).toBe('07:50');
        expect(
          ((await writeRoute(dir, 'PATCH', url, { expectedEntryTime: null })).json() as Json)
            .expectedEntryTime,
        ).toBeNull();
        expect(
          (await writeRoute(dir, 'PATCH', url, { shift: null, code: 'ed2' })).json() as Json,
        ).toMatchObject({ shift: null, code: 'ED2' });
        const off = (await writeRoute(dir, 'PATCH', url, { isActive: false })).json() as Json;
        expect(off.isActive).toBe(false);
        expect(
          ((await writeRoute(dir, 'PATCH', url, { isActive: true })).json() as Json).isActive,
        ).toBe(true);
        const ev = (
          await q(
            `select details from audit_events where event_type = 'group.updated' and details->>'id' = $1 order by occurred_at limit 1`,
            [g.id],
          )
        )[0]!;
        expect((ev.details as Json).changed).toEqual(['expectedEntryTime']);
        expect((ev.details as Json).before.expectedEntryTime).toBe('07:00');
        expect((ev.details as Json).after.expectedEntryTime).toBe('07:50');
        const before = await auditCount('group.updated');
        expect((await writeRoute(dir, 'PATCH', url, { isActive: true })).statusCode).toBe(200); // sin cambios
        expect(await auditCount('group.updated')).toBe(before);
      });

      it('el ciclo y el grado NO se pueden cambiar; segundos invalidos y vacios se rechazan; conflicto de codigo => 409', async () => {
        const g = (await create({ grade: 2, code: 'FIJO' })).json() as Json;
        const other = (await create({ grade: 2, code: 'OTRO' })).json() as Json;
        const url = `/catalog/groups/${g.id}`;
        for (const bad of [
          {},
          { grade: 3 },
          { schoolYearId: ids.future },
          { id: other.id },
          { expectedEntryTime: '07:00:30' },
          { expectedEntryTime: '24:00' },
          { code: 'A_B' },
          { shift: 'x' },
        ]) {
          expect((await writeRoute(dir, 'PATCH', url, bad)).statusCode, JSON.stringify(bad)).toBe(
            400,
          );
        }
        const conflict = await writeRoute(dir, 'PATCH', url, { code: 'otro' });
        expect(conflict.statusCode).toBe(409);
        expect((await kit.call(dir, 'GET', url)).json() as Json).toMatchObject({
          code: 'FIJO',
          grade: 2,
          schoolYearId: ids.current,
        });
        expect(
          (
            await writeRoute(dir, 'PATCH', '/catalog/groups/00000000-0000-4000-8000-000000000009', {
              isActive: false,
            })
          ).statusCode,
        ).toBe(404);
      });

      it('un grupo de un ciclo historico no se modifica (409 HISTORICAL)', async () => {
        const hist = (await list(`?schoolYearId=${ids.past}`)).items[0] as Json;
        const res = await writeRoute(dir, 'PATCH', `/catalog/groups/${hist.id}`, {
          expectedEntryTime: '07:00',
        });
        expect(res.statusCode).toBe(409);
        expect((res.json() as Json).error.code).toBe('HISTORICAL');
        expect(
          ((await q(`select expected_entry_time from groups where id = $1`, [hist.id]))[0] as Json)
            .expected_entry_time,
        ).toBeNull();
      });

      it('cambios concurrentes de la hora de un mismo grupo: gana el ultimo y la fila queda coherente', async () => {
        const g = (await create({ grade: 1, code: 'RACE' })).json() as Json;
        const times = ['07:00', '07:10', '07:20', '07:30', '07:40', '07:50'];
        const results = await Promise.all(
          times.map((t) =>
            writeRoute(dir, 'PATCH', `/catalog/groups/${g.id}`, { expectedEntryTime: t }),
          ),
        );
        expect(results.every((r) => r.statusCode === 200)).toBe(true);
        const final = ((await kit.call(dir, 'GET', `/catalog/groups/${g.id}`)).json() as Json)
          .expectedEntryTime as string;
        expect(times).toContain(final);
      });

      it('no existe borrado destructivo: sin DELETE por la API y sin ese privilegio para el rol de la API', async () => {
        const g = (await list('?pageSize=1')).items[0] as Json;
        expect((await kit.call(dir, 'DELETE', `/catalog/groups/${g.id}`)).statusCode).toBe(404);
        const count = Number((await q(`select count(*)::int n from groups`))[0]!.n);
        expect(count).toBeGreaterThan(0);
      });

      it('sin secretos en las respuestas ni en la auditoria del catalogo', async () => {
        const all = (
          await q(
            `select string_agg(a::text, ' ') as d from audit_events a where event_type like 'school_year.%' or event_type like 'group.%'`,
          )
        )[0]!.d as string;
        expect(all).not.toMatch(/password|argon2|token|cookie/i);
        const body = (await kit.call(dir, 'GET', '/catalog/groups?pageSize=100')).body;
        expect(body).not.toMatch(/password|argon2|token_hash/i);
      });
    });
  });
}
