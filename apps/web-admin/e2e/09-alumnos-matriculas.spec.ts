import { expect, test, type Page } from '@playwright/test';
import { auditCount, db, loginAs, logout, pickByText, send, state } from './support';

/**
 * E2E REAL — alumnos, matriculas y pertenencia a grupos por la interfaz de Direccion, verificados contra los registros de la base
 * DESECHABLE. Los alumnos de este archivo son FICTICIOS y se registran POR LA INTERFAZ; el ciclo ficticio y los grupos 1.º A y 1.º B
 * de la siembra son fixture. Los grupos 1.º C y 1.º D se crean aqui por la interfaz del catalogo (el formulario ya se valido en 08).
 *
 * No existe en la interfaz (y por eso no se prueba): borrar alumnos o matriculas, importacion masiva, CURP, tutores, fotografia.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const CURRENT_YEAR = 'Ciclo E2E ficticio';
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const studentRow = (family: string) =>
  db(
    async (q) =>
      (
        await q(
          `select id, given_names, family_name, school_code, is_active from students where family_name = $1`,
          [family],
        )
      ).rows,
  );
const enrollmentsOf = (family: string) =>
  db(
    async (q) =>
      (
        await q(
          `select e.starts_on::text s, e.ends_on::text e, y.name as yr
             from enrollments e join students st on st.id = e.student_id join school_years y on y.id = e.school_year_id
            where st.family_name = $1 order by e.starts_on`,
          [family],
        )
      ).rows,
  );
const groupsOf = (family: string) =>
  db(
    async (q) =>
      (
        await q(
          `select g.grade, g.code, a.starts_on::text s, a.ends_on::text e
             from student_group_assignments a join enrollments e on e.id = a.enrollment_id
             join students st on st.id = e.student_id join groups g on g.id = a.group_id
            where st.family_name = $1 order by a.starts_on, g.code`,
          [family],
        )
      ).rows,
  );

async function openStudent(page: Page, search: string, name: RegExp) {
  await page.goto('/alumnos');
  await page.getByLabel('Buscar por nombre o código').fill(search);
  await page.getByRole('list', { name: 'Alumnos' }).getByRole('button', { name }).click();
}

test('1. Direccion crea los grupos 1.º C y 1.º D del ciclo vigente por el catalogo', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/catalogo');
  await page.getByRole('tab', { name: 'Grupos' }).click();
  for (const code of ['C', 'D']) {
    await page.getByRole('button', { name: 'Nuevo grupo' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nuevo grupo' });
    await pickByText(dialog.getByLabel('Ciclo escolar'), CURRENT_YEAR);
    await pickByText(dialog.getByLabel('Grado'), '1.º');
    await dialog.getByLabel('Grupo', { exact: true }).fill(code);
    await dialog.getByLabel('Turno').selectOption({ label: 'Matutino' });
    await dialog.getByRole('button', { name: 'Crear grupo' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `Grupo 1.º ${code} creado.` }),
    ).toBeVisible();
  }
  const groups = await db(async (q) =>
    (
      await q(
        `select g.code from groups g join school_years y on y.id = g.school_year_id where y.name = $1 order by 1`,
        [CURRENT_YEAR],
      )
    ).rows.map((r) => r.code as string),
  );
  expect(groups).toEqual(['A', 'B', 'C', 'D']);
  await logout(page);
});

test('2. registrar alumnos: validacion, datos minimos, codigo escolar duplicado y persistencia', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/alumnos');
  await page.getByRole('button', { name: 'Registrar alumno' }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar alumno' });
  // solo datos minimos: nombre, apellidos y codigo escolar opcional (ni CURP, ni tutores, ni fecha de nacimiento)
  await expect(dialog.getByRole('textbox')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Registrar alumno' }).click();
  await expect(dialog.getByLabel('Nombre o nombres')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByLabel('Apellidos')).toHaveAttribute('aria-invalid', 'true');
  expect(await studentRow('Hotel Ficticio')).toHaveLength(0);

  await dialog.getByLabel('Nombre o nombres').fill('Hugo');
  await dialog.getByLabel('Apellidos').fill('Hotel Ficticio');
  await dialog.getByLabel('Código escolar (opcional)').fill('E2E-0001');
  await dialog.getByRole('button', { name: 'Registrar alumno' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /registrad/i })
      .first(),
  ).toBeVisible();
  expect(await studentRow('Hotel Ficticio')).toEqual([
    expect.objectContaining({ given_names: 'Hugo', school_code: 'E2E-0001', is_active: true }),
  ]);
  expect(await auditCount('student.created', 'success')).toBeGreaterThanOrEqual(1);

  // el codigo escolar no se repite: el servidor lo rechaza y no crea al segundo alumno
  await page.getByRole('button', { name: 'Registrar alumno' }).first().click();
  const again = page.getByRole('dialog', { name: 'Registrar alumno' });
  await again.getByLabel('Nombre o nombres').fill('Irma');
  await again.getByLabel('Apellidos').fill('India Ficticia');
  await again.getByLabel('Código escolar (opcional)').fill('E2E-0001');
  await again.getByRole('button', { name: 'Registrar alumno' }).click();
  await expect(again.getByRole('alert')).toBeVisible();
  expect(await studentRow('India Ficticia')).toHaveLength(0);
  await again.getByLabel('Código escolar (opcional)').fill('E2E-0002');
  await again.getByRole('button', { name: 'Registrar alumno' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /registrad/i })
      .first(),
  ).toBeVisible();
  expect(await studentRow('India Ficticia')).toHaveLength(1);

  // persisten al recargar y se encuentran por busqueda; sin matricula aun
  await openStudent(page, 'Hotel', /Hotel Ficticio, Hugo/);
  await expect(page.getByRole('region', { name: /Hotel Ficticio/ })).toContainText(
    'Matrículas por ciclo',
  );
  expect(await enrollmentsOf('Hotel Ficticio')).toEqual([]);
  await logout(page);
});

test('3. matricula de Hugo en el ciclo vigente y pertenencia a 1.º C; no se duplica la matricula', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await openStudent(page, 'Hotel', /Hotel Ficticio, Hugo/);
  const detail = page.getByRole('region', { name: /Hotel Ficticio/ });
  await detail.getByRole('button', { name: 'Inscribir en un ciclo' }).click();
  const dlg = page.getByRole('dialog', { name: 'Inscribir en un ciclo' });
  // una fecha fuera del ciclo se rechaza antes de enviar
  await pickByText(dlg.getByLabel('Ciclo escolar'), CURRENT_YEAR);
  await dlg.getByLabel('Primer día inscrito (opcional)').fill(addDays(s.today, 400));
  await dlg.getByRole('button', { name: 'Inscribir' }).click();
  await expect(dlg.getByText(/La fecha debe estar entre/)).toBeVisible();
  expect(await enrollmentsOf('Hotel Ficticio')).toEqual([]);
  await dlg.getByLabel('Primer día inscrito (opcional)').fill('');
  await dlg.getByRole('button', { name: 'Inscribir' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Alumno inscrito en el ciclo ${CURRENT_YEAR}.` }),
  ).toBeVisible();
  expect(await enrollmentsOf('Hotel Ficticio')).toEqual([
    expect.objectContaining({ s: s.today, e: null, yr: CURRENT_YEAR }),
  ]);
  // ya inscrito en el ciclo vigente: la interfaz no vuelve a ofrecerlo (solo quedan ciclos donde aun no esta inscrito)
  await detail.getByRole('button', { name: 'Inscribir en un ciclo' }).click();
  const offered = await page
    .getByRole('dialog', { name: 'Inscribir en un ciclo' })
    .getByLabel('Ciclo escolar')
    .locator('option')
    .allTextContents();
  expect(offered.join('|')).not.toContain(CURRENT_YEAR);
  await page
    .getByRole('dialog', { name: 'Inscribir en un ciclo' })
    .getByRole('button', { name: 'Cancelar' })
    .click();

  // pertenencia al grupo
  await detail.getByRole('button', { name: `Asignar grupo en el ciclo ${CURRENT_YEAR}` }).click();
  const assign = page.getByRole('dialog', { name: 'Asignar grupo' });
  await assign.getByRole('button', { name: 'Asignar grupo' }).click();
  await expect(assign.getByText('Elige el grupo.')).toBeVisible();
  await assign.getByLabel('Grupo', { exact: true }).selectOption({ label: '1.º C · Matutino' });
  await assign.getByRole('button', { name: 'Asignar grupo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Grupo asignado.' })).toBeVisible();
  expect(await groupsOf('Hotel Ficticio')).toEqual([{ grade: 1, code: 'C', s: s.today, e: null }]);
  // reconsultar: el historial de grupos aparece en el detalle
  await page.reload();
  await page.getByLabel('Buscar por nombre o código').fill('Hotel');
  await page
    .getByRole('list', { name: 'Alumnos' })
    .getByRole('button', { name: /Hotel Ficticio, Hugo/ })
    .click();
  await expect(page.getByRole('list', { name: `Grupos del ciclo ${CURRENT_YEAR}` })).toContainText(
    '1.º C',
  );
  // la API tampoco permite matricular dos veces en el mismo ciclo
  const hugo = (await studentRow('Hotel Ficticio'))[0]!.id as string;
  const dup = await send(page, 'POST', `/school/students/${hugo}/enrollments`, {
    schoolYearId: s.year,
  });
  expect([400, 409]).toContain(dup.status());
  expect(await enrollmentsOf('Hotel Ficticio')).toHaveLength(1);
  await logout(page);
});

test('4. Irma: matricula retroactiva, traslado de grupo, baja y desactivacion/reactivacion; el historial se conserva', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await openStudent(page, 'India', /India Ficticia, Irma/);
  const detail = page.getByRole('region', { name: /India Ficticia/ });
  await detail.getByRole('button', { name: 'Inscribir en un ciclo' }).click();
  const dlg = page.getByRole('dialog', { name: 'Inscribir en un ciclo' });
  await dlg.getByLabel('Primer día inscrito (opcional)').fill(addDays(s.today, -10));
  await dlg.getByRole('button', { name: 'Inscribir' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'inscrito' })).toBeVisible();
  await detail.getByRole('button', { name: `Asignar grupo en el ciclo ${CURRENT_YEAR}` }).click();
  await page
    .getByRole('dialog', { name: 'Asignar grupo' })
    .getByLabel('Grupo', { exact: true })
    .selectOption({ label: '1.º C · Matutino' });
  await page
    .getByRole('dialog', { name: 'Asignar grupo' })
    .getByRole('button', { name: 'Asignar grupo' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Grupo asignado.' })).toBeVisible();
  expect(await groupsOf('India Ficticia')).toEqual([
    { grade: 1, code: 'C', s: addDays(s.today, -10), e: null },
  ]);

  // traslado a 1.º D: el grupo actual se cierra el dia anterior y el historial se conserva
  await detail
    .getByRole('button', { name: `Trasladar de grupo en el ciclo ${CURRENT_YEAR}` })
    .click();
  const move = page.getByRole('dialog', { name: 'Trasladar de grupo' });
  await move.getByLabel('Grupo nuevo', { exact: true }).selectOption({ label: '1.º D · Matutino' });
  await move.getByRole('button', { name: 'Trasladar' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Traslado de grupo registrado.' }),
  ).toBeVisible();
  expect(await groupsOf('India Ficticia')).toEqual([
    { grade: 1, code: 'C', s: addDays(s.today, -10), e: addDays(s.today, -1) },
    { grade: 1, code: 'D', s: s.today, e: null },
  ]);
  expect(await auditCount('group_assignment.transferred', 'success')).toBeGreaterThanOrEqual(1);
  // un segundo traslado el mismo dia que empezo el grupo actual se rechaza (no hay dos grupos el mismo dia)
  await detail
    .getByRole('button', { name: `Trasladar de grupo en el ciclo ${CURRENT_YEAR}` })
    .click();
  const again = page.getByRole('dialog', { name: 'Trasladar de grupo' });
  await again
    .getByLabel('Grupo nuevo', { exact: true })
    .selectOption({ label: '1.º C · Matutino' });
  await again.getByRole('button', { name: 'Trasladar' }).click();
  await expect(again.getByRole('alert')).toBeVisible();
  expect(await groupsOf('India Ficticia')).toHaveLength(2);
  await again.getByRole('button', { name: 'Cancelar' }).click();

  // baja de la matricula: cierra tambien el grupo vigente; no se reabre
  await detail
    .getByRole('button', { name: `Dar de baja la matrícula del ciclo ${CURRENT_YEAR}` })
    .click();
  await page
    .getByRole('dialog', { name: 'Dar de baja la matrícula' })
    .getByRole('button', { name: 'Dar de baja' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Baja de matrícula registrada.' }),
  ).toBeVisible();
  expect(await enrollmentsOf('India Ficticia')).toEqual([expect.objectContaining({ e: s.today })]);
  expect((await groupsOf('India Ficticia')).at(-1)).toMatchObject({ code: 'D', e: s.today });
  await expect(
    detail.getByRole('button', { name: /Dar de baja la matrícula|Trasladar de grupo/ }),
  ).toHaveCount(0);

  // desactivar y reactivar al alumno: se audita y no se pierde nada
  await detail.getByRole('button', { name: 'Desactivar alumno' }).click();
  await page
    .getByRole('dialog', { name: 'Desactivar alumno' })
    .getByRole('button', { name: 'Desactivar alumno' })
    .click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /desactivad/i })
      .first(),
  ).toBeVisible();
  expect((await studentRow('India Ficticia'))[0]!.is_active).toBe(false);
  await detail.getByRole('button', { name: 'Reactivar alumno' }).click();
  await page
    .getByRole('dialog', { name: 'Reactivar alumno' })
    .getByRole('button', { name: 'Reactivar alumno' })
    .click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /reactivad/i })
      .first(),
  ).toBeVisible();
  expect((await studentRow('India Ficticia'))[0]!.is_active).toBe(true);
  expect(await auditCount('student.deactivated', 'success')).toBeGreaterThanOrEqual(1);
  expect(await auditCount('student.reactivated', 'success')).toBeGreaterThanOrEqual(1);
  expect(await enrollmentsOf('India Ficticia')).toHaveLength(1); // la matricula sigue en historial
  await logout(page);
});

test('5. alcance y permisos: la prefectura solo ve alumnos de su grupo; nadie sin permiso escribe', async ({
  page,
}) => {
  const hugo = (await studentRow('Hotel Ficticio'))[0]!.id as string;
  const ana = s.students.ana;
  const fabi = s.students.fabi;
  const total = await db(
    async (q) => (await q(`select count(*)::int n from students`)).rows[0]!.n as number,
  );

  await loginAs(page, s.accounts.prefecturaA);
  await page.goto('/alumnos');
  const list = page.getByRole('list', { name: 'Alumnos' });
  await expect(list).toContainText('Alfa Ficticia, Ana'); // su grupo (1.º A)
  await expect(list).not.toContainText('Foxtrot'); // grupo B
  await expect(list).not.toContainText('Hotel Ficticio'); // alumno sin relacion con su grupo
  await expect(page.getByRole('button', { name: 'Registrar alumno' })).toHaveCount(0);
  expect((await page.request.get(`/api/school/students/${ana}`)).status()).toBe(200);
  // alumno ajeno: 404 indistinguible de uno inexistente
  const foreign = await page.request.get(`/api/school/students/${fabi}`);
  const missing = await page.request.get(
    `/api/school/students/00000000-0000-4000-8000-000000000999`,
  );
  expect(foreign.status()).toBe(404);
  expect(missing.status()).toBe(404);
  const missingBody = await missing.json();
  expect((await foreign.json()).error.code).toBe(missingBody.error.code);
  expect((await foreign.json()).error.message).toBe(missingBody.error.message);
  expect((await page.request.get(`/api/school/students/${hugo}`)).status()).toBe(404);
  const write = await send(page, 'POST', '/school/students', {
    givenNames: 'Intruso',
    familyName: 'Ficticio',
  });
  expect(write.status()).toBe(403);
  expect((await send(page, 'POST', `/school/students/${ana}/deactivate`)).status()).toBe(403);
  await logout(page);

  for (const email of [s.accounts.trabajoSocial, s.accounts.tecnico]) {
    await loginAs(page, email);
    expect(
      (
        await send(page, 'POST', '/school/students', {
          givenNames: 'Intruso',
          familyName: 'Ficticio',
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await send(page, 'POST', `/school/students/${ana}/enrollments`, { schoolYearId: s.year })
      ).status(),
    ).toBe(403);
    await logout(page);
  }
  expect(await db(async (q) => (await q(`select count(*)::int n from students`)).rows[0]!.n)).toBe(
    total,
  );
  expect(await studentRow('Ficticio')).toHaveLength(0);
});
