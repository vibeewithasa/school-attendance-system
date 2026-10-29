import { expect, test } from '@playwright/test';
import { db, loginAs, logout, state } from './support';

/**
 * E2E REAL — despues de que Trabajo Social registro recepciones de justificantes (03), Direccion vuelve a consultar los reportes: los
 * conteos de ausencias NO cambian (los justificantes recibidos no descuentan nada; D-10 sigue pendiente) y ningun reporte menciona
 * justificantes. Se ejecuta tras 03 (orden alfabetico, un solo trabajador).
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

test('con recepciones registradas, el reporte, el individual y el seguimiento conservan las ausencias', async ({
  page,
}) => {
  const receipts = await db(
    async (q) =>
      (await q(`select count(*)::int n from justification_receipts`)).rows[0]!.n as number,
  );
  expect(receipts).toBeGreaterThanOrEqual(3); // creadas por la interfaz en el escenario de Trabajo Social
  await loginAs(page, s.accounts.direccion);
  const range = `from=${s.weekdays[0]}&to=${s.weekdays[4]}`;

  // reporte por grupo por la API real: Ana (que tiene recepciones del dia de sus faltas) conserva 3 ausencias
  const group = await page.request.get(
    `/api/school/attendance/reports/group?groupId=${s.groups.A}&${range}`,
  );
  expect(group.status()).toBe(200);
  expect(group.headers()['cache-control']).toContain('no-store');
  const g = await group.json();
  const ana = g.students.find((x: { studentId: string }) => x.studentId === s.students.ana);
  expect(ana).toMatchObject({ absent: 3, present: 1, noMark: 0, listsApplicable: 4 });
  expect(g.totals).toMatchObject({ absent: 7, present: 12, noMark: 1, studentDays: 20 });
  expect(JSON.stringify(g)).not.toMatch(/justif|folio|JR-/i);

  // el dia de la recepcion (w1) sigue siendo AUSENTE en el reporte individual
  const st = await (
    await page.request.get(
      `/api/school/attendance/reports/student/${s.students.ana}?schoolYearId=${s.year}&${range}`,
    )
  ).json();
  expect(st.days[0]).toMatchObject({ date: s.weekdays[0], state: 'absent' });
  expect(st.totals).toMatchObject({ absent: 3, present: 1, noList: 1 });
  expect(JSON.stringify(st)).not.toMatch(/justif|folio|JR-/i);

  // y la pantalla de seguimiento lo muestra igual
  await page.goto(
    `/asistencia/reportes/seguimiento?ciclo=${s.year}&grupo=${s.groups.A}&desde=${s.weekdays[0]}&hasta=${s.weekdays[4]}`,
  );
  const first = page.getByRole('table').getByRole('row').nth(1);
  await expect(first).toContainText('Alfa Ficticia Ana');
  await expect(first.getByRole('cell').first()).toHaveText('3');
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).not.toContainText(/justific|folio|JR-/i);
  await logout(page);
});
