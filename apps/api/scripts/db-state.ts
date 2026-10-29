import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { API_DIR } from './drizzle-guard.js';
import { checkOwnerConnection, readEnvFile, safeError } from './db-identity.js';

/**
 * Informe de SOLO LECTURA del estado de eta15_dev (preflight y verificacion posterior a una migracion o a un GRANT):
 *   pnpm db:state
 * Exige 127.0.0.1:5432 / eta15_dev / eta15_app, abre una transaccion READ ONLY y solo consulta catalogos y conteos. Imprime JSON
 * sin contrasenas, cadenas de conexion ni datos de personas (solo cantidades y nombres de objetos).
 */
const ONE = async <T extends Record<string, unknown>>(c: pg.Client, sql: string): Promise<T> =>
  (await c.query<T>(sql)).rows[0]!;
const ALL = async <T extends Record<string, unknown>>(c: pg.Client, sql: string): Promise<T[]> =>
  (await c.query<T>(sql)).rows;

async function main(): Promise<number> {
  const env = readEnvFile('.env.migrator');
  if (!env) {
    console.error('No existe apps/api/.env.migrator');
    return 1;
  }
  if (
    (env.DB_HOST ?? '127.0.0.1') !== '127.0.0.1' ||
    Number(env.DB_PORT ?? 5432) !== 5432 ||
    (env.DB_NAME ?? 'eta15_dev') !== 'eta15_dev'
  ) {
    console.error('Destino no permitido: solo 127.0.0.1:5432 / eta15_dev');
    return 1;
  }
  try {
    await checkOwnerConnection(env);
  } catch (error) {
    console.error(`Identidad no valida: ${safeError(error)}`);
    return 1;
  }
  const c = new pg.Client({
    host: '127.0.0.1',
    port: 5432,
    database: 'eta15_dev',
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
    application_name: 'eta15-db-state',
  });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const local = readMigrationFiles({ migrationsFolder: join(API_DIR, 'drizzle') });
    const applied = await ALL<{ hash: string; created_at: string }>(
      c,
      `SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    const prefixMatches = applied.every((a, i) => local[i]?.hash === a.hash);
    const count = async (table: string) => {
      const r = await ONE<{ n: string | null }>(
        c,
        `SELECT CASE WHEN to_regclass('public.${table}') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.${table}', false, true, '')))[1]::text END AS n`,
      );
      return r.n === null ? null : Number(r.n);
    };
    const tables = (
      await ALL<{ relname: string }>(
        c,
        `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`,
      )
    ).map((t) => t.relname);
    const report = {
      server: await ONE(
        c,
        `SELECT current_setting('server_version') AS version, current_user AS "user", current_database() AS db,
                inet_server_port() AS port, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
                has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_db,
                pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) AS db_owner`,
      ),
      migrations: {
        applied: applied.length,
        local: local.length,
        appliedAreAPrefixOfLocal: prefixMatches,
        pendingLocal: local.length - applied.length,
      },
      tables: { count: tables.length, names: tables },
      schemas: (
        await ALL<{ nspname: string }>(
          c,
          `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`,
        )
      ).map((s) => s.nspname),
      extensions: await ALL(
        c,
        `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema FROM pg_extension e
           JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1`,
      ),
      btreeGistAvailable: await ONE(
        c,
        `SELECT bool_or(true) AS available, bool_or(trusted) AS trusted, max(version) AS version
           FROM pg_available_extension_versions WHERE name = 'btree_gist'`,
      ),
      counts: {
        users: await count('users'),
        sessions: await count('sessions'),
        schoolYears: await count('school_years'),
        groups: await count('groups'),
        students: await count('students'),
        enrollments: await count('enrollments'),
        groupAssignments: await count('student_group_assignments'),
        prefectAssignments: await count('prefect_group_assignments'),
        // null = la tabla no existe (migracion 0010 sin aplicar)
        attendanceDays: await count('attendance_days'),
        attendanceRecords: await count('attendance_records'),
        attendanceEvents: await count('attendance_events'),
        // null = la tabla no existe (migracion 0011 sin aplicar: prototipo de autenticacion movil, solo sandbox)
        mobileDeviceRequests: await count('mobile_device_requests'),
        mobileDevices: await count('mobile_devices'),
        mobileSessions: await count('mobile_sessions'),
        mobileProofJtis: await count('mobile_proof_jtis'),
        mobileNonces: await count('mobile_nonces'),
        permissions: await count('permissions'),
        rolePermissions: await count('role_permissions'),
        auditEvents: await count('audit_events'),
      },
      publicTriggers: (
        await ONE<{ n: number }>(
          c,
          `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal`,
        )
      ).n,
      publicFunctions: (
        await ONE<{ n: number }>(
          c,
          `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace`,
        )
      ).n,
      rolePermissionMatrix: (
        await ALL<{ k: string }>(
          c,
          `SELECT r.key || '|' || p.key || '|' || rp.scope AS k FROM role_permissions rp
             JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id ORDER BY 1`,
        )
      ).map((x) => x.k),
      studentsRbac: (
        await ALL<{ k: string }>(
          c,
          `SELECT r.key || '|' || p.key || '|' || rp.scope AS k FROM role_permissions rp
             JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE p.key LIKE 'students:%' OR p.key LIKE 'enrollments:%' ORDER BY 1`,
        )
      ).map((x) => x.k),
      apiRole: await ONE(
        c,
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin,
                pg_has_role('eta15_api', 'eta15_app', 'MEMBER') AS member_of_owner,
                has_schema_privilege('eta15_api', 'public', 'CREATE') AS create_in_public,
                (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
           FROM pg_roles r WHERE rolname = 'eta15_api'`,
      ),
      // Privilegios efectivos de columna de eta15_api sobre las tablas de alumnos (solo conteos por tipo).
      apiStudentPrivileges: await ALL(
        c,
        `SELECT c.relname AS tabla,
                count(*) FILTER (WHERE has_column_privilege('eta15_api', c.oid, a.attnum, 'SELECT'))::int AS select_cols,
                count(*) FILTER (WHERE has_column_privilege('eta15_api', c.oid, a.attnum, 'INSERT'))::int AS insert_cols,
                count(*) FILTER (WHERE has_column_privilege('eta15_api', c.oid, a.attnum, 'UPDATE'))::int AS update_cols,
                bool_or(has_table_privilege('eta15_api', c.oid, 'DELETE')) AS can_delete,
                bool_or(has_table_privilege('eta15_api', c.oid, 'TRUNCATE')) AS can_truncate,
                bool_or(has_table_privilege('eta15_api', c.oid, 'TRIGGER')) AS can_trigger,
                bool_or(has_table_privilege('eta15_api', c.oid, 'REFERENCES')) AS can_references
           FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname IN ('students', 'enrollments', 'student_group_assignments', 'prefect_group_assignments',
                              'attendance_days', 'attendance_records', 'attendance_events',
                              'mobile_device_requests', 'mobile_devices', 'mobile_sessions',
                              'mobile_proof_jtis', 'mobile_nonces')
          GROUP BY c.relname ORDER BY 1`,
      ),
    };
    console.log(JSON.stringify(report, null, 2));
    await c.query('ROLLBACK');
    return 0;
  } catch (error) {
    console.error(`FALLO: ${safeError(error)}`);
    return 1;
  } finally {
    await c.end();
  }
}

process.exit(await main());
