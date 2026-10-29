import { expect, test } from '@playwright/test';
import { ORIGIN, isolated, loginAs, logout, send, state } from './support';

/**
 * E2E REAL — controles de acceso del portal administrativo con el navegador, la API y la sesion reales: rutas protegidas sin sesion,
 * cookie de sesion invalida o falsificada, cambio de cuenta en el mismo navegador (sin restos de la cuenta anterior), CSRF y Origin
 * en las mutaciones administrativas, y cabeceras de las respuestas. No se cambia ningun control de seguridad para facilitar la prueba.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const PROTECTED = [
  '/',
  '/personal',
  '/catalogo',
  '/alumnos',
  '/prefectura',
  '/justificantes',
  '/asistencia',
  '/asistencia/reportes/grupo',
  '/asistencia/reportes/alumno',
  '/asistencia/reportes/seguimiento',
  '/dispositivos',
];

test('1. acceso directo a cada ruta protegida sin sesion: se pide iniciar sesion y no se muestra ningun dato', async ({
  browser,
}) => {
  const { context, page } = await isolated(browser);
  try {
    for (const path of PROTECTED) {
      await page.goto(path);
      await expect(page.getByRole('button', { name: 'Iniciar sesión' }), path).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);
      const text = await page.locator('body').innerText();
      expect(text, path).not.toMatch(/Ficticia|Ficticio|escuela\.test/);
    }
    // la API tampoco responde sin sesion
    for (const api of [
      '/admin/users',
      '/catalog/school-years',
      '/school/students',
      '/school/prefect-assignments',
      '/school/justifications/receipts',
    ])
      expect((await page.request.get(`/api${api}`)).status(), api).toBe(401);
  } finally {
    await context.close();
  }
});

test('2. cookie de sesion invalida o falsificada: 401 y el portal vuelve al acceso', async ({
  browser,
}) => {
  const real = await isolated(browser);
  let cookieName: string;
  try {
    await loginAs(real.page, s.accounts.prefecturaA);
    cookieName = (await real.context.cookies()).find((c) => c.httpOnly)!.name;
    await logout(real.page);
  } finally {
    await real.context.close();
  }
  const { context, page } = await isolated(browser);
  try {
    for (const value of [
      'x'.repeat(43),
      'A'.repeat(43),
      'no-es-un-token',
      '../../etc/passwd',
      `${'a'.repeat(200)}`,
    ]) {
      await context.clearCookies();
      await context.addCookies([
        {
          name: cookieName,
          value,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
      expect((await page.request.get('/api/auth/me')).status(), value.slice(0, 12)).toBe(401);
      expect((await page.request.get('/api/school/students')).status()).toBe(401);
    }
    await page.goto('/alumnos');
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('3. cambio de cuenta en el mismo navegador: la cuenta nueva no ve nada de la anterior y la pantalla vieja no reaparece', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/personal');
  await expect(page.getByRole('list', { name: 'Cuentas' })).toContainText(
    'direccion.e2e@escuela.test',
  );
  await logout(page);
  // el boton «atras» tras cerrar sesion no vuelve a mostrar la pantalla administrativa
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('direccion.e2e@escuela.test');

  await loginAs(page, s.accounts.prefecturaA);
  await page.goto('/personal');
  await expect(page.getByRole('alert')).toContainText('No tienes permiso');
  await expect(page.locator('body')).not.toContainText('direccion.e2e@escuela.test');
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  // solo ve su grupo, no el de la cuenta anterior ni el de otra prefecta
  await page.goto('/alumnos');
  await expect(page.getByRole('list', { name: 'Alumnos' })).toContainText('Alfa Ficticia');
  await expect(page.getByRole('list', { name: 'Alumnos' })).not.toContainText('Foxtrot');
  await logout(page);
});

test('4. mutaciones administrativas: CSRF y Origin son obligatorios; la autorizacion se decide despues; respuestas no-store', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  const body = {
    email: 'csrf.e2e@escuela.test',
    displayName: 'Prueba CSRF Ficticia',
    accountDomain: 'school',
  };
  const count = () =>
    page.request
      .get('/api/admin/users?q=csrf.e2e')
      .then((r) => r.json())
      .then((j) => j.total as number);
  expect(await count()).toBe(0);
  // sin token CSRF
  expect((await send(page, 'POST', '/admin/users', body, { csrf: null })).status()).toBe(403);
  // token CSRF falso
  expect(
    (await send(page, 'POST', '/admin/users', body, { csrf: 'falso'.repeat(8) })).status(),
  ).toBe(403);
  // Origin ajeno, aun con el token correcto
  expect(
    (await send(page, 'POST', '/admin/users', body, { origin: 'http://evil.example' })).status(),
  ).toBe(403);
  expect(await count()).toBe(0);
  // con ambos correctos si se crea (la cuenta queda pendiente y nunca tiene contrasena)
  const ok = await send(page, 'POST', '/admin/users', body);
  expect(ok.status()).toBe(201);
  expect(await count()).toBe(1);
  // las respuestas administrativas y escolares no se almacenan en cache
  for (const path of [
    '/admin/users',
    '/catalog/school-years',
    '/school/students',
    '/school/prefect-assignments',
  ]) {
    const r = await page.request.get(`/api${path}`);
    expect(r.status(), path).toBe(200);
    expect(r.headers()['cache-control'], path).toMatch(/no-store/);
  }
  // la cookie de sesion es HttpOnly y SameSite=Strict
  const cookie = (await page.context().cookies()).find((c) => c.httpOnly)!;
  expect(cookie.sameSite).toBe('Strict');
  await page.goto('/personal');
  expect(await page.evaluate(() => document.cookie)).toBe(''); // ninguna cookie es legible por scripts
  expect(ORIGIN).toBe('http://127.0.0.1:5173');
  await logout(page);
});

test('5. privilegios del clúster desechable: la API usa el rol de minimo privilegio y el E2E verifica el modelo previsto', async ({
  page,
}) => {
  const { db } = await import('./support');
  // la API se conecta como eta15_api (no propietario ni privilegiado); las conexiones de verificacion de esta prueba son del propietario
  await loginAs(page, s.accounts.direccion);
  await page.goto('/personal'); // asegura una conexion reciente de la API
  const role = await db(
    async (q) =>
      (
        await q(
          `select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = 'eta15_api'`,
        )
      ).rows[0]!,
  );
  expect(role).toEqual({
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
  });
  const users = await db(async (q) =>
    (
      await q(
        `select distinct usename from pg_stat_activity where datname = current_database() and usename is not null order by 1`,
      )
    ).rows.map((r) => r.usename as string),
  );
  expect(users).toContain('eta15_api');
  const owners = await db(async (q) =>
    (await q(`select distinct tableowner from pg_tables where schemaname = 'public'`)).rows.map(
      (r) => r.tableowner as string,
    ),
  );
  expect(owners).toEqual(['eta15_app']); // ninguna tabla es de la API
  // nunca TRUNCATE, TRIGGER ni REFERENCES; DELETE solo para purgar sesiones y tokens vencidos (roles-postgresql.md); role_permissions solo se lee
  const forbidden = await db(
    async (q) =>
      (
        await q(
          `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'eta15_api' and table_schema = 'public' and (privilege_type in ('TRUNCATE','TRIGGER','REFERENCES') or (privilege_type = 'DELETE' and table_name not in ('sessions','auth_tokens')))`,
        )
      ).rows,
  );
  expect(forbidden).toEqual([]);
  const rp = await db(
    async (q) =>
      (
        await q(
          `select array_agg(privilege_type::text order by privilege_type) p from information_schema.role_table_grants where grantee = 'eta15_api' and table_name = 'role_permissions'`,
        )
      ).rows[0]!.p as string[],
  );
  expect(rp).toEqual(['SELECT']);
  // el modelo de escritura es por columna: la API NO puede cambiar columnas de identidad (users.id, users.account_domain, users.created_by)
  const can = (sql: string) => db(async (q) => (await q(sql)).rows[0]!.ok as boolean);
  for (const column of ['id', 'account_domain', 'created_by', 'created_at'])
    expect(
      await can(`select has_column_privilege('eta15_api', 'users', '${column}', 'UPDATE') ok`),
      column,
    ).toBe(false);
  expect(
    await can(`select has_column_privilege('eta15_api', 'users', 'password_hash', 'SELECT') ok`),
  ).toBe(true); // el servicio de sesiones lo necesita
  expect(
    await can(`select has_table_privilege('eta15_api', 'role_permissions', 'INSERT') ok`),
  ).toBe(false);
  // la propuesta 0006 (autenticacion movil) NO esta aplicada en este clúster: la API web no tiene privilegios sobre las tablas mobile_*
  for (const table of ['mobile_devices', 'mobile_sessions', 'mobile_device_requests'])
    expect(
      await can(
        `select has_table_privilege('eta15_api', '${table}', 'INSERT') or has_table_privilege('eta15_api', '${table}', 'SELECT') ok`,
      ),
      table,
    ).toBe(false);
  // consecuencia visible, y controlada, en la interfaz: el canal movil no esta montado (404) y la pantalla de prototipo lo explica sin romperse
  expect((await page.request.get('/api/mobile-devices')).status()).toBe(404);
  await page.goto('/dispositivos');
  await expect(page.getByText(/ENTORNO DE PRUEBAS/)).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await logout(page);
});
