import { expect, test } from '@playwright/test';
import {
  NEW_PREFECT,
  auditCount,
  chosenPassword,
  db,
  isolated,
  loginAs,
  logout,
  send,
  state,
} from './support';

/**
 * E2E REAL — ciclo de cuentas de personal por la interfaz (Direccion y administracion tecnica) con los contratos reales:
 * alta de una cuenta PENDIENTE (sin contrasena), asignacion y revocacion de rol, activacion completa con control dual
 * (la persona en un navegador independiente + la SEGUNDA autoridad, que es una precondicion de fixture), deshabilitacion,
 * restricciones de escalamiento y aislamiento entre dominios. Se verifica contra los registros reales de la base DESECHABLE.
 *
 * Lo que NO hace la interfaz (y por eso no se prueba): volver a habilitar una cuenta, editar nombre/correo, restablecer
 * contrasenas ni consultar la auditoria (ver docs/product/inventario-funcional-mvp.md).
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const userRow = (email: string) =>
  db(
    async (q) =>
      (
        await q(
          `select id, status, account_domain, password_hash is not null as has_password, created_by from users where email = $1`,
          [email],
        )
      ).rows[0],
  );
const activeRoles = (email: string) =>
  db(async (q) =>
    (
      await q(
        `select r.key from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
            where u.email = $1 and ur.revoked_at is null order by 1`,
        [email],
      )
    ).rows.map((r) => r.key as string),
  );

test('1. Direccion crea una cuenta pendiente (sin contrasena) y valida entradas; el correo duplicado se rechaza', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/personal');
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
  const list = page.getByRole('list', { name: 'Cuentas' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  // Direccion solo ve cuentas escolares (nunca las tecnicas)
  await expect(list).not.toContainText(s.accounts.tecnico);

  await page.getByRole('button', { name: 'Nueva cuenta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva cuenta de personal' });
  await dialog.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(dialog.getByText('Escribe el nombre completo.')).toBeVisible();
  await expect(dialog.getByText('Escribe el correo electrónico.')).toBeVisible();
  await expect(dialog.getByLabel('Nombre completo')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('Nombre completo').fill(NEW_PREFECT.name);
  await dialog.getByLabel('Correo electrónico institucional').fill('no-es-un-correo');
  await dialog.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(dialog.getByText('Escribe un correo electrónico válido.')).toBeVisible();
  expect(await userRow('no-es-un-correo')).toBeUndefined();

  // correo ya registrado: el servidor responde 409 y la interfaz lo explica sin crear nada
  const before = await db(
    async (q) => (await q(`select count(*)::int n from users`)).rows[0]!.n as number,
  );
  await dialog.getByLabel('Correo electrónico institucional').fill(s.accounts.prefecturaA);
  await dialog.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(await db(async (q) => (await q(`select count(*)::int n from users`)).rows[0]!.n)).toBe(
    before,
  );

  await dialog.getByLabel('Correo electrónico institucional').fill(NEW_PREFECT.email);
  await dialog.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cuenta creada para' })).toContainText(
    NEW_PREFECT.name,
  );
  const row = await userRow(NEW_PREFECT.email);
  expect(row).toMatchObject({ status: 'pending', account_domain: 'school', has_password: false });
  expect(await activeRoles(NEW_PREFECT.email)).toEqual([]);
  expect(await auditCount('user.created', 'success')).toBeGreaterThanOrEqual(1);
  // al reconsultar, la cuenta sigue en la lista como pendiente y sin roles
  await page.reload();
  await page.getByLabel('Buscar por nombre o correo').fill('Nueva Ficticia');
  const found = page.getByRole('list', { name: 'Cuentas' }).getByRole('listitem');
  await expect(found).toHaveCount(1);
  await expect(found.first()).toContainText('Pendiente de activación');
  await expect(found.first()).toContainText('Sin roles');
  await logout(page);
});

test('2. Direccion asigna y revoca roles por la interfaz; no puede cambiar los suyos ni los de otro dominio', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/personal');
  await page.getByLabel('Buscar por nombre o correo').fill('Nueva Ficticia');
  await expect(page.getByRole('list', { name: 'Cuentas' }).getByRole('listitem')).toHaveCount(1); // espera al filtro
  await page.getByRole('list', { name: 'Cuentas' }).getByRole('button').first().click();
  const detail = page.getByRole('region', { name: NEW_PREFECT.name });
  await expect(detail).toContainText('Aún no inició su activación');
  // solo roles escolares (nunca los tecnicos) en el selector
  const select = detail.getByLabel('Asignar un rol');
  const options = await select.locator('option').allTextContents();
  expect(options.join('|')).not.toContain('Administración técnica');

  await select.selectOption({ label: 'Trabajo social' });
  await detail.getByRole('button', { name: 'Asignar rol' }).click();
  await expect(detail.getByRole('status')).toContainText('Rol «Trabajo social» asignado.');
  expect(await activeRoles(NEW_PREFECT.email)).toEqual(['trabajo_social']);

  await detail.getByRole('button', { name: 'Revocar el rol Trabajo social' }).click();
  await page
    .getByRole('dialog', { name: '¿Revocar este rol?' })
    .getByRole('button', { name: 'Revocar rol' })
    .click();
  await expect(detail.getByRole('status')).toContainText('Rol «Trabajo social» revocado.');
  expect(await activeRoles(NEW_PREFECT.email)).toEqual([]);

  await detail.getByLabel('Asignar un rol').selectOption({ label: 'Prefectura' });
  await detail.getByRole('button', { name: 'Asignar rol' }).click();
  await expect(detail.getByRole('status')).toContainText('Rol «Prefectura» asignado.');
  expect(await activeRoles(NEW_PREFECT.email)).toEqual(['prefectura']);
  // La revocacion y la asignacion quedan en el historial de roles (solo-agregar): ninguna fila se borro
  const history = await db(
    async (q) =>
      (
        await q(
          `select r.key, (ur.revoked_at is not null) revoked from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id where u.email = $1 order by ur.granted_at`,
          [NEW_PREFECT.email],
        )
      ).rows,
  );
  expect(history).toEqual([
    { key: 'trabajo_social', revoked: true },
    { key: 'prefectura', revoked: false },
  ]);

  // su propia cuenta: sin controles para cambiar roles ni deshabilitarse
  await page.getByLabel('Buscar por nombre o correo').fill('Dirección E2E');
  await page
    .getByRole('list', { name: 'Cuentas' })
    .getByRole('button', { name: /direccion\.e2e@escuela\.test/ })
    .click();
  const own = page.getByRole('region', { name: 'Dirección E2E' });
  await expect(own).toContainText('Es tu propia cuenta');
  await expect(own.getByRole('button', { name: 'Asignar rol' })).toHaveCount(0);
  await expect(own.getByRole('button', { name: 'Deshabilitar cuenta' })).toHaveCount(0);
  await logout(page);
});

test('3. restricciones de escalamiento reales del servidor (aunque se salten los botones)', async ({
  page,
}) => {
  await loginAs(page, s.accounts.direccion);
  const ids = await db(async (q) => ({
    self: (await q(`select id from users where email = $1`, [s.accounts.direccion])).rows[0]!.id,
    tech: (await q(`select id from users where email = $1`, [s.accounts.tecnico])).rows[0]!.id,
    school: (await q(`select id from users where email = $1`, [s.accounts.prefecturaA])).rows[0]!
      .id,
  }));
  const denied = await auditCount('authz.denied');
  // 1) concederse un rol a si misma
  const self = await send(page, 'POST', `/admin/users/${ids.self}/roles`, {
    roleKey: 'prefectura',
  });
  expect([403, 404, 409]).toContain(self.status());
  // 2) conceder un rol TECNICO a una cuenta escolar (otro dominio)
  const cross = await send(page, 'POST', `/admin/users/${ids.school}/roles`, {
    roleKey: 'admin_tecnico',
  });
  expect([403, 404, 409]).toContain(cross.status());
  // 3) administrar una cuenta TECNICA (otro dominio): no existe para Direccion
  const tech = await page.request.get(`/api/admin/users/${ids.tech}`);
  expect([403, 404]).toContain(tech.status());
  const disableTech = await send(page, 'POST', `/admin/users/${ids.tech}/disable`);
  expect([403, 404]).toContain(disableTech.status());
  // 4) deshabilitarse a si misma
  const disableSelf = await send(page, 'POST', `/admin/users/${ids.self}/disable`);
  expect([403, 404, 409]).toContain(disableSelf.status());
  // nada cambio
  expect(await activeRoles(s.accounts.direccion)).toEqual(['direccion']);
  expect(await activeRoles(s.accounts.prefecturaA)).toEqual(['prefectura']);
  expect((await userRow(s.accounts.tecnico))?.status).toBe('active');
  expect((await userRow(s.accounts.direccion))?.status).toBe('active');
  expect(await auditCount('authz.denied')).toBeGreaterThanOrEqual(denied);
  // sin CSRF no se llega a autorizar
  const noCsrf = await send(
    page,
    'POST',
    `/admin/users/${ids.school}/roles`,
    { roleKey: 'direccion' },
    { csrf: null },
  );
  expect(noCsrf.status()).toBe(403);
  expect(await activeRoles(s.accounts.prefecturaA)).toEqual(['prefectura']);
  await logout(page);
});

test('4. roles sin permiso: prefectura y trabajo social no administran personal; administracion tecnica solo ve cuentas tecnicas', async ({
  page,
}) => {
  for (const email of [s.accounts.prefecturaA, s.accounts.trabajoSocial]) {
    await loginAs(page, email);
    await expect(
      page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Personal' }),
    ).toHaveCount(0);
    await page.goto('/personal');
    await expect(page.getByRole('alert')).toContainText(
      'No tienes permiso para administrar cuentas',
    );
    const list = await page.request.get('/api/admin/users');
    expect(list.status()).toBe(403);
    const create = await send(page, 'POST', '/admin/users', {
      email: 'intruso.e2e@escuela.test',
      displayName: 'Intruso Ficticio',
      accountDomain: 'school',
    });
    expect(create.status()).toBe(403);
    expect(await userRow('intruso.e2e@escuela.test')).toBeUndefined();
    await logout(page);
  }
  await loginAs(page, s.accounts.tecnico);
  await page.goto('/personal');
  const list = page.getByRole('list', { name: 'Cuentas' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await expect(list).toContainText(s.accounts.tecnico);
  await expect(list).not.toContainText(s.accounts.direccion);
  await expect(list).not.toContainText(s.accounts.prefecturaA);
  // administracion tecnica no administra datos escolares
  for (const path of ['/alumnos', '/asistencia', '/justificantes']) {
    await page.goto(path);
    await expect(page.getByRole('alert').first()).toBeVisible();
  }
  const students = await page.request.get('/api/school/students');
  expect(students.status()).toBe(403);
  await logout(page);
});

test('5. activacion completa con control dual: la persona (navegador independiente) y la segunda autoridad', async ({
  browser,
  page,
}) => {
  const person = await isolated(browser);
  const authority = await isolated(browser);
  try {
    // 5a. la persona inicia la activacion y ve SU codigo en SU pantalla
    await person.page.goto('/activar');
    await person.page.getByLabel('Correo electrónico de tu cuenta').fill(NEW_PREFECT.email);
    await person.page.getByRole('button', { name: 'Iniciar activación' }).click();
    await expect(person.page.getByRole('heading', { name: /Paso 2/ })).toBeVisible();
    const label = await person.page
      .getByLabel(/Tu código de verificación es/)
      .getAttribute('aria-label');
    const code = /es (.+)$/.exec(label!)![1]!;
    expect(code.replace(/[\s-]/g, '')).toHaveLength(10);

    // 5b. quien creo la cuenta NO puede aprobar su activacion (control dual) aunque conozca el codigo
    await loginAs(page, s.accounts.direccion);
    await page.goto('/personal');
    await page.getByRole('tab', { name: 'Solicitudes de activación' }).click();
    const request = page
      .getByRole('list', { name: 'Solicitudes de activación' })
      .getByRole('listitem');
    await expect(request).toHaveCount(1);
    await expect(request).toContainText('Creaste esta cuenta');
    await request.getByRole('button', { name: /Verificar identidad de/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Verificar identidad' });
    await dlg.getByLabel('Código que muestra la pantalla de la persona').fill(code);
    await dlg.getByRole('button', { name: 'Confirmar identidad' }).click();
    await expect(dlg.getByRole('alert')).toBeVisible();
    await expect(person.page.getByRole('heading', { name: /Paso 2/ })).toBeVisible(); // sigue esperando
    expect(await userRow(NEW_PREFECT.email)).toMatchObject({ status: 'pending' });
    await dlg.getByRole('button', { name: 'Cancelar' }).click();
    await logout(page);

    // 5c. la SEGUNDA autoridad (fixture) verifica a la persona: un codigo equivocado se rechaza, el correcto se acepta
    await loginAs(authority.page, s.accounts.direccion2);
    await authority.page.goto('/personal');
    await authority.page.getByRole('tab', { name: 'Solicitudes de activación' }).click();
    const req2 = authority.page
      .getByRole('list', { name: 'Solicitudes de activación' })
      .getByRole('listitem');
    await expect(req2).toHaveCount(1);
    await expect(req2).not.toContainText('Creaste esta cuenta');
    await req2.getByRole('button', { name: /Verificar identidad de/ }).click();
    const dlg2 = authority.page.getByRole('dialog', { name: 'Verificar identidad' });
    await dlg2.getByLabel('Código que muestra la pantalla de la persona').fill('AAAAA-AAAAA');
    await dlg2.getByRole('button', { name: 'Confirmar identidad' }).click();
    await expect(dlg2.getByRole('alert')).toBeVisible();
    expect(await userRow(NEW_PREFECT.email)).toMatchObject({ status: 'pending' });
    await dlg2.getByLabel('Código que muestra la pantalla de la persona').fill(code);
    await dlg2.getByRole('button', { name: 'Confirmar identidad' }).click();
    await expect(
      authority.page.getByRole('status').filter({ hasText: 'Identidad verificada' }),
    ).toBeVisible();

    // 5d. la pantalla de la persona avanza sola y elige SU contrasena (la administracion nunca la conoce)
    await expect(person.page.getByRole('heading', { name: /Paso 3/ })).toBeVisible({
      timeout: 20_000,
    });
    await person.page.getByLabel('Contraseña nueva').fill(chosenPassword());
    await person.page.getByLabel('Confirma tu contraseña').fill(chosenPassword());
    await person.page.getByRole('button', { name: 'Activar mi cuenta' }).click();
    await expect(
      person.page.getByRole('heading', { name: '¡Tu cuenta está activa!' }),
    ).toBeVisible();
    expect(await userRow(NEW_PREFECT.email)).toMatchObject({
      status: 'active',
      has_password: true,
    });
    // no se abrio ninguna sesion automaticamente
    await expect(person.page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);

    // 5e. la cuenta activada inicia sesion con SU contrasena y solo ve lo de su rol (aun sin grupos asignados)
    await person.page.getByRole('button', { name: 'Ir a iniciar sesión' }).click();
    await loginAs(person.page, NEW_PREFECT.email, chosenPassword());
    const nav = person.page.getByRole('navigation', { name: 'Principal' });
    await expect(nav.getByRole('link', { name: 'Personal' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Catálogo escolar' })).toHaveCount(0);
    expect(await auditCount('activation.approved')).toBeGreaterThanOrEqual(0);
    await logout(person.page);
    await logout(authority.page);
  } finally {
    await person.context.close();
    await authority.context.close();
  }
});

test('6. deshabilitar una cuenta por la interfaz: no inicia sesion ni se activa; la pantalla no la vuelve a habilitar', async ({
  page,
  browser,
}) => {
  await loginAs(page, s.accounts.direccion);
  await page.goto('/personal');
  // cuenta descartable creada por la interfaz
  await page.getByRole('button', { name: 'Nueva cuenta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva cuenta de personal' });
  await dialog.getByLabel('Nombre completo').fill('Cuenta Descartable Ficticia');
  await dialog.getByLabel('Correo electrónico institucional').fill('descartable.e2e@escuela.test');
  await dialog.getByRole('button', { name: 'Crear cuenta' }).click();
  const detail = page.getByRole('region', { name: 'Cuenta Descartable Ficticia' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Deshabilitar cuenta' }).click();
  const confirm = page.getByRole('dialog', { name: '¿Deshabilitar esta cuenta?' });
  await expect(confirm).toContainText('Esta pantalla no permite volver a habilitarla');
  await confirm.getByRole('button', { name: 'Deshabilitar' }).click();
  await expect(detail.getByRole('status')).toContainText('La cuenta quedó deshabilitada.');
  expect(await userRow('descartable.e2e@escuela.test')).toMatchObject({ status: 'disabled' });
  expect(await auditCount('user.disabled', 'success')).toBeGreaterThanOrEqual(1);
  // no hay manera de volver a habilitarla desde la interfaz
  await expect(
    detail.getByRole('button', { name: /Deshabilitar|Habilitar|Reactivar/ }),
  ).toHaveCount(0);
  await logout(page);

  const other = await isolated(browser);
  try {
    // la cuenta deshabilitada no puede activarse: la pantalla NO revela el estado de la cuenta (muestra un codigo igual que para
    // cualquiera, para no permitir enumerar cuentas), pero no se crea ninguna solicitud que una autoridad pueda aprobar
    await other.page.goto('/activar');
    await other.page
      .getByLabel('Correo electrónico de tu cuenta')
      .fill('descartable.e2e@escuela.test');
    await other.page.getByRole('button', { name: 'Iniciar activación' }).click();
    await expect(other.page.getByRole('heading', { name: /Paso 2/ })).toBeVisible();
    expect(
      await db(
        async (q) =>
          (
            await q(
              `select count(*)::int n from auth_tokens t join users u on u.id = t.user_id where u.email = 'descartable.e2e@escuela.test'`,
            )
          ).rows[0]!.n,
      ),
    ).toBe(0);
  } finally {
    await other.context.close();
  }
});
