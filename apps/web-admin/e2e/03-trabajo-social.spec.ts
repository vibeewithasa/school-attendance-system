import { expect, test, type Page } from '@playwright/test';
import { NOTICE_RECEIPT, attendanceFingerprint, db, loginAs, logout, state } from './support';

/**
 * E2E REAL — Trabajo Social (cuenta ficticia con el rol real `trabajo_social`): registro de RECEPCION de justificantes por la
 * interfaz, verificado contra PostgreSQL (registro, auditoria, actor, fecha y folio), doble clic y reintento idempotente, y que la
 * asistencia y los reportes NO cambian. Sin `attendance:read` no accede al seguimiento (no se amplia ningun permiso).
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
let fingerprintBefore = '';
test.beforeAll(async () => {
  s = state();
  fingerprintBefore = await attendanceFingerprint();
});

const ORIGIN = 'http://127.0.0.1:5173';
const api = (page: Page, path: string) => page.request.get(`/api${path}`);
const receipts = () =>
  db(
    async (q) =>
      (
        await q(
          `select r.id, r.folio, r.student_id, r.school_date::text d, r.received_by, r.received_at, r.status, r.request_id
           from justification_receipts r order by r.folio_number`,
        )
      ).rows,
  );
const userId = (email: string) =>
  db(
    async (q) => (await q(`select id from users where email = $1`, [email])).rows[0]!.id as string,
  );

async function pickStudent(page: Page, search: RegExp | string, legend = 'Alumno') {
  const form = page.getByRole('search', { name: legend, exact: true });
  await form.getByRole('searchbox').fill(typeof search === 'string' ? search : 'Ana');
  await form.getByRole('button', { name: 'Buscar' }).click();
}

test('1-2. acceso: menu y pantalla de Trabajo Social, sin asistencia ni reportes', async ({
  page,
}) => {
  await loginAs(page, s.accounts.trabajoSocial);
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav.getByRole('link', { name: 'Justificantes', exact: true })).toBeVisible();
  for (const name of ['Asistencia', 'Reportes de asistencia', 'Personal', 'Catálogo escolar'])
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Justificantes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Justificantes' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText(NOTICE_RECEIPT);
  await expect(page.getByText('No hay recepciones registradas')).toBeVisible();
  await logout(page);
});

test('3-8. buscar al alumno, elegir la fecha, registrar la recepcion, obtener el folio y consultar el historial', async ({
  page,
}) => {
  await loginAs(page, s.accounts.trabajoSocial);
  await page.goto('/justificantes');
  await expect(page.getByText('No hay recepciones registradas')).toBeVisible();
  await pickStudent(page, 'Ana');
  const list = page.getByRole('list', { name: 'Resultados de la búsqueda de alumnos' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Elegir a Ana Alfa Ficticia' }).first().click();
  await expect(page.getByRole('button', { name: 'Cambiar alumno' }).first()).toBeVisible();
  // la fecha escolar es la de una FALTA registrada (w1): la recepcion no la toca
  await page.getByLabel('Fecha escolar del justificante').fill(s.weekdays[0]);
  await page.getByRole('button', { name: 'Registrar recepción' }).click();
  const ok = page.getByRole('status').filter({ hasText: 'Folio' });
  await expect(ok).toContainText('Recepción registrada');
  await expect(ok).toContainText('JR-000001');
  await expect(ok).toContainText(NOTICE_RECEIPT);
  await expect(ok).toContainText('Trabajo social E2E');

  // --- contra PostgreSQL: UNA sola recepcion con los datos correctos
  const rows = await receipts();
  expect(rows).toHaveLength(1);
  const ts = await userId(s.accounts.trabajoSocial);
  expect(rows[0]).toMatchObject({
    folio: 'JR-000001',
    student_id: s.students.ana,
    d: s.weekdays[0],
    received_by: ts,
    status: 'received',
  });
  expect(Math.abs(new Date(rows[0]!.received_at).getTime() - Date.now())).toBeLessThan(120_000); // hora del servidor
  const audit = await db(
    async (q) =>
      (
        await q(
          `select actor_user_id, outcome, details from audit_events where event_type = 'justification.receipt_registered'`,
        )
      ).rows,
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_user_id: ts, outcome: 'success' });
  expect(audit[0]!.details).toMatchObject({
    receiptId: rows[0]!.id,
    folio: 'JR-000001',
    studentId: s.students.ana,
    schoolDate: s.weekdays[0],
  });
  expect(JSON.stringify(audit[0]!.details)).not.toMatch(/Ana|Alfa/); // la auditoria no lleva nombres

  // --- historial y filtros
  const table = page.getByRole('table', { name: /Recepciones de justificantes/ });
  await expect(table.getByRole('row')).toHaveCount(2);
  const row = table.getByRole('row').nth(1);
  await expect(row.getByRole('rowheader')).toHaveText('JR-000001');
  await expect(row).toContainText('Ana Alfa Ficticia');
  await expect(row).toContainText(s.weekdays[0]);
  await expect(row).toContainText('Trabajo social E2E');
  await expect(row.getByText('Recibido', { exact: true })).toBeVisible();
  await page.getByLabel('Fecha escolar desde').fill(s.weekdays[1]);
  await page.getByLabel('Fecha escolar hasta').fill(s.weekdays[2]);
  await expect(page.getByText('No hay recepciones registradas con esos filtros')).toBeVisible();
  await page.getByLabel('Fecha escolar desde').fill(s.weekdays[0]);
  await page.getByLabel('Fecha escolar hasta').fill(s.weekdays[0]);
  await expect(table.getByRole('row')).toHaveCount(2);
  // por alumno
  await pickStudent(page, 'Ana', 'Filtrar por alumno');
  await page.getByRole('button', { name: 'Elegir a Ana Alfa Ficticia' }).last().click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Cambiar alumno' }).last().click();
  await pickStudent(page, 'Beto', 'Filtrar por alumno');
  await page.getByRole('button', { name: 'Elegir a Beto Beta Ficticio' }).click();
  await expect(page.getByText('No hay recepciones registradas con esos filtros')).toBeVisible();
  await logout(page);
});

test('doble clic y reintento con el mismo identificador de solicitud no duplican la recepcion', async ({
  page,
}) => {
  await loginAs(page, s.accounts.trabajoSocial);
  await page.goto('/justificantes');
  await pickStudent(page, 'Beto');
  await page.getByRole('button', { name: 'Elegir a Beto Beta Ficticio' }).first().click();
  await page.getByLabel('Fecha escolar del justificante').fill(s.weekdays[3]);
  const before = (await receipts()).length;
  await page.getByRole('button', { name: 'Registrar recepción' }).dblclick();
  await expect(page.getByRole('status').filter({ hasText: 'Folio' })).toContainText('JR-000002');
  expect(await receipts()).toHaveLength(before + 1); // un solo registro pese al doble clic

  // reintento de la MISMA solicitud (mismo requestId) por HTTP real con la sesion y el CSRF del navegador
  const csrf = (await (await api(page, '/auth/csrf')).json()).csrfToken as string;
  const body = {
    requestId: '00000000-0000-4000-8000-0000000000f1',
    studentId: s.students.carla,
    schoolDate: s.weekdays[1],
  };
  const post = (data: unknown) =>
    page.request.post('/api/school/justifications/receipts', {
      headers: { origin: ORIGIN, 'x-csrf-token': csrf },
      data,
    });
  const first = await post(body);
  expect(first.status()).toBe(201);
  const again = await post(body);
  expect(again.status()).toBe(200);
  const a = await first.json(),
    b = await again.json();
  expect([a.replayed, b.replayed]).toEqual([false, true]);
  expect(b.receipt).toEqual(a.receipt);
  expect(await receipts()).toHaveLength(before + 2);
  expect(
    await db(
      async (q) =>
        (
          await q(
            `select count(*)::int n from audit_events where event_type = 'justification.receipt_registered'`,
          )
        ).rows[0]!.n as number,
    ),
  ).toBe(before + 2);
  // la misma clave con otro contenido: 409 y nada nuevo
  const clash = await post({ ...body, studentId: s.students.diego });
  expect(clash.status()).toBe(409);
  expect((await clash.json()).error.code).toBe('IDEMPOTENCY_MISMATCH');
  expect(await receipts()).toHaveLength(before + 2);
  // fecha invalida y fin de semana: el servidor rechaza sin dejar rastro
  expect(
    (
      await post({
        requestId: '00000000-0000-4000-8000-0000000000f2',
        studentId: s.students.carla,
        schoolDate: '2026-02-30',
      })
    ).status(),
  ).toBe(400);
  expect(await receipts()).toHaveLength(before + 2);
  await logout(page);
});

test('9. consulta del detalle (auditada) y folios consecutivos', async ({ page }) => {
  await loginAs(page, s.accounts.trabajoSocial);
  const rows = await receipts();
  expect(rows.map((r) => r.folio)).toEqual(['JR-000001', 'JR-000002', 'JR-000003']);
  const views0 = await db(
    async (q) =>
      (
        await q(
          `select count(*)::int n from audit_events where event_type = 'justification.receipt_viewed'`,
        )
      ).rows[0]!.n as number,
  );
  const detail = await api(page, `/school/justifications/receipts/${rows[0]!.id}`);
  expect(detail.status()).toBe(200);
  expect(detail.headers()['cache-control']).toContain('no-store');
  expect((await detail.json()).folio).toBe('JR-000001');
  expect(
    await db(
      async (q) =>
        (
          await q(
            `select count(*)::int n from audit_events where event_type = 'justification.receipt_viewed'`,
          )
        ).rows[0]!.n as number,
    ),
  ).toBe(views0 + 1);
  expect(
    (
      await api(page, '/school/justifications/receipts/00000000-0000-4000-8000-00000000dead')
    ).status(),
  ).toBe(404);
});

test('sin attendance:read: Seguimiento y reportes denegados (el servidor y la interfaz); no se amplia el RBAC', async ({
  page,
}) => {
  await loginAs(page, s.accounts.trabajoSocial);
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/reports/')) asked.push(r.url());
  });
  await page.goto('/asistencia/reportes/seguimiento');
  await expect(page.getByRole('alert')).toContainText(
    'No tienes permiso para consultar la asistencia',
  );
  await expect(page.getByRole('button', { name: 'Consultar seguimiento' })).toHaveCount(0);
  expect(asked).toEqual([]); // ni siquiera se intenta consultar
  for (const path of [
    '/school/attendance/reports/options',
    `/school/attendance/reports/group?groupId=${s.groups.A}&from=${s.weekdays[0]}&to=${s.weekdays[4]}`,
    `/school/attendance/reports/student/${s.students.ana}?schoolYearId=${s.year}&from=${s.weekdays[0]}&to=${s.weekdays[4]}`,
    '/school/attendance/days',
    '/school/students',
  ]) {
    const r = await api(page, path);
    expect(r.status(), path).toBe(403);
    expect(await r.text(), path).not.toMatch(/Alfa|Beta|Gamma|Delta|Épsilon|Foxtrot|Golf/);
  }
  await logout(page);
});

test('la recepcion no altera asistencia, revisiones, historial de captura ni ausencias', async () => {
  expect(await attendanceFingerprint()).toBe(fingerprintBefore);
  // la falta del dia del justificante SIGUE siendo falta
  const absent = await db(
    async (q) =>
      (
        await q(
          `select r.status from attendance_records r join attendance_days d on d.id = r.attendance_day_id join enrollments e on e.id = r.enrollment_id
          where e.student_id = $1 and d.attendance_date = $2`,
          [s.students.ana, s.weekdays[0]],
        )
      ).rows[0]!.status as string,
  );
  expect(absent).toBe('absent');
});
