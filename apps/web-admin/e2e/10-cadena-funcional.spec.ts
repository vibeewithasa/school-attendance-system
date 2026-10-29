import { expect, test, type Page } from '@playwright/test';
import {
  NEW_PREFECT,
  NOTICE_RECEIPT,
  attendanceFingerprint,
  auditCount,
  chosenPassword,
  db,
  loginAs,
  logout,
  pickByText,
  send,
  state,
} from './support';

/**
 * E2E REAL — CADENA FUNCIONAL ADMINISTRATIVA, de la configuracion al reporte, con cuentas y datos FICTICIOS:
 *
 *   07  Direccion crea la cuenta de la prefecta, le asigna el rol y la prefecta la activa (control dual)      [POR INTERFAZ]
 *   08  Direccion administra ciclos y grupos                                                                     [POR INTERFAZ]
 *   09  Direccion crea al alumno Hugo, lo matricula y lo asigna al grupo 1.º C (creado por la interfaz)         [POR INTERFAZ]
 *   10  Direccion asigna el grupo 1.º C a la prefecta -> ella consulta SOLO ese grupo -> captura la lista de hoy
 *       -> Direccion consulta el reporte y el seguimiento -> Trabajo Social registra la recepcion sin cambiar la asistencia
 *       -> Direccion revoca la asignacion y la prefecta pierde el acceso al instante                             [POR INTERFAZ]
 *
 * Fixtures (NO se hacen por la interfaz): el ciclo "Ciclo E2E ficticio" (que si se ACTIVA por la interfaz en 08), los grupos
 * 1.º A/1.º B con sus alumnos y listas anteriores, las cuentas de Direccion y de la segunda autoridad, y el reloj de la siembra.
 * La captura de la lista de HOY solo existe entre semana (America/Mazatlan): en sabado o domingo esos pasos se omiten y se declara.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
let groupC = '';
let hugo = '';
test.beforeAll(async () => {
  s = state();
  groupC = await db(
    async (q) =>
      (
        await q(
          `select g.id from groups g where g.code = 'C' and g.grade = 1 and g.shift = 'matutino'`,
        )
      ).rows[0]!.id as string,
  );
  hugo = await db(
    async (q) =>
      (await q(`select id from students where family_name = 'Hotel Ficticio'`)).rows[0]!
        .id as string,
  );
});

const schoolDow = () =>
  new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date())}T00:00:00Z`,
  ).getUTCDay();
const WEEKEND = () => [0, 6].includes(schoolDow());
const assignments = () =>
  db(
    async (q) =>
      (
        await q(
          `select a.id, g.code, a.revoked_at is not null revoked, a.ends_on::text e
             from prefect_group_assignments a join users u on u.id = a.user_id join groups g on g.id = a.group_id
            where u.email = $1 order by a.created_at`,
          [NEW_PREFECT.email],
        )
      ).rows,
  );
const dayOfC = () =>
  db(
    async (q) =>
      (
        await q(
          `select d.id, d.status, d.attendance_date::text d,
                  (select count(*)::int from attendance_records r where r.attendance_day_id = d.id) n,
                  (select string_agg(st.family_name || ':' || coalesce(r.status, 'null'), ',') from attendance_records r
                     join enrollments e on e.id = r.enrollment_id join students st on st.id = e.student_id
                    where r.attendance_day_id = d.id) marks
             from attendance_days d where d.group_id = $1 order by d.attendance_date desc`,
          [groupC],
        )
      ).rows,
  );

async function reportFor(page: Page, path: string, button: string) {
  await page.goto(path);
  await pickByText(page.getByLabel('Ciclo escolar', { exact: true }), 'Ciclo E2E ficticio');
  const group = page.getByLabel('Grupo', { exact: true });
  await expect(group.locator('option')).not.toHaveCount(1);
  await pickByText(group, '1.º C');
  await page.getByLabel('Desde', { exact: true }).fill(s.today);
  await page.getByLabel('Hasta', { exact: true }).fill(s.today);
  await page.getByRole('button', { name: button }).click();
}

test('1. Direccion asigna el grupo 1.º C a la prefecta nueva por la interfaz; el servidor no duplica ni acepta datos incompletos', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/prefectura');
  await page.getByRole('button', { name: 'Asignar grupos' }).click();
  const dialog = page.getByRole('dialog', { name: 'Asignar grupos a prefectura' });
  await dialog.getByRole('button', { name: 'Asignar grupos' }).click(); // sin elegir nada
  await expect(dialog.getByLabel('Prefecta')).toHaveAttribute('aria-invalid', 'true');
  expect(await assignments()).toEqual([]);

  await pickByText(dialog.getByLabel('Prefecta'), NEW_PREFECT.name);
  await pickByText(dialog.getByLabel('Ciclo escolar'), 'Ciclo E2E ficticio');
  await dialog.getByRole('button', { name: 'Asignar grupos' }).click(); // falta elegir grupos
  await expect(dialog.getByRole('alert').or(dialog.locator('#grupos-e'))).toBeVisible();
  expect(await assignments()).toEqual([]);
  await dialog
    .getByRole('group', { name: 'Grupos' })
    .getByLabel(/1\.º C/)
    .check();
  await dialog.getByRole('button', { name: 'Asignar grupos' }).click();
  await expect(page.getByRole('status').first()).toBeVisible();
  expect(await assignments()).toEqual([
    expect.objectContaining({ code: 'C', revoked: false, e: null }),
  ]);
  expect(await auditCount('prefect_assignment.created', 'success')).toBeGreaterThanOrEqual(1);

  // la misma asignacion vigente no se repite
  await page.getByRole('button', { name: 'Asignar grupos' }).click();
  const again = page.getByRole('dialog', { name: 'Asignar grupos a prefectura' });
  await pickByText(again.getByLabel('Prefecta'), NEW_PREFECT.name);
  await pickByText(again.getByLabel('Ciclo escolar'), 'Ciclo E2E ficticio');
  await again
    .getByRole('group', { name: 'Grupos' })
    .getByLabel(/1\.º C/)
    .check();
  await again.getByRole('button', { name: 'Asignar grupos' }).click();
  await expect(again.getByRole('alert')).toBeVisible();
  expect(await assignments()).toHaveLength(1);
  await again.getByRole('button', { name: 'Cancelar' }).click();

  // al reconsultar aparece vigente
  await page.reload();
  const row = page
    .getByRole('list', { name: 'Asignaciones de prefectura' })
    .getByRole('listitem')
    .filter({ hasText: NEW_PREFECT.name });
  await expect(row).toContainText('1.º C');
  await expect(row).toContainText('Vigente');
  await logout(page);
});

test('2. la prefecta nueva solo consulta SU grupo; los grupos y alumnos ajenos son 404 (indistinguibles de los inexistentes)', async ({
  page,
}) => {
  await loginAs(page, NEW_PREFECT.email, chosenPassword());
  const nav = page.getByRole('navigation', { name: 'Principal' });
  for (const name of [
    'Personal',
    'Catálogo escolar',
    'Justificantes',
    'Asignaciones de prefectura',
  ])
    await expect(nav.getByRole('link', { name })).toHaveCount(0);
  await page.goto('/alumnos');
  const list = page.getByRole('list', { name: 'Alumnos' });
  await expect(list).toContainText('Hotel Ficticio, Hugo'); // padron de 1.º C
  await expect(list).not.toContainText('Alfa Ficticia'); // 1.º A (otra prefecta)
  await expect(list).not.toContainText('Foxtrot'); // 1.º B (otra prefecta)
  await expect(list).not.toContainText('India Ficticia'); // en 1.º D, no en 1.º C hoy

  const mine = await page.request.get('/api/school/me/groups');
  expect(mine.status()).toBe(200);
  const groups = (await mine.json()).groups as Array<{ group: { code: string } }>;
  expect(groups.map((g) => g.group.code)).toEqual(['C']);
  expect((await page.request.get(`/api/school/groups/${groupC}/roster`)).status()).toBe(200);
  const foreign = await page.request.get(`/api/school/groups/${s.groups.A}/roster`);
  const missing = await page.request.get(
    `/api/school/groups/00000000-0000-4000-8000-000000000999/roster`,
  );
  expect(foreign.status()).toBe(404);
  expect(missing.status()).toBe(404);
  const missingBody = await missing.json();
  expect((await foreign.json()).error.code).toBe(missingBody.error.code);
  expect((await foreign.json()).error.message).toBe(missingBody.error.message);
  expect((await page.request.get(`/api/school/students/${s.students.ana}`)).status()).toBe(404);
  // sin permiso: no administra personal, catalogo, justificantes ni asignaciones
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  // autoasignarse un grupo ajeno: aun con un cuerpo valido, sin permiso el servidor responde 403 y no crea nada
  const me = await db(
    async (q) =>
      (await q(`select id from users where email = $1`, [NEW_PREFECT.email])).rows[0]!.id as string,
  );
  expect(
    (
      await send(page, 'POST', '/school/prefect-assignments', { userId: me, groupId: s.groups.A })
    ).status(),
  ).toBe(403);
  expect(await assignments()).toHaveLength(1);
  await logout(page);
});

test('3. la prefecta nueva abre la lista de hoy de 1.º C con el padron real (solo Hugo), marca y finaliza', async ({
  page,
}) => {
  test.skip(WEEKEND(), 'Hoy es fin de semana: no se abren listas (regla de la escuela)');
  await loginAs(page, NEW_PREFECT.email, chosenPassword());
  await page.goto('/asistencia');
  const groups = page.getByRole('list', { name: 'Grupos del día' });
  await expect(groups.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: /Abrir la lista de 1\.º C/ }).click();
  const roster = page.getByRole('list', { name: 'Alumnos de la lista' });
  await expect(roster.getByRole('listitem')).toHaveCount(1);
  await expect(roster).toContainText('Hugo');
  expect(await dayOfC()).toEqual([expect.objectContaining({ status: 'draft', n: 1, d: s.today })]);

  await page
    .getByRole('radiogroup', { name: /Asistencia de Hugo/ })
    .getByText('Ausente', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Guardar borrador' }).click();
  await expect(page.getByRole('status').filter({ hasText: /guard/i }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Finalizar lista' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finalizar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar borrador' })).toHaveCount(0); // la lista ya no se edita
  await expect.poll(async () => (await dayOfC())[0]?.status).toBe('finalized');
  expect(await dayOfC()).toEqual([
    expect.objectContaining({ status: 'finalized', n: 1, marks: 'Hotel Ficticio:absent' }),
  ]);
  await logout(page);
});

test('4. Direccion consulta el reporte por grupo y el seguimiento: reflejan la marca real de Hugo', async ({
  page,
}) => {
  test.skip(WEEKEND(), 'Hoy es fin de semana: no hay lista de hoy');
  await loginAs(page, s.accounts.direccion);
  await reportFor(page, '/asistencia/reportes/grupo', 'Generar reporte');
  const result = page.getByRole('region', { name: 'Resultado del reporte por grupo' });
  const students = result.getByRole('table', { name: /Marcas por alumno/ });
  const hugoRow = students.getByRole('row').filter({ hasText: 'Hugo Hotel Ficticio' });
  await expect(hugoRow).toHaveCount(1);
  expect((await hugoRow.getByRole('cell').allTextContents()).slice(0, 4)).toEqual([
    '1',
    '0',
    '1',
    '0',
  ]); // listas, presentes, ausentes, sin marca
  const api = await page.request.get(
    `/api/school/attendance/reports/group?groupId=${groupC}&from=${s.today}&to=${s.today}`,
  );
  expect((await api.json()).totals).toMatchObject({
    withList: 1,
    finalized: 1,
    absent: 1,
    present: 0,
    noMark: 0,
  });

  await reportFor(page, '/asistencia/reportes/seguimiento', 'Consultar seguimiento');
  const follow = page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' });
  await expect(follow).toContainText(/Hugo/);
  await expect(follow).toContainText(/Hotel Ficticio/);
  await expect(follow).toContainText('1');
  // un alumno dado de baja o trasladado (Irma, ahora en 1.º D) no aparece en el padron de 1.º C
  await expect(follow).not.toContainText('India Ficticia');
  await logout(page);
});

test('5. Trabajo Social registra la recepcion de un justificante de Hugo sin alterar la asistencia ni el reporte', async ({
  page,
}) => {
  test.skip(WEEKEND(), 'Hoy es fin de semana: no hay falta registrada hoy');
  const before = await attendanceFingerprint();
  await loginAs(page, s.accounts.trabajoSocial);
  await page.goto('/justificantes');
  const form = page.getByRole('search', { name: 'Alumno', exact: true });
  await form.getByRole('searchbox').fill('Hotel');
  await form.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: 'Elegir a Hugo Hotel Ficticio' }).first().click();
  await page.getByLabel('Fecha escolar del justificante').fill(s.today);
  await page.getByRole('button', { name: 'Registrar recepción' }).click();
  const ok = page.getByRole('status').filter({ hasText: 'Folio' });
  await expect(ok).toContainText('Recepción registrada');
  await expect(ok).toContainText(NOTICE_RECEIPT);
  const rows = await db(
    async (q) =>
      (
        await q(
          `select folio, school_date::text d, status from justification_receipts where student_id = $1`,
          [hugo],
        )
      ).rows,
  );
  expect(rows).toEqual([expect.objectContaining({ d: s.today, status: 'received' })]);
  expect(await attendanceFingerprint()).toBe(before); // la asistencia no cambia
  await logout(page);

  // el reporte de Direccion sigue mostrando la falta
  await loginAs(page, s.accounts.direccion);
  const api = await page.request.get(
    `/api/school/attendance/reports/group?groupId=${groupC}&from=${s.today}&to=${s.today}`,
  );
  expect((await api.json()).totals).toMatchObject({ absent: 1, present: 0 });
  await logout(page);
});

test('6. Direccion revoca la asignacion: la prefecta pierde el acceso en la siguiente peticion; el historial se conserva', async ({
  browser,
  page,
}) => {
  // dos navegadores independientes: la prefecta con sesion abierta y Direccion que revoca
  const prefect = await browser.newContext();
  const pp = await prefect.newPage();
  try {
    await loginAs(pp, NEW_PREFECT.email, chosenPassword());
    expect((await pp.request.get(`/api/school/groups/${groupC}/roster`)).status()).toBe(200);

    await loginAs(page, s.accounts.direccion);
    await page.goto('/prefectura');
    const row = page
      .getByRole('list', { name: 'Asignaciones de prefectura' })
      .getByRole('listitem')
      .filter({ hasText: NEW_PREFECT.name });
    await row.getByRole('button', { name: /Revocar el acceso de/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Revocar acceso ahora' });
    await dlg.getByLabel('Motivo').fill('Cierre de la prueba E2E (dato ficticio)');
    await dlg.getByRole('button', { name: 'Revocar' }).click();
    await expect(row).toContainText('Revocada');
    expect(await assignments()).toEqual([expect.objectContaining({ code: 'C', revoked: true })]);
    expect(await auditCount('prefect_assignment.revoked', 'success')).toBeGreaterThanOrEqual(1);

    // inmediato: la sesion de la prefecta sigue viva, pero ya no autoriza el grupo
    expect((await pp.request.get(`/api/school/groups/${groupC}/roster`)).status()).toBe(404);
    const mine = await (await pp.request.get('/api/school/me/groups')).json();
    expect(mine.groups).toEqual([]);
    await pp.goto('/alumnos');
    await expect(pp.getByRole('list', { name: 'Alumnos' })).toHaveCount(0);
    // el historial NO se borro: la fila sigue, ahora revocada; la lista finalizada y su marca tampoco cambian
    expect(await assignments()).toHaveLength(1);
    if (!WEEKEND())
      expect(await dayOfC()).toEqual([expect.objectContaining({ status: 'finalized' })]);
    await logout(page);
  } finally {
    await prefect.close();
  }
});
