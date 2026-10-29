import { expect, test } from '@playwright/test';
import { ORIGIN, db, isolated, loginAs, logout, password, state } from './support';

/**
 * E2E REAL — sesiones simultaneas con BrowserContexts INDEPENDIENTES (cookies, almacenamiento y sesion propios; no son pestanas de
 * un mismo contexto). Verifica contra los registros de sesiones de la base DESECHABLE: aislamiento entre cuentas, efecto inmediato de
 * deshabilitar una cuenta sobre SU sesion y no sobre otras, cierre de sesion de un contexto sin tocar los demas, la misma cuenta en
 * dos contextos y el tope de sesiones concurrentes. No se cambia ninguna configuracion de seguridad web para facilitar las pruebas.
 */
test.describe.configure({ mode: 'serial' });
let s: ReturnType<typeof state>;
test.beforeAll(() => {
  s = state();
});

const idOf = (email: string) =>
  db(
    async (q) => (await q(`select id from users where email = $1`, [email])).rows[0]!.id as string,
  );
const sessionsOf = (email: string) =>
  db(
    async (q) =>
      (
        await q(
          `select count(*) filter (where se.revoked_at is null)::int live, count(*)::int total,
                  max(se.revoked_reason) filter (where se.revoked_at is not null) reason
             from sessions se join users u on u.id = se.user_id where u.email = $1`,
          [email],
        )
      ).rows[0]!,
  );

test('A. dos cuentas a la vez: cada prefecta consulta solo su grupo y nunca el ajeno (peticiones concurrentes)', async ({
  browser,
}) => {
  const a = await isolated(browser);
  const b = await isolated(browser);
  try {
    await Promise.all([
      loginAs(a.page, s.accounts.prefecturaA),
      loginAs(b.page, s.accounts.prefecturaB),
    ]);
    const [idA, idB] = [await idOf(s.accounts.prefecturaA), await idOf(s.accounts.prefecturaB)];
    // cada contexto tiene SU propia cookie de sesion (no se comparten)
    const ca = (await a.context.cookies()).map((c) => c.value);
    const cb = (await b.context.cookies()).map((c) => c.value);
    expect(ca.length).toBeGreaterThan(0);
    expect(ca.filter((v) => cb.includes(v))).toEqual([]);

    // 10 rondas concurrentes: identidad, grupos propios y rechazo de los ajenos, siempre consistentes
    for (let i = 0; i < 10; i++) {
      const [meA, meB, gA, gB, aOnB, bOnA, aStudB, bStudA] = await Promise.all([
        a.page.request.get('/api/auth/me'),
        b.page.request.get('/api/auth/me'),
        a.page.request.get('/api/school/me/groups'),
        b.page.request.get('/api/school/me/groups'),
        a.page.request.get(`/api/school/groups/${s.groups.B}/roster`),
        b.page.request.get(`/api/school/groups/${s.groups.A}/roster`),
        a.page.request.get(`/api/school/students/${s.students.fabi}`),
        b.page.request.get(`/api/school/students/${s.students.ana}`),
      ]);
      expect((await meA.json()).user.id).toBe(idA);
      expect((await meB.json()).user.id).toBe(idB);
      expect(
        ((await gA.json()).groups as Array<{ group: { code: string } }>).map((g) => g.group.code),
      ).toEqual(['A']);
      expect(
        ((await gB.json()).groups as Array<{ group: { code: string } }>).map((g) => g.group.code),
      ).toEqual(['B']);
      expect([aOnB.status(), bOnA.status(), aStudB.status(), bStudA.status()]).toEqual([
        404, 404, 404, 404,
      ]);
    }
    // en la interfaz tambien: cada una ve solo los alumnos de su grupo
    await Promise.all([a.page.goto('/alumnos'), b.page.goto('/alumnos')]);
    await expect(a.page.getByRole('list', { name: 'Alumnos' })).toContainText('Alfa Ficticia');
    await expect(a.page.getByRole('list', { name: 'Alumnos' })).not.toContainText('Foxtrot');
    await expect(b.page.getByRole('list', { name: 'Alumnos' })).toContainText('Foxtrot');
    await expect(b.page.getByRole('list', { name: 'Alumnos' })).not.toContainText('Alfa Ficticia');
    // ninguna de las dos modifico registros ajenos
    expect(
      await db(
        async (q) =>
          (
            await q(`select count(*)::int n from attendance_days where group_id in ($1,$2)`, [
              s.groups.A,
              s.groups.B,
            ])
          ).rows[0]!.n,
      ),
    ).toBeGreaterThanOrEqual(5);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('B. cerrar sesion en un contexto no altera las cookies ni los permisos del otro; la cookie vieja ya no sirve', async ({
  browser,
}) => {
  const a = await isolated(browser);
  const b = await isolated(browser);
  try {
    await loginAs(a.page, s.accounts.prefecturaA);
    await loginAs(b.page, s.accounts.prefecturaB);
    const cookieA = (await a.context.cookies()).find((c) => c.httpOnly)!;
    const liveBefore = (await sessionsOf(s.accounts.prefecturaA)).live;
    const cookiesB = JSON.stringify(await b.context.cookies());
    await logout(a.page);
    // el contexto B no cambio y sigue autorizado
    expect(JSON.stringify(await b.context.cookies())).toBe(cookiesB);
    expect((await b.page.request.get('/api/auth/me')).status()).toBe(200);
    expect((await b.page.request.get(`/api/school/groups/${s.groups.B}/roster`)).status()).toBe(
      200,
    );
    // el contexto A quedo sin sesion
    expect((await a.page.request.get('/api/auth/me')).status()).toBe(401);
    // la cookie de A, reutilizada desde otro cliente, ya no es valida (la sesion se revoco en el servidor)
    const replay = await b.context.browser()!.newContext();
    try {
      await replay.addCookies([cookieA]);
      expect((await replay.request.get(`${ORIGIN}/api/auth/me`)).status()).toBe(401);
    } finally {
      await replay.close();
    }
    // se revoco exactamente la sesion que se cerro (otras sesiones previas de la cuenta, de otros contextos, no se tocan)
    expect((await sessionsOf(s.accounts.prefecturaA)).live).toBe(liveBefore - 1);
    expect((await sessionsOf(s.accounts.prefecturaB)).live).toBeGreaterThanOrEqual(1);
    await logout(b.page);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('C. Direccion deshabilita una cuenta activa: su sesion cae de inmediato, la de otra cuenta no se ve afectada', async ({
  browser,
}) => {
  const baja = await isolated(browser);
  const other = await isolated(browser);
  const boss = await isolated(browser);
  try {
    await loginAs(baja.page, s.accounts.prefecturaBaja);
    await loginAs(other.page, s.accounts.prefecturaA);
    await baja.page.goto('/');
    expect((await baja.page.request.get('/api/auth/me')).status()).toBe(200);
    expect((await sessionsOf(s.accounts.prefecturaBaja)).live).toBeGreaterThanOrEqual(1);

    await loginAs(boss.page, s.accounts.direccion);
    await boss.page.goto('/personal');
    await boss.page.getByLabel('Buscar por nombre o correo').fill('Prefectura baja');
    const found = boss.page.getByRole('list', { name: 'Cuentas' }).getByRole('listitem');
    await expect(found).toHaveCount(1); // espera a que el filtro (con retardo) se aplique
    await found.getByRole('button').click();
    const detail = boss.page.getByRole('region', { name: 'Prefectura baja E2E' });
    await detail.getByRole('button', { name: 'Deshabilitar cuenta' }).click();
    await boss.page
      .getByRole('dialog', { name: '¿Deshabilitar esta cuenta?' })
      .getByRole('button', { name: 'Deshabilitar' })
      .click();
    await expect(detail.getByRole('status')).toContainText('La cuenta quedó deshabilitada.');

    // la sesion abierta de la cuenta deshabilitada ya no autoriza nada (siguiente peticion)
    expect((await baja.page.request.get('/api/auth/me')).status()).toBe(401);
    expect((await baja.page.request.get('/api/school/me/groups')).status()).toBe(401);
    const stored = await sessionsOf(s.accounts.prefecturaBaja);
    expect(stored.live).toBe(0);
    expect(stored.reason).toBe('disabled');
    // en la interfaz, al navegar vuelve al acceso
    await baja.page.goto('/alumnos');
    await expect(baja.page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
    // y no puede volver a entrar
    await baja.page.getByLabel('Correo electrónico').fill(s.accounts.prefecturaBaja);
    await baja.page.getByLabel('Contraseña', { exact: true }).fill(password());
    await baja.page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(baja.page.getByRole('alert')).toBeVisible();
    await expect(baja.page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);

    // la otra cuenta activa no heredo ni perdio nada
    expect((await other.page.request.get('/api/auth/me')).status()).toBe(200);
    expect((await other.page.request.get(`/api/school/groups/${s.groups.A}/roster`)).status()).toBe(
      200,
    );
    expect((await sessionsOf(s.accounts.prefecturaA)).live).toBeGreaterThanOrEqual(1);
    await logout(boss.page);
    await logout(other.page);
  } finally {
    await baja.context.close();
    await other.context.close();
    await boss.context.close();
  }
});

test('D. la misma cuenta en dos contextos: sesiones separadas; cerrar una no cierra la otra; el tope de sesiones se respeta', async ({
  browser,
}) => {
  const email = s.accounts.trabajoSocial;
  const one = await isolated(browser);
  const two = await isolated(browser);
  try {
    await loginAs(one.page, email);
    await loginAs(two.page, email);
    const live = (await sessionsOf(email)).live;
    expect(live).toBeGreaterThanOrEqual(2);
    const cookie = (ctx: typeof one) =>
      ctx.context.cookies().then((c) => c.find((x) => x.httpOnly)!.value);
    expect(await cookie(one)).not.toBe(await cookie(two));
    await logout(one.page);
    expect((await one.page.request.get('/api/auth/me')).status()).toBe(401);
    expect((await two.page.request.get('/api/auth/me')).status()).toBe(200);
    expect((await sessionsOf(email)).live).toBe(live - 1);

    // tope de sesiones concurrentes por cuenta (5 para este rol): nunca hay mas sesiones vigentes que el tope
    const extra = [];
    try {
      for (let i = 0; i < 6; i++) {
        const c = await browser.newContext();
        extra.push(c);
        await c.request.post('/api/auth/login', {
          headers: { origin: ORIGIN },
          data: { email, password: password() },
        });
        expect((await sessionsOf(email)).live).toBeLessThanOrEqual(5);
      }
    } finally {
      await Promise.all(extra.map((c) => c.close()));
    }
    expect((await sessionsOf(email)).live).toBeLessThanOrEqual(5);
  } finally {
    await one.context.close();
    await two.context.close();
  }
});
