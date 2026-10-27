import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readEnvFile } from '../../scripts/db-identity.js';

/**
 * Estado REAL de eta15_dev respecto a la asistencia diaria (migracion 0010 y propuesta de privilegios 0005). SOLO LECTURA: consulta
 * catalogos con el propietario y no crea ni cambia nada. Las expectativas dependen del estado (antes o despues de aplicar la 0010 con
 * autorizacion); lo que NUNCA cambia: sin DELETE/TRUNCATE/TRIGGER/REFERENCES para la API, historial sin UPDATE, sin datos.
 * Requiere apps/api/.env.migrator; si falta, FALLA. Ejecutar con:  pnpm test:integration
 */
const migratorEnv = readEnvFile('.env.migrator');
let owner: pg.Client;
const TABLES = ['attendance_days', 'attendance_records', 'attendance_events'] as const;

beforeAll(async () => {
  if (!migratorEnv?.DB_PASSWORD) throw new Error('Falta apps/api/.env.migrator (eta15_app).');
  owner = new pg.Client({
    host: migratorEnv.DB_HOST ?? '127.0.0.1',
    port: Number(migratorEnv.DB_PORT ?? 5432),
    database: migratorEnv.DB_NAME ?? 'eta15_dev',
    user: migratorEnv.DB_USER,
    password: migratorEnv.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  await owner.connect();
}, 20_000);
afterAll(async () => owner?.end());

const present = async () =>
  (
    await owner.query<{ n: number }>(
      `select count(*)::int n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any($1)`,
      [[...TABLES]],
    )
  ).rows[0]!.n;
const grantedColumns = async (table: string, priv: string) =>
  (
    await owner.query<{ c: string }>(
      `select column_name c from information_schema.column_privileges
        where grantee = 'eta15_api' and table_name = $1 and privilege_type = $2 order by 1`,
      [table, priv],
    )
  ).rows.map((x) => x.c);

describe('asistencia diaria en eta15_dev (solo lectura)', () => {
  it('las tres tablas existen juntas (0010 aplicada) o no existe ninguna (0010 sin aplicar)', async () => {
    expect([0, 3]).toContain(await present());
  });

  it('migraciones aplicadas: 10 (0000-0009) sin la 0010, 11 con ella', async () => {
    const n = (
      await owner.query<{ n: number }>(`select count(*)::int n from drizzle.__drizzle_migrations`)
    ).rows[0]!.n;
    expect(n).toBe((await present()) === 3 ? 11 : 10);
  });

  it('politica RBAC: trabajo social conserva attendance:read global SOLO mientras la 0010 no se aplica; despues ninguna asistencia', async () => {
    const r = await owner.query<{ k: string }>(
      `select r.key || '|' || p.key || '|' || rp.scope as k from role_permissions rp
         join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key like 'attendance:%' order by 1`,
    );
    const common = [
      'direccion|attendance:correct|all',
      'direccion|attendance:read|all',
      'prefectura|attendance:capture|assigned_groups',
      'prefectura|attendance:read|assigned_groups',
    ];
    const expected =
      (await present()) === 3 ? common : [...common, 'trabajo_social|attendance:read|all'];
    expect(r.rows.map((x) => x.k).sort()).toEqual(expected.sort());
    // admin_tecnico y control_acceso nunca tienen asistencia
    expect(r.rows.some((x) => /^(admin_tecnico|control_acceso)\|/.test(x.k))).toBe(false);
  });

  it('sin datos de asistencia en eta15_dev; la API sin acceso hasta aplicar 0005 con autorizacion', async () => {
    if ((await present()) === 0) {
      for (const t of TABLES) expect(await grantedColumns(t, 'SELECT')).toEqual([]);
      return;
    }
    for (const t of TABLES) {
      const n = (await owner.query<{ n: number }>(`select count(*)::int n from ${t}`)).rows[0]!.n;
      expect(n, `filas en ${t}`).toBe(0); // ninguna lista, ni real ni de prueba
    }
    // si la 0005 se aplico, el acceso es EXACTAMENTE el aprobado; si no, ninguno
    const sel = await grantedColumns('attendance_days', 'SELECT');
    if (sel.length === 0) {
      for (const t of TABLES)
        for (const p of ['SELECT', 'INSERT', 'UPDATE'])
          expect(await grantedColumns(t, p), `${t} ${p}`).toEqual([]);
    } else {
      expect(await grantedColumns('attendance_days', 'INSERT')).toEqual([
        'attendance_date',
        'created_by',
        'group_id',
        'school_year_id',
      ]);
      expect(await grantedColumns('attendance_days', 'UPDATE')).toEqual([
        'finalized_by',
        'revision',
        'status',
      ]);
      expect(await grantedColumns('attendance_records', 'UPDATE')).toEqual(['marked_by', 'status']);
      expect(await grantedColumns('attendance_events', 'UPDATE')).toEqual([]); // el historial solo se agrega
    }
  });

  it('la API jamas tiene DELETE, TRUNCATE, TRIGGER ni REFERENCES sobre la asistencia (y los privilegios de tabla completos tampoco)', async () => {
    for (const t of TABLES) {
      for (const p of [
        'DELETE',
        'TRUNCATE',
        'TRIGGER',
        'REFERENCES',
        'SELECT',
        'INSERT',
        'UPDATE',
      ]) {
        const r = await owner.query<{ ok: boolean | null }>(
          `select case when to_regclass($1) is null then false else has_table_privilege('eta15_api', $1, $2) end as ok`,
          [`public.${t}`, p],
        );
        expect(r.rows[0]!.ok, `${t} ${p} (tabla)`).toBe(false);
      }
    }
  });
});
