/**
 * PILA PARA EL E2E WEB (apps/web-admin/e2e): un clúster PostgreSQL 18 DESECHABLE (carpeta temporal y puerto propio; no toca el
 * servicio de Windows ni eta15_dev), el esquema real con TODAS las migraciones y las propuestas de privilegios 0002 a 0005 y 0007
 * aplicadas SOLO en ese clúster, la API real escuchando en http://127.0.0.1:3000 y datos 100 % FICTICIOS y deterministas.
 *
 * Lo lanza Playwright (e2e/stack.ts) con dos variables de entorno que existen solo en ese proceso y nunca se escriben en un archivo:
 *   E2E_PASSWORD      contrasena (>= 20 caracteres) de TODAS las cuentas ficticias de esta ejecucion (se genera al azar por corrida).
 *   E2E_STATE_FILE    ruta (fuera del repositorio) donde se escribe, al estar listo, un JSON SIN secretos (puerto del clúster y fechas).
 * No hay mocks: el navegador habla con esta API (cookies de sesion, CSRF y Origin reales). El MFA queda DIFERIDO como en
 * `pnpm dev:sandbox` (la API lo rechaza fuera de loopback o con NODE_ENV=production); esa excepcion no autoriza datos reales.
 * Al recibir SIGINT/SIGTERM destruye el clúster. Nunca imprime contrasenas ni cookies.
 */
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { BOOTSTRAP_PROCEDURES, bootstrapFirstAuthority } from '../src/modules/auth/bootstrap.js';
import { DEV_COOKIE_NAME } from '../src/modules/auth/guards.js';
import { createPasswordService } from '../src/modules/auth/password.js';
import { createPgSessionStore } from '../src/modules/auth/session-store-pg.js';
import { startApiCluster } from '../test/helpers/api-cluster.js';

const password = process.env.E2E_PASSWORD;
const stateFile = process.env.E2E_STATE_FILE;
if (!password || password.length < 20)
  throw new Error('E2E_PASSWORD debe tener al menos 20 caracteres');
if (!stateFile) throw new Error('Falta E2E_STATE_FILE');
// Estrechados a string para las funciones internas.
const PASSWORD: string = password;
const STATE_FILE: string = stateFile;

const ORIGIN = 'http://127.0.0.1:5173';
const TZ = 'America/Mazatlan';
const todayReal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isWeekday = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};

export const E2E_ACCOUNTS = {
  tecnico: 'tecnico.e2e@escuela.test',
  direccion: 'direccion.e2e@escuela.test',
  prefecturaA: 'prefectura.a.e2e@escuela.test',
  prefecturaB: 'prefectura.b.e2e@escuela.test',
  trabajoSocial: 'trabajo.social.e2e@escuela.test',
  inactiva: 'prefectura.inactiva.e2e@escuela.test',
} as const;

async function main(): Promise<void> {
  const cluster = await startApiCluster(10, {
    catalogWrite: true,
    studentsWrite: true,
    prefectWrite: true,
    attendanceWrite: true,
    justificationsWrite: true,
  });
  if (cluster.pgt.port === 5432) {
    await cluster.stop();
    throw new Error('El E2E no puede usar el puerto 5432');
  }
  const passwords = createPasswordService();
  const q = (sql: string, params: unknown[] = []) => cluster.owner.query(sql, params);

  const bootstrap = (domain: 'technical' | 'school', email: string, name: string) =>
    bootstrapFirstAuthority(
      { domain, email, displayName: name, acta: 'ACTA-E2E-DESECHABLE' },
      {
        client: cluster.owner,
        passwords,
        readPassword: async () => PASSWORD,
        // Solo en este entorno desechable se simula la aprobacion del procedimiento escolar.
        procedures: {
          ...BOOTSTRAP_PROCEDURES,
          school: { ...BOOTSTRAP_PROCEDURES.school, approved: true },
        },
      },
    );
  await bootstrap('technical', E2E_ACCOUNTS.tecnico, 'Persona técnica E2E');
  await bootstrap('school', E2E_ACCOUNTS.direccion, 'Dirección E2E');

  const hash = await passwords.hash(PASSWORD);
  const account = async (email: string, name: string, role: string, status = 'active') => {
    const u = await q(
      `INSERT INTO users (email, display_name, account_domain, status, password_hash)
       VALUES ($1, $2, 'school', 'active', $3) RETURNING id`,
      [email, name, hash],
    );
    await q(
      `INSERT INTO user_roles (user_id, role_id, domain, granted_by, grant_source)
       SELECT $1, r.id, r.domain, d.id, 'grant' FROM roles r, users d WHERE r.key = $2 AND d.email = $3`,
      [u.rows[0].id, role, E2E_ACCOUNTS.direccion],
    );
    // La cuenta INACTIVA se crea activa (la base no concede roles a cuentas deshabilitadas) y se deshabilita despues.
    if (status !== 'active')
      await q(`UPDATE users SET status = $2 WHERE id = $1`, [u.rows[0].id, status]);
    return u.rows[0].id as string;
  };
  const prefA = await account(E2E_ACCOUNTS.prefecturaA, 'Prefectura A E2E', 'prefectura');
  const prefB = await account(E2E_ACCOUNTS.prefecturaB, 'Prefectura B E2E', 'prefectura');
  await account(E2E_ACCOUNTS.trabajoSocial, 'Trabajo social E2E', 'trabajo_social');
  await account(E2E_ACCOUNTS.inactiva, 'Prefectura inactiva E2E', 'prefectura', 'disabled');

  // ---------------------------------------------------------------- datos escolares ficticios y deterministas
  const today = todayReal();
  const year = (
    await q(
      `INSERT INTO school_years (name, starts_on, ends_on) VALUES ('Ciclo E2E ficticio', $1, $2) RETURNING id`,
      [addDays(today, -80), addDays(today, 200)],
    )
  ).rows[0].id as string;
  const group = async (code: string) =>
    (
      await q(`INSERT INTO groups (school_year_id, grade, code) VALUES ($1, 1, $2) RETURNING id`, [
        year,
        code,
      ])
    ).rows[0].id as string;
  const gA = await group('A');
  const gB = await group('B');
  const pupil = async (g: string, given: string, family: string) => {
    const st = (
      await q(`INSERT INTO students (given_names, family_name) VALUES ($1, $2) RETURNING id`, [
        given,
        family,
      ])
    ).rows[0].id as string;
    const en = (
      await q(
        `INSERT INTO enrollments (student_id, school_year_id, starts_on) VALUES ($1, $2, $3) RETURNING id`,
        [st, year, addDays(today, -60)],
      )
    ).rows[0].id as string;
    await q(
      `INSERT INTO student_group_assignments (enrollment_id, school_year_id, group_id, starts_on) VALUES ($1, $2, $3, $4)`,
      [en, year, g, addDays(today, -60)],
    );
    return st;
  };
  const ana = await pupil(gA, 'Ana', 'Alfa Ficticia');
  const beto = await pupil(gA, 'Beto', 'Beta Ficticio');
  const carla = await pupil(gA, 'Carla', 'Gamma Ficticia');
  const diego = await pupil(gA, 'Diego', 'Delta Ficticio');
  const elena = await pupil(gA, 'Elena', 'Épsilon Ficticia');
  const fabi = await pupil(gB, 'Fabi', 'Foxtrot Ficticia');
  const gael = await pupil(gB, 'Gael', 'Golf Ficticio');
  const assign = async (user: string, g: string) => {
    await q(`ALTER TABLE prefect_group_assignments DISABLE TRIGGER pga_guard_insert`);
    try {
      await q(
        `INSERT INTO prefect_group_assignments (user_id, school_year_id, group_id, starts_on, created_by)
         SELECT $1, $2, $3, $4, d.id FROM users d WHERE d.email = $5`,
        [user, year, g, addDays(today, -70), E2E_ACCOUNTS.direccion],
      );
    } finally {
      await q(`ALTER TABLE prefect_group_assignments ENABLE TRIGGER pga_guard_insert`);
    }
  };
  await assign(prefA, gA);
  await assign(prefB, gB);

  // ---------------------------------------------------------------- la API real (reloj escolar mutable SOLO durante la siembra)
  const env = loadEnv({
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGIN: ORIGIN,
    AUTH_MFA_ENFORCEMENT: 'deferred',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(cluster.pgt.port),
    DB_NAME: 'eta15_dev',
    DB_USER: 'eta15_api',
  });
  const clock: { seed: string | null } = { seed: null };
  const app = await buildApp(env, {
    auth: {
      store: createPgSessionStore(cluster.pool),
      passwords,
      schoolToday: () => clock.seed ?? todayReal(),
    },
  });
  await app.ready();

  // Dias habiles anteriores a hoy (w1 el mas antiguo ... w5 el mas reciente).
  const weekdays: string[] = [];
  for (let d = addDays(today, -1); weekdays.length < 5; d = addDays(d, -1))
    if (isWeekday(d)) weekdays.unshift(d);

  const session = async (email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: { email, password: PASSWORD },
    });
    if (res.statusCode !== 200) throw new Error(`login de siembra fallido (${res.statusCode})`);
    const cookie = `${DEV_COOKIE_NAME}=${res.cookies.find((c) => c.name === DEV_COOKIE_NAME)!.value}`;
    const csrf = (
      await app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } })
    ).json().csrfToken as string;
    return { cookie, csrf };
  };
  const post = async (s: { cookie: string; csrf: string }, url: string, body: unknown) => {
    const r = await app.inject({
      method: 'POST',
      url,
      payload: body as object,
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        cookie: s.cookie,
        'x-csrf-token': s.csrf,
      },
    });
    if (r.statusCode >= 300) throw new Error(`siembra ${url} fallo (${r.statusCode})`);
    return r.json();
  };
  let rq = 0;
  const rid = () => `00000000-0000-4000-8000-${String(500000000000 + ++rq).slice(-12)}`;
  /** Abre la lista del grupo en esa fecha (reloj de siembra), guarda las marcas dadas y, si se pide, la finaliza. */
  const list = async (
    who: { cookie: string; csrf: string },
    g: string,
    date: string,
    marks: Record<string, 'present' | 'absent'>,
    finalize: boolean,
  ) => {
    clock.seed = date;
    try {
      const opened = await post(who, '/school/attendance/days', { groupId: g });
      let day = opened.day;
      day = (
        await post(who, `/school/attendance/days/${day.id}/marks`, {
          expectedRevision: day.revision,
          requestId: rid(),
          marks: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })),
        })
      ).day;
      if (finalize)
        await post(who, `/school/attendance/days/${day.id}/finalize`, {
          expectedRevision: day.revision,
        });
    } finally {
      clock.seed = null;
    }
  };
  const sA = await session(E2E_ACCOUNTS.prefecturaA);
  const sB = await session(E2E_ACCOUNTS.prefecturaB);
  const [w1, w2, , w4, w5] = weekdays as [string, string, string, string, string];
  type M = 'present' | 'absent';
  const marks = (a: M, b: M, c: M, d: M, e: M) => ({
    [ana]: a,
    [beto]: b,
    [carla]: c,
    [diego]: d,
    [elena]: e,
  });
  await list(sA, gA, w1, marks('absent', 'present', 'present', 'absent', 'present'), true);
  await list(sA, gA, w2, marks('absent', 'present', 'present', 'absent', 'present'), true);
  // w3: SIN lista a proposito
  await list(sA, gA, w4, marks('absent', 'absent', 'present', 'present', 'present'), true);
  // w5: BORRADOR con Carla sin marcar (pendiente)
  await list(
    sA,
    gA,
    w5,
    { [ana]: 'present', [beto]: 'present', [diego]: 'absent', [elena]: 'present' },
    false,
  );
  await list(sB, gB, w4, { [fabi]: 'absent', [gael]: 'present' }, true);

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      dbPort: cluster.pgt.port,
      today,
      weekdays,
      year,
      groups: { A: gA, B: gB },
      students: { ana, beto, carla, diego, elena, fabi, gael },
      accounts: E2E_ACCOUNTS,
    }),
    'utf8',
  );
  await app.listen({ host: env.HOST, port: env.PORT });
  console.log('E2E_STACK_READY');

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

await main();
