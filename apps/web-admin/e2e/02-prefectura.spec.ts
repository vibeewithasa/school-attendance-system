import { expect, test, type Page } from '@playwright/test';
import { db, loginAs, logout, password, state } from './support';

/**
 * E2E REAL — Prefectura (cuentas ficticias con el rol real `prefectura`; la A atiende el grupo A y la B el grupo B). Comprueba que el
 * SERVIDOR deniega lo ajeno (404 indistinguible de inexistente), que la interfaz no muestra nada procedente de respuestas negadas, que
 * no hay filtracion de nombres ni escalamiento de alcance, y que una cuenta inactiva o una sesion terminada no acceden.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const FOREIGN_NAMES = /Foxtrot|Golf|Fabi|Gael/;
const OWN_NAMES = /Alfa|Beta|Gamma|Delta|Épsilon/;
const api = (page: Page, path: string) => page.request.get(`/api${path}`);
const range = () => `from=${s.weekdays[0]}&to=${s.weekdays[4]}`;

test('prefectura A: ve solo su grupo, su reporte y su seguimiento con los datos reales', async ({
  page,
}) => {
  await loginAs(page, s.accounts.prefecturaA);
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav.getByRole('link', { name: 'Asistencia', exact: true })).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'Reportes de asistencia', exact: true }),
  ).toBeVisible();
  // sin menus que no le corresponden (el servidor ademas los niega)
  for (const name of [
    'Justificantes',
    'Personal',
    'Catálogo escolar',
    'Asignaciones de prefectura',
  ])
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);

  await nav.getByRole('link', { name: 'Reportes de asistencia', exact: true }).click();
  // las opciones llegan del servidor: SOLO el grupo asignado (+ la opcion vacia)
  await expect(page.getByLabel('Grupo', { exact: true }).locator('option')).toHaveCount(2);
  const groups = await page
    .getByLabel('Grupo', { exact: true })
    .locator('option')
    .allTextContents();
  expect(groups.join('|')).toContain('1.º A');
  expect(groups.join('|')).not.toContain('1.º B');
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  const result = page.getByRole('region', { name: 'Resultado del reporte por grupo' });
  await expect(result).toBeVisible();
  const absent = await db(
    async (q) =>
      (
        await q(
          `select count(*)::int n from attendance_records r join attendance_days d on d.id = r.attendance_day_id where d.group_id = $1 and r.status = 'absent'`,
          [s.groups.A],
        )
      ).rows[0]!.n as number,
  );
  await expect(
    result
      .getByLabel('Totales del periodo')
      .locator('div', { hasText: 'Ausentes' })
      .first()
      .locator('dd'),
  ).toHaveText(String(absent));
  await expect(page.locator('body')).not.toContainText(FOREIGN_NAMES);

  // seguimiento de SU grupo
  await page
    .getByRole('navigation', { name: 'Reportes de asistencia' })
    .getByRole('link', { name: 'Seguimiento de ausencias' })
    .click();
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  const rows = page.getByRole('table').getByRole('row').locator('th[scope=row]');
  await expect(rows).toHaveCount(5);
  expect((await rows.allTextContents()).join('|')).toMatch(OWN_NAMES);
  await expect(page.locator('body')).not.toContainText(FOREIGN_NAMES);
  await logout(page);
});

test('prefectura A: grupo y alumno ajenos y URL manipulada -> el servidor deniega y la interfaz no muestra nada ajeno', async ({
  page,
}) => {
  await loginAs(page, s.accounts.prefecturaA);
  // --- respuestas reales del servidor (cookie de sesion real del navegador)
  const foreign = await api(
    page,
    `/school/attendance/reports/group?groupId=${s.groups.B}&${range()}`,
  );
  const missing = await api(
    page,
    `/school/attendance/reports/group?groupId=00000000-0000-4000-8000-00000000dead&${range()}`,
  );
  expect([foreign.status(), missing.status()]).toEqual([404, 404]);
  const fb = (await foreign.json()).error,
    mb = (await missing.json()).error;
  expect({ code: fb.code, message: fb.message }).toEqual({ code: mb.code, message: mb.message }); // indistinguibles
  expect(await foreign.text()).not.toMatch(FOREIGN_NAMES);
  const student = await api(
    page,
    `/school/attendance/reports/student/${s.students.fabi}?schoolYearId=${s.year}&${range()}`,
  );
  expect(student.status()).toBe(404);
  expect(await student.text()).not.toMatch(FOREIGN_NAMES);
  expect(
    (
      await api(
        page,
        `/school/attendance/reports/student/${s.students.ana}?schoolYearId=${s.year}&${range()}`,
      )
    ).status(),
  ).toBe(200);
  const options = await (await api(page, '/school/attendance/reports/options')).text();
  expect(options).not.toContain(s.groups.B);
  expect(
    (await api(page, `/school/attendance/reports/group/${s.groups.B}/students`)).status(),
  ).toBe(404);
  // el detalle de una lista de otro grupo tampoco se revela
  const foreignDay = await db(
    async (q) =>
      (await q(`select id from attendance_days where group_id = $1 limit 1`, [s.groups.B])).rows[0]!
        .id as string,
  );
  expect((await api(page, `/school/attendance/days/${foreignDay}`)).status()).toBe(404);

  // --- URL manipulada en la interfaz: no se consulta lo ajeno ni se pinta nada de el
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/reports/')) asked.push(r.url());
  });
  await page.goto(
    `/asistencia/reportes/seguimiento?ciclo=${s.year}&grupo=${s.groups.B}&desde=${s.weekdays[0]}&hasta=${s.weekdays[4]}`,
  );
  await expect(page.getByRole('heading', { name: 'Seguimiento de ausencias' })).toBeVisible();
  await expect(page.getByLabel('Grupo', { exact: true })).toHaveValue('');
  await page.goto(
    `/asistencia/reportes/alumno?ciclo=${s.year}&grupo=${s.groups.A}&alumno=${s.students.fabi}&desde=${s.weekdays[0]}&hasta=${s.weekdays[4]}`,
  );
  await expect(page.getByLabel('Alumno', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Alumno', { exact: true })).toHaveValue('');
  expect(asked.some((u) => u.includes(s.groups.B) || u.includes(s.students.fabi))).toBe(false);
  await expect(page.locator('body')).not.toContainText(FOREIGN_NAMES);
  // el detalle de una lista ajena por URL directa: mensaje generico, sin nombres
  await page.goto(`/asistencia/${foreignDay}`);
  await expect(page.getByRole('alert')).toContainText(
    /No se encontró la lista o ya no tienes acceso/,
  );
  await expect(page.locator('body')).not.toContainText(FOREIGN_NAMES);
  await logout(page);
});

test('prefectura A: sin escalamiento a justificantes ni a otras escrituras (403 del servidor)', async ({
  page,
}) => {
  await loginAs(page, s.accounts.prefecturaA);
  await page.goto('/justificantes');
  await expect(page.getByRole('alert')).toContainText(
    'No tienes permiso para consultar justificantes',
  );
  expect((await api(page, '/school/justifications/receipts')).status()).toBe(403);
  expect((await api(page, '/school/justifications/students?q=Ana')).status()).toBe(403);
  const csrf = (await (await api(page, '/auth/csrf')).json()).csrfToken as string;
  const created = await page.request.post('/api/school/justifications/receipts', {
    headers: { origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf },
    data: {
      requestId: '00000000-0000-4000-8000-0000000000e1',
      studentId: s.students.ana,
      schoolDate: s.weekdays[0],
    },
  });
  expect(created.status()).toBe(403);
  expect(
    await db(
      async (q) =>
        (await q(`select count(*)::int n from justification_receipts`)).rows[0]!.n as number,
    ),
  ).toBe(0);
  // la prefectura NO administra asignaciones ni cuentas
  // sus asignaciones (alcance own, por diseno) son SOLO las suyas; no puede crear ni administrar otras
  const mine = await api(page, '/school/prefect-assignments');
  expect(mine.status()).toBe(200);
  const own = await db(
    async (q) =>
      (await q(`select id from users where email = $1`, [s.accounts.prefecturaA])).rows[0]!
        .id as string,
  );
  const items = (await mine.json()).items as Array<{ user: { id: string }; group: { id: string } }>;
  expect(items.length).toBeGreaterThan(0);
  expect(items.every((i) => i.user.id === own && i.group.id === s.groups.A)).toBe(true);
  const asg = await page.request.post('/api/school/prefect-assignments', {
    headers: { origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf },
    data: { userId: own, groupId: s.groups.B, startsOn: s.today },
  });
  expect(asg.status()).toBe(403);
  expect((await api(page, '/admin/users')).status()).toBe(403);
});

test('prefectura B: solo su grupo; el grupo A es ajeno para ella', async ({ page }) => {
  await loginAs(page, s.accounts.prefecturaB);
  expect(
    (await api(page, `/school/attendance/reports/group?groupId=${s.groups.B}&${range()}`)).status(),
  ).toBe(200);
  expect(
    (await api(page, `/school/attendance/reports/group?groupId=${s.groups.A}&${range()}`)).status(),
  ).toBe(404);
  await page.goto('/asistencia/reportes/seguimiento');
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  await expect(page.getByRole('table').getByRole('row').locator('th[scope=row]')).toHaveCount(2);
  await expect(page.locator('body')).toContainText('Foxtrot');
  await expect(page.locator('body')).not.toContainText(/Alfa|Beta Ficticio|Gamma|Delta|Épsilon/);
  await logout(page);
});

test('sesion terminada o caducada: el servidor la rechaza y la interfaz vuelve al acceso sin datos', async ({
  page,
}) => {
  await loginAs(page, s.accounts.prefecturaA);
  await page.goto('/asistencia/reportes/seguimiento');
  await expect(page.getByLabel('Grupo', { exact: true })).toBeVisible();
  // caducidad por inactividad real en la base desechable
  await db(async (q) =>
    q(
      `update sessions set idle_expires_at = now() - interval '1 minute' where user_id = (select id from users where email = $1) and revoked_at is null`,
      [s.accounts.prefecturaA],
    ),
  );
  expect((await api(page, '/school/attendance/reports/options')).status()).toBe(401);
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  await expect(page.getByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(OWN_NAMES);
  // y la sesion cerrada por la persona tambien deja de servir
  await loginAs(page, s.accounts.prefecturaA);
  await logout(page);
  expect((await api(page, '/school/attendance/reports/options')).status()).toBe(401);
});

test('cuenta inactiva: no obtiene sesion ni acceso a datos', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(s.accounts.inactiva);
  await page.getByLabel('Contraseña', { exact: true }).fill(password());
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);
  expect((await api(page, '/school/attendance/reports/options')).status()).toBe(401);
  expect(
    await db(
      async (q) =>
        (
          await q(
            `select count(*)::int n from sessions where user_id = (select id from users where email = $1)`,
            [s.accounts.inactiva],
          )
        ).rows[0]!.n as number,
    ),
  ).toBe(0);
});
