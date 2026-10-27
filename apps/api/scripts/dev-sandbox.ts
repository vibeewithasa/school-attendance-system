/**
 * ENTORNO AISLADO DE PRUEBAS (pnpm dev:sandbox): un clúster PostgreSQL 18 DESECHABLE en una carpeta temporal y un puerto
 * propio (no toca el servicio de Windows, eta15_dev, beauty_pos ni postgres), con el esquema real, cuentas FICTICIAS y la API
 * escuchando en http://127.0.0.1:3000 con MFA diferido (solo desarrollo local). Sirve para probar el formulario de login de
 * apps/web-admin (pnpm dev:web) sin crear usuarios en eta15_dev. Al pulsar Ctrl+C todo se destruye.
 *
 * Las contrasenas de las cuentas ficticias se generan al azar en CADA arranque y se muestran solo en esta terminal; no existen
 * contrasenas predeterminadas ni se guardan en ningun archivo.
 */
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { BOOTSTRAP_PROCEDURES, bootstrapFirstAuthority } from '../src/modules/auth/bootstrap.js';
import { createPasswordService } from '../src/modules/auth/password.js';
import { createPgSessionStore } from '../src/modules/auth/session-store-pg.js';
import { startApiCluster } from '../test/helpers/api-cluster.js';

const newPassword = () => `Sbx-${randomBytes(12).toString('base64url')}`;

async function main(): Promise<void> {
  console.log('Iniciando el entorno aislado (clúster PostgreSQL desechable)…');
  // --catalog-write aplica la PROPUESTA de privilegios 0002 (escritura del catalogo) SOLO en este clúster desechable; en
  // eta15_dev no se aplica sin autorizacion. Sin la opcion, las escrituras del catalogo responden 503 como en eta15_dev.
  const catalogWrite = process.argv.includes('--catalog-write');
  // --students-write aplica la propuesta 0003 (alumnos, matriculas, historial de grupo), tambien solo en este clúster.
  const studentsWrite = process.argv.includes('--students-write');
  // --prefect-write aplica la propuesta 0004 (asignaciones de grupos a prefectura), tambien solo en este clúster.
  const prefectWrite = process.argv.includes('--prefect-write');
  // --attendance-write aplica la propuesta 0005 (asistencia diaria), tambien solo en este clúster.
  const attendanceWrite = process.argv.includes('--attendance-write');
  // --seed-attendance siembra datos FICTICIOS para probar la asistencia (ciclo, grupos, alumnos y asignaciones de prefectura).
  const seedAttendance = process.argv.includes('--seed-attendance');
  // --school-today=AAAA-MM-DD fija el "hoy" escolar de la asistencia SOLO en este entorno (p. ej. un sabado para probar el rechazo).
  const schoolTodayArg = process.argv.find((a) => a.startsWith('--school-today='))?.slice(15);
  if (schoolTodayArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(schoolTodayArg))
    throw new Error('--school-today debe tener el formato AAAA-MM-DD');
  if (seedAttendance && !(catalogWrite && studentsWrite && prefectWrite && attendanceWrite))
    throw new Error(
      '--seed-attendance requiere --catalog-write --students-write --prefect-write --attendance-write',
    );
  const cluster = await startApiCluster(10, {
    catalogWrite,
    studentsWrite,
    prefectWrite,
    attendanceWrite,
  });
  // Aislamiento: el clúster desechable usa un puerto propio; jamas el del servicio de PostgreSQL de Windows (5432).
  if (cluster.pgt.port === 5432) {
    await cluster.stop();
    throw new Error('El entorno aislado no puede usar el puerto 5432');
  }
  const passwords = createPasswordService();
  const accounts: Array<{ rol: string; correo: string; contrasena: string }> = [];

  const bootstrap = async (domain: 'technical' | 'school', email: string, name: string) => {
    const password = newPassword();
    await bootstrapFirstAuthority(
      { domain, email, displayName: name, acta: 'ACTA-ENTORNO-AISLADO' },
      {
        client: cluster.owner,
        passwords,
        readPassword: async () => password,
        // Solo en este entorno desechable se simula la aprobacion del procedimiento escolar.
        procedures: {
          ...BOOTSTRAP_PROCEDURES,
          school: { ...BOOTSTRAP_PROCEDURES.school, approved: true },
        },
      },
    );
    return password;
  };
  const tecnicoPw = await bootstrap(
    'technical',
    'tecnico.ficticio@escuela.test',
    'Persona técnica ficticia',
  );
  const direccionPw = await bootstrap(
    'school',
    'direccion.ficticia@escuela.test',
    'Dirección ficticia',
  );
  accounts.push(
    { rol: 'admin_tecnico', correo: 'tecnico.ficticio@escuela.test', contrasena: tecnicoPw },
    { rol: 'direccion', correo: 'direccion.ficticia@escuela.test', contrasena: direccionPw },
  );

  // Control dual: quien crea una cuenta no aprueba su activacion, asi que el entorno trae DOS autoridades escolares ficticias
  // (la segunda se prepara con una fixture aislada; en una instalacion real la incorpora el procedimiento excepcional con acta).
  const direccion2Pw = newPassword();
  const d2 = await cluster.owner.query<{ id: string }>(
    `INSERT INTO users (email, display_name, account_domain, status, password_hash)
     VALUES ('direccion.dos.ficticia@escuela.test', 'Dirección dos ficticia', 'school', 'active', $1) RETURNING id`,
    [await passwords.hash(direccion2Pw)],
  );
  await cluster.owner.query(
    `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source)
     SELECT $1, r.id, r.domain, d.id, 'grant' FROM roles r, users d WHERE r.key = 'direccion' AND d.email = 'direccion.ficticia@escuela.test'`,
    [d2.rows[0]!.id],
  );
  accounts.push({
    rol: 'direccion (2.ª)',
    correo: 'direccion.dos.ficticia@escuela.test',
    contrasena: direccion2Pw,
  });

  // Dos prefectas ficticias para probar el alcance por grupo y la cobertura compartida (las asignaciones las crea Direccion).
  for (const [correo, nombre] of [
    ['prefectura.ficticia@escuela.test', 'Prefectura ficticia'],
    ['prefectura.dos.ficticia@escuela.test', 'Prefectura dos ficticia'],
  ] as const) {
    const prefPw = newPassword();
    const pref = await cluster.owner.query<{ id: string }>(
      `INSERT INTO users (email, display_name, account_domain, status, password_hash)
       VALUES ($1, $2, 'school', 'active', $3) RETURNING id`,
      [correo, nombre, await passwords.hash(prefPw)],
    );
    await cluster.owner.query(
      `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source)
       SELECT $1, r.id, r.domain, d.id, 'grant' FROM roles r, users d WHERE r.key = 'prefectura' AND d.email = 'direccion.ficticia@escuela.test'`,
      [pref.rows[0]!.id],
    );
    accounts.push({ rol: 'prefectura', correo, contrasena: prefPw });
  }

  if (seedAttendance) {
    // Datos FICTICIOS solo de este clúster desechable: un ciclo, dos grupos con alumnos inventados y asignaciones de prefectura
    // "antiguas" (la API no permite retroceder una asignacion; aqui se siembran como propietario con el trigger de alta
    // desactivado un instante). Prefectura 1: grupo A; prefectura 2: grupos A (cobertura compartida) y B.
    const q = (sql: string, params: unknown[] = []) => cluster.owner.query(sql, params);
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const year = (
      await q(
        `INSERT INTO school_years (name, starts_on, ends_on) VALUES ('Ciclo ficticio de asistencia', $1, $2) RETURNING id`,
        [day(-120), day(240)],
      )
    ).rows[0].id as string;
    const group = async (code: string) =>
      (
        await q(
          `INSERT INTO groups (school_year_id, grade, code) VALUES ($1, 1, $2) RETURNING id`,
          [year, code],
        )
      ).rows[0].id as string;
    const gA = await group('A');
    const gB = await group('B');
    const GIVEN = ['Ana', 'Beto', 'Carla', 'Diego', 'Elena', 'Fabi', 'Gael'];
    const FAMILY = ['Ficticia Uno', 'Ficticia Dos', 'Ficticia Tres', 'Ficticia Cuatro'];
    let k = 0;
    const pupil = async (g: string) => {
      const st = (
        await q(`INSERT INTO students (given_names, family_name) VALUES ($1, $2) RETURNING id`, [
          GIVEN[k % GIVEN.length],
          FAMILY[k % FAMILY.length],
        ])
      ).rows[0].id as string;
      k += 1;
      const en = (
        await q(
          `INSERT INTO enrollments (student_id, school_year_id, starts_on) VALUES ($1, $2, $3) RETURNING id`,
          [st, year, day(-100)],
        )
      ).rows[0].id as string;
      await q(
        `INSERT INTO student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) VALUES ($1, $2, $3, $4)`,
        [en, year, g, day(-100)],
      );
    };
    for (let i = 0; i < 5; i += 1) await pupil(gA);
    for (let i = 0; i < 4; i += 1) await pupil(gB);
    const boss = (await q(`SELECT id FROM users WHERE email = 'direccion.ficticia@escuela.test'`))
      .rows[0].id as string;
    const assign = async (email: string, g: string) => {
      await q(`ALTER TABLE prefect_group_assignments DISABLE TRIGGER pga_guard_insert`);
      try {
        await q(
          `INSERT INTO prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by)
           SELECT u.id, $2, $3, $4, $5 FROM users u WHERE u.email = $1`,
          [email, year, g, day(-110), boss],
        );
      } finally {
        await q(`ALTER TABLE prefect_group_assignments ENABLE TRIGGER pga_guard_insert`);
      }
    };
    await assign('prefectura.ficticia@escuela.test', gA);
    await assign('prefectura.dos.ficticia@escuela.test', gA);
    await assign('prefectura.dos.ficticia@escuela.test', gB);
    console.log(
      'Datos ficticios de asistencia sembrados: ciclo, grupos 1.º A (5 alumnos) y 1.º B (4 alumnos).',
    );
  }

  const env = loadEnv({
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGIN: 'http://127.0.0.1:5173',
    AUTH_MFA_ENFORCEMENT: 'deferred',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(cluster.pgt.port),
    DB_NAME: 'eta15_dev',
    DB_USER: 'eta15_api',
  });
  const app = await buildApp(env, {
    auth: {
      store: createPgSessionStore(cluster.pool),
      passwords,
      ...(schoolTodayArg ? { schoolToday: () => schoolTodayArg } : {}),
    },
  });
  if (schoolTodayArg)
    console.log(
      `AVISO: el "hoy" escolar de la asistencia esta fijado a ${schoolTodayArg} (solo este entorno desechable).`,
    );
  await app.listen({ host: env.HOST, port: env.PORT });

  console.log(
    '\nEntorno listo. API: http://127.0.0.1:3000   (abre el portal con  pnpm dev:web  en http://127.0.0.1:5173)',
  );
  console.log('Cuentas FICTICIAS de este arranque (se destruyen al salir):\n');
  // Las contrasenas son ficticias y solo viven en este arranque; aun asi no se escriben en salidas redirigidas a archivos:
  // solo se muestran en una terminal interactiva o si se pide expresamente con --show-credentials.
  if (process.stdout.isTTY || process.argv.includes('--show-credentials')) console.table(accounts);
  else
    console.log(
      '(credenciales omitidas: la salida no es una terminal; use --show-credentials para mostrarlas)',
    );
  console.log('Pulsa Ctrl+C para detener y destruir el entorno.');

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log('\nDeteniendo…');
    await app.close().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

await main();
