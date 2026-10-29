import { expect, test, type Page } from '@playwright/test';
import { auditCount, db, loginAs, logout, pickByText, send, state } from './support';

/**
 * E2E REAL — catalogo escolar (ciclos y grupos) por la interfaz de Direccion, verificado contra los registros de la base
 * DESECHABLE. El ciclo ficticio de la siembra ("Ciclo E2E ficticio") es una precondicion de fixture; los ciclos y grupos de este
 * archivo se crean POR LA INTERFAZ. Sin permiso (prefectura, trabajo social, administracion tecnica) no se puede modificar nada.
 *
 * Fuera de alcance (no existe en la interfaz): borrar ciclos o grupos (nada se borra), cambiar el grado o el ciclo de un grupo
 * ya creado y modificar ciclos historicos (la interfaz y la API los tratan como historial).
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const NEXT = 'Ciclo E2E siguiente';
const PAST = 'Ciclo E2E anterior';
const yearRow = (name: string) =>
  db(
    async (q) =>
      (
        await q(
          `select id, name, starts_on::text s, ends_on::text e, is_active from school_years where name = $1`,
          [name],
        )
      ).rows,
  );
const count = (table: string) =>
  db(async (q) => (await q(`select count(*)::int n from ${table}`)).rows[0]!.n as number);

async function fillYear(page: Page, name: string, from: string, to: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nombre del ciclo').fill(name);
  await dialog.getByLabel('Inicio').fill(from);
  await dialog.getByLabel('Fin').fill(to);
  return dialog;
}

test('1. Direccion valida y crea un ciclo proximo; un ciclo traslapado se rechaza; el cambio persiste al recargar', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/catalogo');
  const years = page.getByRole('list', { name: 'Ciclos escolares' });
  await expect(years).toContainText('Ciclo E2E ficticio');
  await expect(years).toContainText('En curso sin activar'); // la siembra no activa el ciclo

  await page.getByRole('button', { name: 'Nuevo ciclo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo ciclo escolar' });
  await dialog.getByRole('button', { name: 'Crear ciclo' }).click();
  await expect(dialog.getByText(/Escribe el nombre del ciclo/)).toBeVisible();
  await expect(dialog.getByText('Indica la fecha de inicio.')).toBeVisible();
  await expect(dialog.getByLabel('Nombre del ciclo')).toHaveAttribute('aria-invalid', 'true');
  // duracion fuera de rango (menos de 60 dias)
  await fillYear(page, NEXT, addDays(s.today, 201), addDays(s.today, 230));
  await dialog.getByRole('button', { name: 'Crear ciclo' }).click();
  await expect(dialog.getByText(/El ciclo debe durar entre 60 y 400 días/)).toBeVisible();
  expect(await yearRow(NEXT)).toHaveLength(0);
  // fin anterior al inicio
  await fillYear(page, NEXT, addDays(s.today, 300), addDays(s.today, 250));
  await dialog.getByRole('button', { name: 'Crear ciclo' }).click();
  await expect(
    dialog.getByText('La fecha de fin debe ser posterior a la de inicio.'),
  ).toBeVisible();

  // traslape con el ciclo existente: lo rechaza el servidor (409) y no se crea nada
  const before = await count('school_years');
  await fillYear(page, NEXT, addDays(s.today, 150), addDays(s.today, 400));
  await dialog.getByRole('button', { name: 'Crear ciclo' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(await count('school_years')).toBe(before);

  // ciclo valido
  await fillYear(page, NEXT, addDays(s.today, 201), addDays(s.today, 500));
  await dialog.getByRole('button', { name: 'Crear ciclo' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Ciclo ${NEXT} creado.` })).toBeVisible();
  const rows = await yearRow(NEXT);
  expect(rows).toEqual([
    expect.objectContaining({
      s: addDays(s.today, 201),
      e: addDays(s.today, 500),
      is_active: false,
    }),
  ]);
  expect(await auditCount('school_year.created', 'success')).toBeGreaterThanOrEqual(1);

  await page.reload();
  const next = page
    .getByRole('list', { name: 'Ciclos escolares' })
    .getByRole('listitem')
    .filter({ hasText: NEXT });
  await expect(next).toContainText('Próximo');
  await expect(next).toContainText('0 grupos');
  // un ciclo proximo no se activa (solo el que incluye hoy)
  await expect(next.getByRole('button', { name: `Activar ciclo ${NEXT}` })).toHaveCount(0);

  // un ciclo anterior queda como historico: sin acciones de edicion ni activacion
  await page.getByRole('button', { name: 'Nuevo ciclo' }).click();
  await fillYear(page, PAST, addDays(s.today, -400), addDays(s.today, -90));
  await page.getByRole('dialog').getByRole('button', { name: 'Crear ciclo' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Ciclo ${PAST} creado.` })).toBeVisible();
  const past = page
    .getByRole('list', { name: 'Ciclos escolares' })
    .getByRole('listitem')
    .filter({ hasText: PAST });
  await expect(past).toContainText('Histórico');
  await expect(past.getByRole('button')).toHaveCount(0);
  await logout(page);
});

test('2. editar un ciclo: sin cambios se avisa, con cambios se guardan, la edicion no activa nada', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/catalogo');
  await page.getByRole('button', { name: `Editar ciclo ${NEXT}` }).click();
  let dialog = page.getByRole('dialog', { name: `Editar ciclo ${NEXT}` });
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(dialog.getByText('No hay cambios que guardar.')).toBeVisible();
  await dialog.getByLabel('Nombre del ciclo').fill('Ciclo E2E siguiente (editado)');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Ciclo Ciclo E2E siguiente (editado) actualizado.' }),
  ).toBeVisible();
  expect(await yearRow(NEXT)).toHaveLength(0);
  expect(await yearRow('Ciclo E2E siguiente (editado)')).toEqual([
    expect.objectContaining({ is_active: false }),
  ]);
  // el nombre no puede repetirse
  await page.getByRole('button', { name: 'Editar ciclo Ciclo E2E siguiente (editado)' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nombre del ciclo').fill('Ciclo E2E ficticio');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(await yearRow('Ciclo E2E ficticio')).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  // se restituye el nombre original para los demas escenarios
  await page.getByRole('button', { name: 'Editar ciclo Ciclo E2E siguiente (editado)' }).click();
  await page.getByRole('dialog').getByLabel('Nombre del ciclo').fill(NEXT);
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Ciclo ${NEXT} actualizado.` }),
  ).toBeVisible();
  await logout(page);
});

test('3. activar y desactivar el ciclo vigente: solo uno vigente, nada se borra', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/catalogo');
  await page.getByRole('button', { name: 'Activar ciclo Ciclo E2E ficticio' }).click();
  const dialog = page.getByRole('dialog', { name: 'Activar ciclo escolar' });
  await dialog.getByRole('button', { name: 'Activar ciclo' }).click();
  const item = page
    .getByRole('list', { name: 'Ciclos escolares' })
    .getByRole('listitem')
    .filter({ hasText: 'Ciclo E2E ficticio' });
  await expect(item).toContainText('Vigente');
  expect((await yearRow('Ciclo E2E ficticio'))[0]!.is_active).toBe(true);
  expect(await auditCount('school_year.activated', 'success')).toBeGreaterThanOrEqual(1);
  // los alumnos y listas existentes siguen intactos
  expect(await count('students')).toBe(7);
  await page.reload();
  await expect(item).toContainText('Vigente');
  // desactivar y volver a activar
  await page.getByRole('button', { name: 'Desactivar ciclo Ciclo E2E ficticio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Desactivar ciclo' }).click();
  await expect(item).toContainText('En curso sin activar');
  expect((await yearRow('Ciclo E2E ficticio'))[0]!.is_active).toBe(false);
  await page.getByRole('button', { name: 'Activar ciclo Ciclo E2E ficticio' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Activar ciclo' }).click();
  await expect(item).toContainText('Vigente');
  expect(await count('school_years')).toBe(3); // nada se borro: el de la siembra, el proximo y el historico
  await logout(page);
});

test('4. grupos: validar, crear en un ciclo proximo, duplicado, editar y desactivar/activar con confirmacion', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/catalogo');
  await page.getByRole('tab', { name: 'Grupos' }).click();
  await expect(page.getByRole('list', { name: 'Grupos' })).toContainText('1.º A');
  // la lista abre filtrada por el ciclo vigente; para ver los del ciclo proximo se cambia el filtro
  await pickByText(page.getByRole('search').getByLabel('Ciclo escolar'), NEXT);
  await page.getByRole('button', { name: 'Nuevo grupo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo grupo' });
  // el ciclo historico no se ofrece para crear grupos
  const options = await dialog.getByLabel('Ciclo escolar').locator('option').allTextContents();
  expect(options.join('|')).toContain(NEXT);
  expect(options.join('|')).not.toContain(PAST);

  await pickByText(dialog.getByLabel('Ciclo escolar'), NEXT);
  await pickByText(dialog.getByLabel('Grado'), '2.º');
  await dialog.getByLabel('Grupo', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Crear grupo' }).click();
  await expect(dialog.getByText(/Escribe el identificador del grupo/)).toBeVisible();
  await dialog.getByLabel('Grupo', { exact: true }).fill('Ñ!');
  await dialog.getByRole('button', { name: 'Crear grupo' }).click();
  await expect(dialog.getByLabel('Grupo', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(
    await db(
      async (q) => (await q(`select count(*)::int n from groups where code like '%!%'`)).rows[0]!.n,
    ),
  ).toBe(0);

  await dialog.getByLabel('Grupo', { exact: true }).fill('a');
  await dialog.getByLabel('Turno').selectOption({ label: 'Matutino' });
  await dialog.getByLabel('Hora de entrada (opcional)').fill('07:50');
  await dialog.getByRole('button', { name: 'Crear grupo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Grupo 2.º A creado.' })).toBeVisible();
  const created = await db(
    async (q) =>
      (
        await q(
          `select g.id, g.grade, g.code, g.shift, to_char(g.expected_entry_time, 'HH24:MI') t, g.is_active
             from groups g join school_years y on y.id = g.school_year_id where y.name = $1`,
          [NEXT],
        )
      ).rows,
  );
  expect(created).toEqual([
    expect.objectContaining({
      grade: 2,
      code: 'A',
      shift: 'matutino',
      t: '07:50',
      is_active: true,
    }),
  ]);
  expect(await auditCount('group.created', 'success')).toBeGreaterThanOrEqual(1);

  // el mismo ciclo, grado, grupo y TURNO no se duplican (el servidor lo rechaza; con otro turno si es otro grupo, por diseno)
  await page.getByRole('button', { name: 'Nuevo grupo' }).click();
  const dup = page.getByRole('dialog', { name: 'Nuevo grupo' });
  await pickByText(dup.getByLabel('Ciclo escolar'), NEXT);
  await pickByText(dup.getByLabel('Grado'), '2.º');
  await dup.getByLabel('Grupo', { exact: true }).fill('A');
  await dup.getByLabel('Turno').selectOption({ label: 'Matutino' });
  await dup.getByRole('button', { name: 'Crear grupo' }).click();
  await expect(dup.getByRole('alert')).toBeVisible();
  expect(
    await db(
      async (q) =>
        (
          await q(
            `select count(*)::int n from groups g join school_years y on y.id = g.school_year_id where y.name = $1`,
            [NEXT],
          )
        ).rows[0]!.n,
    ),
  ).toBe(1);
  await dup.getByRole('button', { name: 'Cancelar' }).click();

  // editar: cambiar el turno y quitar la hora; sin cambios se avisa
  const groupName = `2.º A ${NEXT}`;
  await page.getByRole('button', { name: `Editar grupo ${groupName}` }).click();
  const edit = page.getByRole('dialog', { name: 'Editar grupo 2.º A' });
  await edit.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(edit.getByText('No hay cambios que guardar.')).toBeVisible();
  await edit.getByLabel('Turno').selectOption({ label: 'Vespertino' });
  await edit.getByRole('button', { name: 'Quitar la hora de entrada' }).click();
  await edit.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Grupo 2.º A actualizado.' }),
  ).toBeVisible();
  expect(
    await db(
      async (q) =>
        (await q(`select shift, expected_entry_time from groups where code = 'A' and grade = 2`))
          .rows[0],
    ),
  ).toEqual({ shift: 'vespertino', expected_entry_time: null });

  // desactivar y activar con confirmacion; el registro se conserva
  await page.getByRole('button', { name: `Desactivar grupo ${groupName}` }).click();
  await page
    .getByRole('dialog', { name: 'Desactivar grupo' })
    .getByRole('button', { name: 'Desactivar grupo' })
    .click();
  await expect(
    page.getByRole('list', { name: 'Grupos' }).getByRole('listitem').filter({ hasText: NEXT }),
  ).toContainText('Inactivo');
  expect(
    await db(
      async (q) =>
        (await q(`select is_active from groups where code = 'A' and grade = 2`)).rows[0]!.is_active,
    ),
  ).toBe(false);
  await page.getByRole('button', { name: `Activar grupo ${groupName}` }).click();
  await page
    .getByRole('dialog', { name: 'Activar grupo' })
    .getByRole('button', { name: 'Activar grupo' })
    .click();
  await expect(
    page.getByRole('list', { name: 'Grupos' }).getByRole('listitem').filter({ hasText: NEXT }),
  ).toContainText('Activo');
  expect(
    await db(
      async (q) =>
        (await q(`select is_active from groups where code = 'A' and grade = 2`)).rows[0]!.is_active,
    ),
  ).toBe(true);
  await logout(page);
});

test('5. sin permiso no se modifica el catalogo: prefectura, trabajo social y administracion tecnica', async ({
  page,
}) => {
  const years = await count('school_years');
  const groups = await count('groups');
  for (const email of [s.accounts.prefecturaA, s.accounts.trabajoSocial, s.accounts.tecnico]) {
    await loginAs(page, email);
    await page.goto('/catalogo');
    await expect(page.getByRole('button', { name: 'Nuevo ciclo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo grupo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Editar|^Activar|^Desactivar/ })).toHaveCount(0);
    const body = {
      name: 'Ciclo intruso',
      startsOn: addDays(s.today, 600),
      endsOn: addDays(s.today, 800),
    };
    expect((await send(page, 'POST', '/catalog/school-years', body)).status()).toBe(403);
    expect(
      (
        await send(page, 'POST', '/catalog/groups', { schoolYearId: s.year, grade: 3, code: 'Z' })
      ).status(),
    ).toBe(403);
    expect((await send(page, 'POST', `/catalog/school-years/${s.year}/deactivate`)).status()).toBe(
      403,
    );
    await logout(page);
  }
  expect(await count('school_years')).toBe(years);
  expect(await count('groups')).toBe(groups);
  expect((await yearRow('Ciclo E2E ficticio'))[0]!.is_active).toBe(true);
});
