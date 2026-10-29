import { expect, test } from '@playwright/test';
import { db, loginAs, logout, state } from './support';

/**
 * E2E REAL — captura de la lista de HOY desde el portal por la prefectura asignada (flujo de pruebas del portal; la captura oficial
 * prevista es Android). El servidor decide la fecha (hoy, America/Mazatlan): en sabado o domingo no se abre lista y la prueba se
 * omite. Verifica contra los registros reales: padron congelado, marcas, borrador y finalizacion, y que Direccion (que no captura) la ve.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const schoolDow = () =>
  new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date())}T00:00:00Z`,
  ).getUTCDay();

test('la prefectura B abre la lista de hoy de su grupo, marca, guarda el borrador y la finaliza', async ({
  page,
}) => {
  test.skip(
    [0, 6].includes(schoolDow()),
    'Hoy es fin de semana: no se abren listas (regla de la escuela)',
  );
  await loginAs(page, s.accounts.prefecturaB);
  await page.goto('/asistencia');
  await expect(page.getByRole('heading', { name: /Hoy:/ })).toBeVisible();
  const groups = page.getByRole('list', { name: 'Grupos del día' });
  await expect(groups.getByRole('listitem')).toHaveCount(1); // solo SU grupo
  await page.getByRole('button', { name: /Abrir la lista de 1\.º B/ }).click();

  // padron congelado: los dos alumnos del grupo B, pendientes
  const list = page.getByRole('list', { name: 'Alumnos de la lista' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Finalizar lista' })).toBeDisabled(); // con pendientes no se finaliza
  const today = await db(
    async (q) =>
      (
        await q(
          `select d.id, d.status, d.attendance_date::text d, (select count(*)::int from attendance_records r where r.attendance_day_id = d.id and r.status is null) pending
                from attendance_days d where d.group_id = $1 order by d.attendance_date desc limit 1`,
          [s.groups.B],
        )
      ).rows[0]!,
  );
  expect(today).toMatchObject({ status: 'draft', pending: 2 });

  await page
    .getByRole('radiogroup', { name: 'Asistencia de Fabi Foxtrot Ficticia' })
    .getByText('Ausente', { exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Asistencia de Gael Golf Ficticio' })
    .getByText('Presente', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Guardar borrador' }).click();
  await expect(page.getByRole('status').filter({ hasText: /guard/i }).first()).toBeVisible();
  const saved = await db(
    async (q) =>
      (
        await q(
          `select st.family_name n, r.status from attendance_records r join enrollments e on e.id = r.enrollment_id join students st on st.id = e.student_id where r.attendance_day_id = $1 order by 1`,
          [today.id],
        )
      ).rows,
  );
  expect(saved).toEqual([
    { n: 'Foxtrot Ficticia', status: 'absent' },
    { n: 'Golf Ficticio', status: 'present' },
  ]);

  await page.getByRole('button', { name: 'Finalizar lista' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finalizar', exact: true }).click();
  await expect(page.getByText(/finalizada/i).first()).toBeVisible();
  const finalized = await db(
    async (q) =>
      (await q(`select status, revision from attendance_days where id = $1`, [today.id])).rows[0]!,
  );
  expect(finalized.status).toBe('finalized');
  // las marcas del historial se agregaron (solo-agregar) y la lista ya no se puede editar desde el portal
  expect(
    await db(
      async (q) =>
        (
          await q(`select count(*)::int n from attendance_events where attendance_day_id = $1`, [
            today.id,
          ])
        ).rows[0]!.n as number,
    ),
  ).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('button', { name: 'Guardar borrador' })).toHaveCount(0);
  await logout(page);
});

test('Direccion ve la lista de hoy (solo consulta) y los reportes incluyen la captura nueva', async ({
  page,
}) => {
  test.skip([0, 6].includes(schoolDow()), 'Hoy es fin de semana: no se abren listas');
  await loginAs(page, s.accounts.direccion);
  await page.goto('/asistencia');
  await expect(page.getByRole('button', { name: /Abrir la lista/ })).toHaveCount(0); // Direccion supervisa, no captura
  const today = s.today;
  const group = await page.request.get(
    `/api/school/attendance/reports/group?groupId=${s.groups.B}&from=${today}&to=${today}`,
  );
  expect(group.status()).toBe(200);
  const g = await group.json();
  expect(g.totals).toMatchObject({ withList: 1, finalized: 1, absent: 1, present: 1, noMark: 0 });
  await logout(page);
});
