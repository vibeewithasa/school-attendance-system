import { expect, test, type Page } from '@playwright/test';
import { NOTICE_FOLLOWUP, db, loginAs, logout, state } from './support';

/**
 * E2E REAL — Direccion (cuenta ficticia con el rol real `direccion`): inicio de sesion por la interfaz, asistencia, reporte por grupo,
 * reporte por alumno y seguimiento de ausencias, verificados contra los registros reales del PostgreSQL desechable. Sin mocks.
 */
test.describe.configure({ mode: 'serial' });

let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

/** Ausencias, presentes y sin marca REALES por alumno del grupo A en el rango (consulta directa a la base desechable). */
async function expectedByStudent(group: string, from: string, to: string) {
  return db(
    async (q) =>
      (
        await q(
          `select st.id, st.given_names, st.family_name,
                count(*) filter (where r.status = 'absent')::int absent,
                count(*) filter (where r.status = 'present')::int present,
                count(*) filter (where r.status is null)::int pending,
                count(*)::int lists
           from attendance_records r
           join attendance_days d on d.id = r.attendance_day_id
           join enrollments e on e.id = r.enrollment_id
           join students st on st.id = e.student_id
          where d.group_id = $1 and d.attendance_date between $2 and $3
          group by st.id, st.given_names, st.family_name`,
          [group, from, to],
        )
      ).rows as Array<{
        id: string;
        given_names: string;
        family_name: string;
        absent: number;
        present: number;
        pending: number;
        lists: number;
      }>,
  );
}

async function stat(page: Page, label: string): Promise<string> {
  const totals = page.getByLabel('Totales del periodo');
  return (
    (await totals
      .locator('div', { has: page.getByText(label, { exact: true }) })
      .first()
      .locator('dd')
      .textContent()) ?? ''
  );
}

test('1-4. abrir el portal, iniciar sesion y llegar al panel y a Asistencia', async ({ page }) => {
  await page.goto('/');
  // Sin sesion el portal pide acceso (no muestra ningun dato escolar).
  await expect(page.getByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeVisible();
  await loginAs(page, s.accounts.direccion);
  await expect(page.getByRole('heading', { name: 'Bienvenida, bienvenido' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Principal' });
  for (const name of ['Asistencia', 'Reportes de asistencia', 'Alumnos', 'Justificantes'])
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Asistencia', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Asistencia', exact: true })).toBeVisible();
  // Listas recientes REALES: 4 de A y 1 de B (5 listas sembradas)
  const recent = page.getByRole('list', { name: 'Listas de asistencia recientes' });
  await expect(recent.getByRole('listitem')).toHaveCount(5);
  const drafts = await db(
    async (q) =>
      (await q(`select count(*)::int n from attendance_days where status = 'draft'`)).rows[0]!
        .n as number,
  );
  await expect(recent.getByText('Borrador', { exact: true })).toHaveCount(drafts);
});

test('5-11. reporte por grupo: ciclo, grupo y fechas; presentes, ausentes, sin marca y dias sin lista contra la base', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: 'Reportes de asistencia', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Reporte de asistencia por grupo' }),
  ).toBeVisible();
  await page
    .getByLabel('Ciclo escolar', { exact: true })
    .selectOption({ label: 'Ciclo E2E ficticio' });
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 }); // 1.º A (orden por grado y codigo)
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  const result = page.getByRole('region', { name: 'Resultado del reporte por grupo' });
  await expect(result).toBeVisible();

  const exp = await expectedByStudent(s.groups.A, s.weekdays[0], s.weekdays[4]);
  const sum = (k: 'absent' | 'present' | 'pending') => exp.reduce((a, r) => a + r[k], 0);
  expect([
    await stat(page, 'Presentes'),
    await stat(page, 'Ausentes'),
    await stat(page, 'Sin marca'),
  ]).toEqual([String(sum('present')), String(sum('absent')), String(sum('pending'))]);
  // 5 dias habiles: 3 listas finalizadas, 1 borrador y 1 dia SIN lista (no determinado, no es ausencia)
  const days = result.getByRole('table', { name: /Listas de asistencia del grupo por día hábil/ });
  await expect(days.getByRole('row')).toHaveCount(6); // encabezado + 5 dias
  await expect(days.getByText('Finalizada', { exact: true })).toHaveCount(3);
  await expect(days.getByText('Borrador', { exact: true })).toHaveCount(1);
  await expect(days.getByText('Sin lista', { exact: true })).toHaveCount(1);
  await expect(days.getByText('No determinado')).toHaveCount(1);
  expect(await stat(page, 'Días sin lista')).toBe('1');
  expect(await stat(page, 'Días con lista')).toBe('4');
  // por alumno: cada fila coincide con la base
  const students = result.getByRole('table', { name: /Marcas por alumno/ });
  for (const r of exp) {
    const row = students.getByRole('row').filter({ hasText: `${r.given_names} ${r.family_name}` });
    const cells = await row.getByRole('cell').allTextContents();
    expect(cells.slice(0, 4), `${r.given_names}`).toEqual([
      String(r.lists),
      String(r.present),
      String(r.absent),
      String(r.pending),
    ]);
  }
});

test('12-13. reporte por alumno: fechas y marca por dia contra los renglones reales', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/asistencia/reportes/alumno');
  await page
    .getByLabel('Ciclo escolar', { exact: true })
    .selectOption({ label: 'Ciclo E2E ficticio' });
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 });
  await expect(page.getByLabel('Alumno', { exact: true })).toBeEnabled();
  await page.getByLabel('Alumno', { exact: true }).selectOption({ value: s.students.ana });
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  const table = page.getByRole('table', { name: /Situación del alumno por día hábil/ });
  await expect(table).toBeVisible();
  const dbRows = await db(
    async (q) =>
      (
        await q(
          `select d.attendance_date::text d, r.status from attendance_records r
           join attendance_days d on d.id = r.attendance_day_id
           join enrollments e on e.id = r.enrollment_id
          where e.student_id = $1 order by 1`,
          [s.students.ana],
        )
      ).rows as Array<{ d: string; status: string | null }>,
  );
  const expected: Record<string, string> = Object.fromEntries(
    s.weekdays.map((d) => [d, dbRows.find((r) => r.d === d)?.status ?? 'none']),
  );
  const shown = (await table.getByRole('row').allTextContents()).slice(1);
  expect(shown).toHaveLength(5);
  const label = (st: string) =>
    st === 'absent' ? 'Ausente' : st === 'present' ? 'Presente' : 'Sin lista';
  s.weekdays.forEach((d, i) => expect(shown[i], d).toContain(label(expected[d]!)));
  // el dia sin lista es "Sin lista", jamas ausente
  expect(shown[2]).toContain('Sin lista');
  expect(shown[2]).not.toContain('Ausente');
});

test('14-19. seguimiento: orden por ausencias y por nombre, detalle individual y regreso conservando filtros', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: 'Reportes de asistencia', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Reportes de asistencia' })
    .getByRole('link', { name: 'Seguimiento de ausencias' })
    .click();
  await expect(page.getByRole('heading', { name: 'Seguimiento de ausencias' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText(NOTICE_FOLLOWUP);
  await page
    .getByLabel('Ciclo escolar', { exact: true })
    .selectOption({ label: 'Ciclo E2E ficticio' });
  await page.getByLabel('Grupo', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Desde', { exact: true }).fill(s.weekdays[0]);
  await page.getByLabel('Hasta', { exact: true }).fill(s.weekdays[4]);
  await page.getByRole('button', { name: 'Consultar seguimiento' }).click();
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).toBeVisible();

  const exp = await expectedByStudent(s.groups.A, s.weekdays[0], s.weekdays[4]);
  const rank = (cmp: (a: (typeof exp)[number], b: (typeof exp)[number]) => number) =>
    [...exp]
      .sort(
        (a, b) =>
          cmp(a, b) ||
          a.family_name.localeCompare(b.family_name, 'es') ||
          a.given_names.localeCompare(b.given_names, 'es'),
      )
      .map((r) => `${r.family_name} ${r.given_names}`);
  const order = async () =>
    (await page.getByRole('table').getByRole('row').locator('th[scope=row]').allTextContents()).map(
      (t) => t.trim(),
    );

  // 15. orden inicial = mayor numero de ausencias registradas (con desempate por nombre)
  expect(await order()).toEqual(rank((a, b) => b.absent - a.absent));
  const firstRow = page.getByRole('table').getByRole('row').nth(1);
  expect((await firstRow.getByRole('cell').first().textContent())!.trim()).toBe(
    String(Math.max(...exp.map((r) => r.absent))),
  );
  // 16. menor numero de ausencias
  await page.getByLabel('Ordenar por', { exact: true }).selectOption('absences_asc');
  expect(await order()).toEqual(rank((a, b) => a.absent - b.absent));
  // 17. por nombre
  await page.getByLabel('Ordenar por', { exact: true }).selectOption('name');
  expect(await order()).toEqual(rank(() => 0));
  // las ausencias de cada alumno coinciden con la base y "sin marca" NO es ausencia
  for (const r of exp) {
    const cells = await page
      .getByRole('table')
      .getByRole('row')
      .filter({ hasText: r.given_names })
      .getByRole('cell')
      .allTextContents();
    expect(cells.slice(0, 4), r.given_names).toEqual([
      String(r.absent),
      String(r.present),
      String(r.pending),
      String(r.lists),
    ]);
  }
  await expect(page.getByRole('group', { name: 'Estado de los datos del periodo' })).toContainText(
    'Datos incompletos',
  );
  // ni alertas, ni acciones, ni niveles de riesgo
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).not.toContainText(/riesgo|alerta|sanci|cr[ií]tico/i);

  // 18-19. detalle individual y regreso con filtros conservados
  await page.getByLabel('Ordenar por', { exact: true }).selectOption('absences_desc');
  await page.getByRole('link', { name: /Ver reporte de Ana Alfa Ficticia/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Reporte de asistencia por alumno' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: /Situación del alumno por día hábil/ }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Seguimiento de ausencias' })).toBeVisible();
  await expect(page.getByLabel('Grupo', { exact: true })).toHaveValue(s.groups.A);
  await expect(page.getByLabel('Desde', { exact: true })).toHaveValue(s.weekdays[0]);
  await expect(page.getByLabel('Hasta', { exact: true })).toHaveValue(s.weekdays[4]);
  await expect(
    page.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
  ).toBeVisible();
  await expect(page.getByLabel('Ordenar por', { exact: true })).toHaveValue('absences_desc');

  // 20. cerrar sesion
  await logout(page);
  await page.goto('/asistencia/reportes/seguimiento');
  await expect(page.getByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeVisible();
});
