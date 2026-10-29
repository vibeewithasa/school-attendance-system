import { expect, test, type Page } from '@playwright/test';
import { db, focusProblems, layoutIssues, loginAs, logout, pickByText, state } from './support';

/**
 * E2E REAL — uso del portal en una pantalla de 375 x 812 px (movil, con toque y densidad 2) con Chrome, la API real y la base
 * DESECHABLE. Por cada pantalla se mide en el navegador: sin desplazamiento horizontal de la pagina, controles dentro de la pantalla
 * (o en un contenedor deliberadamente desplazable), objetivos tactiles de al menos 24 px, sin controles superpuestos y texto legible
 * (>= 12 px); ademas el teclado recorre los controles con el foco visible y dentro de la pantalla. No se evalua el diseno estetico.
 */
test.use({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const WEEKEND = () =>
  [0, 6].includes(
    new Date(
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date())}T00:00:00Z`,
    ).getUTCDay(),
  );

/** Falla con la lista de problemas de diseno de la pantalla actual (vacia = correcta). */
async function expectLayoutOk(page: Page, where: string) {
  const issues = await layoutIssues(page);
  expect(issues, `${where} a 375 px`).toEqual([]);
}

/** Las tablas anchas deben poder desplazarse horizontalmente dentro de su contenedor (sin romper la pagina). */
async function expectTablesScrollable(page: Page) {
  const tables = page.getByRole('table');
  const n = await tables.count();
  for (let i = 0; i < n; i++) {
    const info = await tables.nth(i).evaluate((t) => {
      let p: HTMLElement | null = t.parentElement;
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll') break;
        p = p.parentElement;
      }
      const wide = t.scrollWidth > document.documentElement.clientWidth;
      return { wide, container: p && p !== document.body ? p.scrollWidth > p.clientWidth : false };
    });
    if (info.wide)
      expect(
        info.container,
        `la tabla ancha ${i + 1} debe desplazarse dentro de su contenedor`,
      ).toBe(true);
  }
}

test('1. inicio de sesion: formulario, validacion y teclado', async ({ page }) => {
  await page.goto('/login');
  await expectLayoutOk(page, 'inicio de sesion');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(
    page
      .getByRole('alert')
      .first()
      .or(page.getByText(/Escribe|obligatori|Ingresa/i).first()),
  ).toBeVisible();
  await expectLayoutOk(page, 'inicio de sesion con mensajes de validacion');
  expect(await focusProblems(page, 6)).toEqual([]);
  // el foco no se pierde tras la validacion: queda en el documento, no en <body>
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
});

test('2. Direccion: menu y navegacion por todas las pantallas administrativas', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await expectLayoutOk(page, 'inicio');
  const nav = page.getByRole('navigation', { name: 'Principal' });
  const links = [
    ['Personal', '/personal'],
    ['Alumnos', '/alumnos'],
    ['Asistencia', '/asistencia'],
    ['Reportes de asistencia', '/asistencia/reportes/grupo'],
    ['Justificantes', '/justificantes'],
    ['Asignaciones de prefectura', '/prefectura'],
    ['Catálogo escolar', '/catalogo'],
  ] as const;
  for (const [name, path] of links) {
    const link = nav.getByRole('link', { name, exact: true });
    if ((await link.count()) === 0) continue; // p. ej. Justificantes solo para Trabajo Social
    await link.click(); // el menu siempre es alcanzable por toque (sin controles fuera de pantalla)
    await expect(page).toHaveURL(new RegExp(path.replace(/\//g, '\\/')));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectLayoutOk(page, `pantalla ${name}`);
    await expectTablesScrollable(page);
  }
  // teclado: Tab recorre el menu y los controles con foco visible
  await page.goto('/');
  expect(await focusProblems(page, 14)).toEqual([]);
  await logout(page);
});

test('3. Direccion: asistencia, reporte por grupo, por alumno y seguimiento a 375 px', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/asistencia');
  await expect(page.getByRole('heading', { name: 'Asistencia', exact: true })).toBeVisible();
  await expectLayoutOk(page, 'asistencia');

  // reporte por grupo (filtros + resultado)
  await page.goto('/asistencia/reportes/grupo');
  await pickByText(page.getByLabel('Ciclo escolar', { exact: true }), 'Ciclo E2E ficticio');
  const group = page.getByLabel('Grupo', { exact: true });
  await expect(group.locator('option')).not.toHaveCount(1);
  await pickByText(group, '1.º A');
  await page.getByLabel('Hasta', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  await expectLayoutOk(page, 'reporte por grupo con mensajes de validacion');
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  await expect(page.getByRole('region', { name: 'Resultado del reporte por grupo' })).toBeVisible();
  await expectLayoutOk(page, 'reporte por grupo con resultado');
  await expectTablesScrollable(page);

  // reporte por alumno
  await page.goto('/asistencia/reportes/alumno');
  await pickByText(page.getByLabel('Ciclo escolar', { exact: true }), 'Ciclo E2E ficticio');
  await expect(page.getByLabel('Grupo', { exact: true }).locator('option')).not.toHaveCount(1);
  await pickByText(page.getByLabel('Grupo', { exact: true }), '1.º A');
  await expect(page.getByLabel('Alumno', { exact: true })).toBeEnabled();
  await page.getByLabel('Alumno', { exact: true }).selectOption({ value: s.students.ana });
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  await expect(
    page.getByRole('table', { name: /Situación del alumno por día hábil/ }),
  ).toBeVisible();
  await expectLayoutOk(page, 'reporte por alumno');
  await expectTablesScrollable(page);

  // seguimiento de ausencias
  await page.goto('/asistencia/reportes/seguimiento');
  await pickByText(page.getByLabel('Ciclo escolar', { exact: true }), 'Ciclo E2E ficticio');
  await expect(page.getByLabel('Grupo', { exact: true }).locator('option')).not.toHaveCount(1);
  await pickByText(page.getByLabel('Grupo', { exact: true }), '1.º A');
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).toBeVisible();
  await expectLayoutOk(page, 'seguimiento de ausencias');
  await expectTablesScrollable(page);
  // el detalle individual se abre y se regresa (filtros conservados)
  await page
    .getByRole('region', { name: 'Resultado del seguimiento de ausencias' })
    .getByRole('link')
    .first()
    .click();
  await expectLayoutOk(page, 'detalle del seguimiento');
  await logout(page);
});

test('4. prefectura: pasar lista de hoy a 375 px con toque y guardado', async ({ page }) => {
  test.skip(WEEKEND(), 'Hoy es fin de semana: no se abren listas (regla de la escuela)');
  await loginAs(page, s.accounts.prefecturaA);
  await page.goto('/asistencia');
  await expectLayoutOk(page, 'asistencia de prefectura');
  await page.getByRole('button', { name: /Abrir la lista de 1\.º A/ }).click();
  const roster = page.getByRole('list', { name: 'Alumnos de la lista' });
  await expect(roster.getByRole('listitem')).toHaveCount(5);
  await expectLayoutOk(page, 'lista de asistencia (5 alumnos pendientes)');
  // marcar con toque (tap) a cada alumno; el boton de finalizar sigue alcanzable al final de la pagina
  const names = [
    'Ana Alfa Ficticia',
    'Beto Beta Ficticio',
    'Carla Gamma Ficticia',
    'Diego Delta Ficticio',
    'Elena Épsilon Ficticia',
  ];
  for (const [i, n] of names.entries())
    await page
      .getByRole('radiogroup', { name: `Asistencia de ${n}` })
      .getByText(i === 1 ? 'Ausente' : 'Presente', { exact: true })
      .tap();
  await expectLayoutOk(page, 'lista de asistencia con marcas');
  await page.getByRole('button', { name: 'Guardar borrador' }).tap();
  await expect(page.getByRole('status').filter({ hasText: /guard/i }).first()).toBeVisible();
  const fin = page.getByRole('button', { name: 'Finalizar lista' });
  await fin.scrollIntoViewIfNeeded();
  await expect(fin).toBeEnabled();
  await fin.tap();
  await expectLayoutOk(page, 'confirmacion de finalizar');
  await page.getByRole('dialog').getByRole('button', { name: 'Finalizar', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Guardar borrador' })).toHaveCount(0); // la lista ya no se edita
  await expect
    .poll(() =>
      db(
        async (q) =>
          (
            await q(
              `select status from attendance_days d where d.group_id = $1 and d.attendance_date = $2`,
              [s.groups.A, s.today],
            )
          ).rows[0]?.status,
      ),
    )
    .toBe('finalized');
  await logout(page);
});

test('5. Trabajo Social: justificantes (busqueda, formulario y mensajes de validacion) a 375 px', async ({
  page,
}) => {
  await loginAs(page, s.accounts.trabajoSocial);
  await page.goto('/justificantes');
  await expect(page.getByRole('heading', { name: 'Justificantes' })).toBeVisible();
  await expectLayoutOk(page, 'justificantes');
  const form = page.getByRole('search', { name: 'Alumno', exact: true });
  await form.getByRole('searchbox').fill('Ana');
  await form.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: 'Elegir a Ana Alfa Ficticia' }).first().click();
  await page.getByLabel('Fecha escolar del justificante').fill('');
  await page.getByRole('button', { name: 'Registrar recepción' }).click();
  await expectLayoutOk(page, 'justificantes con mensaje de validacion');
  await expectTablesScrollable(page);
  expect(await focusProblems(page, 10)).toEqual([]);
  await logout(page);
});

test('6. administracion: formularios y cuadros de dialogo a 375 px (alta de cuenta, alumno, ciclo) con teclado', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  const cases: Array<[string, string, string]> = [
    ['/personal', 'Nueva cuenta', 'Nueva cuenta de personal'],
    ['/alumnos', 'Registrar alumno', 'Registrar alumno'],
    ['/catalogo', 'Nuevo ciclo', 'Nuevo ciclo escolar'],
    ['/prefectura', 'Asignar grupos', 'Asignar grupos a prefectura'],
  ];
  for (const [path, button, title] of cases) {
    await page.goto(path);
    await page.getByRole('button', { name: button, exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await expectLayoutOk(page, `dialogo «${title}»`);
    // el boton de envio es alcanzable (el dialogo se desplaza si no cabe) y la validacion se muestra sin salirse de la pantalla
    const submit = dialog.locator('button[type=submit]');
    await submit.scrollIntoViewIfNeeded();
    await submit.tap();
    await expectLayoutOk(page, `dialogo «${title}» con mensajes de validacion`);
    // el foco permanece dentro del dialogo (Tab no escapa) y Escape lo cierra devolviendo el uso de la pagina
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  await logout(page);
});

test('7. estados de error y de acceso denegado a 375 px', async ({ page }) => {
  await page.goto('/ruta-que-no-existe');
  await expectLayoutOk(page, 'pagina no encontrada');
  await loginAs(page, s.accounts.prefecturaA);
  await page.goto('/personal');
  await expect(page.getByRole('alert')).toContainText('No tienes permiso');
  await expectLayoutOk(page, 'acceso denegado');
  await page.goto('/catalogo');
  await expectLayoutOk(page, 'catalogo sin permiso de edicion');
  await logout(page);
});
