import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import { db, loginAs, logout, password, state } from './support';

/**
 * E2E REAL — estados de pantalla, navegacion, accesibilidad basica y controles de seguridad HTTP reales (autenticacion, CSRF, Origin,
 * cookies, no-store). Donde se inyecta una averia de red se indica expresamente: NO es un fallo real de PostgreSQL ni de la API.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});
const ORIGIN = 'http://127.0.0.1:5173';

async function followup(page: Page, group: string, from: string, to: string) {
  await page.goto('/asistencia/reportes/seguimiento');
  await expect(page.getByLabel('Grupo', { exact: true }).locator('option')).not.toHaveCount(1);
  await page.getByLabel('Grupo', { exact: true }).selectOption(group);
  await page.getByLabel('Desde', { exact: true }).fill(from);
  await page.getByLabel('Hasta', { exact: true }).fill(to);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
}

test('lista inexistente, borrador y finalizada, y datos incompletos (grupo A, semana completa)', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await followup(page, s.groups.A, s.weekdays[0], s.weekdays[4]);
  const status = page.getByRole('group', { name: 'Estado de los datos del periodo' });
  await expect(status).toContainText('Datos incompletos');
  await expect(status).toContainText('1 día hábil sin lista (no determinado, no es ausencia)');
  await expect(status).toContainText('1 lista en borrador');
  // Carla tiene un renglon SIN MARCA en el borrador: no es ausencia
  const carla = page
    .getByRole('table')
    .getByRole('row')
    .filter({ hasText: 'Gamma Ficticia Carla' });
  const cells = await carla.getByRole('cell').allTextContents();
  expect(cells.slice(0, 3)).toEqual(['0', '3', '1']); // ausencias, presentes, sin marca
  await expect(carla).toContainText('1 registro sin marca');
  // reporte por grupo: las tres situaciones de lista conviven y se distinguen
  await page.goto('/asistencia/reportes/grupo');
  await page.getByLabel('Grupo', { exact: true }).selectOption(s.groups.A);
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  const days = page.getByRole('table', { name: /Listas de asistencia del grupo por día hábil/ });
  await expect(days.getByText('Sin lista', { exact: true })).toHaveCount(1);
  await expect(days.getByText('Borrador', { exact: true })).toHaveCount(1);
  await expect(days.getByText('Finalizada', { exact: true })).toHaveCount(3);
  await logout(page);
});

test('sin resultados (grupo B sin listas esos dias), cambio de fechas, de grupo y de ciclo', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await followup(page, s.groups.B, s.weekdays[0], s.weekdays[2]);
  await expect(page.getByText(/no hay marcas que contar/).first()).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Estado de los datos del periodo' })).toContainText(
    'No hay listas en el periodo',
  );
  // cambio de fechas: aparece la lista de B del dia w4 y se descarta el resultado anterior al cambiar el filtro
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[3]);
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3); // encabezado + Fabi + Gael
  // cambio de grupo
  await page.getByLabel('Grupo', { exact: true }).selectOption(s.groups.A);
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).toHaveCount(0);
  // cambio de ciclo: restablece grupo y periodo
  await page.getByLabel('Ciclo escolar', { exact: true }).selectOption(s.year);
  await expect(page.getByLabel('Grupo', { exact: true })).toHaveValue('');
  await logout(page);
});

test('404 real: una lista inexistente muestra un mensaje generico; el periodo invalido se avisa de forma accesible', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/asistencia/00000000-0000-4000-8000-0000000000aa');
  await expect(page.getByRole('alert')).toContainText(/No se encontró la lista/);
  await page.goto('/asistencia/reportes/seguimiento');
  await expect(page.getByLabel('Grupo', { exact: true }).locator('option')).not.toHaveCount(1);
  await page.getByLabel('Grupo', { exact: true }).selectOption(s.groups.A);
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[4]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[0]);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'inicio del periodo no puede ser posterior' });
  await expect(alert).toBeVisible();
  await expect(page.getByLabel('Desde', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Desde', { exact: true })).toHaveAttribute('aria-describedby', /.+/);
  await logout(page);
});

test('error recuperable: averia de red INYECTADA por la prueba (no es un fallo real de la API ni de PostgreSQL) y recuperacion', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  let injected = 0;
  await page.route('**/api/school/attendance/reports/group*', (route) => {
    injected += 1;
    return route.abort('connectionfailed'); // INYECTADO: solo la primera consulta
  });
  await followup(page, s.groups.A, s.weekdays[0], s.weekdays[4]);
  await expect(page.getByRole('alert')).toContainText('No se pudo conectar con el servidor');
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(injected).toBe(1);
  await page.unroute('**/api/school/attendance/reports/group*'); // la red "vuelve": la API real responde
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await logout(page);
});

test('accesibilidad basica: etiquetas, teclado (Enter envia el formulario), foco, tablas legibles y mensajes de error', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/asistencia/reportes/seguimiento');
  await expect(page.getByLabel('Grupo', { exact: true }).locator('option')).not.toHaveCount(1);
  // todos los controles tienen etiqueta accesible
  for (const name of ['Ciclo escolar', 'Grupo', 'Desde', 'Hasta'])
    await expect(page.getByLabel(name, { exact: true })).toBeVisible();
  // solo teclado: elegir el grupo con el teclado y enviar con Enter desde un campo de fecha
  await page.getByLabel('Grupo', { exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('Grupo', { exact: true })).toHaveValue(s.groups.A);
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByLabel('Hasta', { exact: true }).press('Enter');
  const region = page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' });
  await expect(region).toBeVisible();
  // tabla legible: titulo (caption), encabezados de columna y de fila
  await expect(page.locator('table caption').first()).toHaveCount(1);
  expect(await page.locator('table thead th[scope=col]').count()).toBeGreaterThanOrEqual(6);
  expect(await page.locator('table tbody th[scope=row]').count()).toBe(5);
  // el cuadro "Ordenar por" se opera con teclado y reordena
  await page.getByLabel('Ordenar por', { exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('Ordenar por', { exact: true })).toHaveValue('absences_asc');
  // el aviso obligatorio es una nota visible; el enlace de salto existe
  await expect(page.getByRole('note').first()).toContainText('ausencias registradas');
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toHaveCount(1);
  await logout(page);
  // error de acceso con mensaje anunciado (role=alert), sin revelar si existe la cuenta
  await page.getByLabel('Correo electrónico').fill(s.accounts.direccion);
  await page.getByLabel('Contraseña', { exact: true }).fill('contrasena-incorrecta-0000');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(/no existe|inexistente|bloquead/i);
});

test('seguridad HTTP real: sin sesion 401, CSRF y Origin obligatorios, cookie HttpOnly y SameSite=Strict, no-store', async ({
  page,
  baseURL,
}) => {
  // endpoints escolares NO publicos
  const anon = await pwRequest.newContext({ baseURL });
  for (const path of [
    '/api/school/attendance/today',
    '/api/school/attendance/reports/options',
    `/api/school/attendance/reports/group?groupId=${s.groups.A}&from=${s.weekdays[0]}&to=${s.weekdays[4]}`,
    '/api/school/students',
    '/api/school/justifications/receipts',
    '/api/school/justifications/students?q=Ana',
    '/api/admin/users',
  ]) {
    const r = await anon.get(path);
    expect(r.status(), path).toBe(401);
    expect(await r.text(), path).not.toMatch(/Alfa|Ficticia|Foxtrot/);
  }
  expect((await anon.get('/api/health')).status()).toBe(200); // solo "el proceso responde": ningun dato escolar

  // cookie de sesion: HttpOnly + SameSite=Strict (en desarrollo no es Secure ni __Host-: lo exige solo produccion)
  const login = await anon.post('/api/auth/login', {
    headers: { origin: ORIGIN },
    data: { email: s.accounts.direccion, password: password() },
  });
  expect(login.status()).toBe(200);
  const setCookie = login
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value)
    .join('\n');
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(await login.text()).not.toMatch(/"token"|sessionToken/i); // el token nunca va en el JSON
  await anon.dispose();

  // con sesion real del navegador: no-store, CSRF y Origin
  await loginAs(page, s.accounts.direccion);
  const read = await page.request.get('/api/school/attendance/reports/options');
  expect(read.status()).toBe(200);
  expect(read.headers()['cache-control']).toContain('no-store');
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrfToken as string;
  const body = {
    requestId: '00000000-0000-4000-8000-0000000000a1',
    studentId: s.students.ana,
    schoolDate: s.weekdays[0],
  };
  const before = await db(
    async (q) => (await q(`select count(*)::int n from attendance_days`)).rows[0]!.n as number,
  );
  // Direccion no captura ni registra recepciones: aun con CSRF y Origin validos el servidor niega (403) por permiso
  expect(
    (
      await page.request.post('/api/school/justifications/receipts', {
        headers: { origin: ORIGIN, 'x-csrf-token': csrf },
        data: body,
      })
    ).status(),
  ).toBe(403);
  // sin CSRF y con Origin ajeno: el servidor rechaza antes de autorizar
  const noCsrf = await page.request.post('/api/school/attendance/days', {
    headers: { origin: ORIGIN },
    data: { groupId: s.groups.A },
  });
  expect(noCsrf.status()).toBe(403);
  const evil = await page.request.post('/api/school/attendance/days', {
    headers: { origin: 'http://evil.example', 'x-csrf-token': csrf },
    data: { groupId: s.groups.A },
  });
  expect(evil.status()).toBe(403);
  expect(
    await db(
      async (q) => (await q(`select count(*)::int n from attendance_days`)).rows[0]!.n as number,
    ),
  ).toBe(before);
  await logout(page);
});

test('administracion tecnica: sin acceso a datos escolares (menu y servidor)', async ({ page }) => {
  await loginAs(page, s.accounts.tecnico);
  const nav = page.getByRole('navigation', { name: 'Principal' });
  for (const name of ['Asistencia', 'Reportes de asistencia', 'Justificantes', 'Alumnos'])
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  for (const path of [
    '/api/school/attendance/reports/options',
    '/api/school/justifications/receipts',
    '/api/school/students',
    '/api/school/attendance/days',
  ]) {
    const r = await page.request.get(path);
    expect(r.status(), path).toBe(403);
    expect(await r.text(), path).not.toMatch(/Alfa|Ficticia|Foxtrot/);
  }
  await logout(page);
});

test('registro de la ejecucion: la base desechable solo contiene datos ficticios y ninguna contrasena en la base de pruebas ni en el estado', async () => {
  const names = await db(async (q) =>
    (await q(`select given_names || ' ' || family_name n from students order by 1`)).rows.map(
      (r) => r.n as string,
    ),
  );
  expect(names.join(' ')).toMatch(/Ficticia|Ficticio/);
  expect(names.every((n) => /Ficticio|Ficticia/.test(n))).toBe(true);
  expect(JSON.stringify(state())).not.toContain(password());
});
