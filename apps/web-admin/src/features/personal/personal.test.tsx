import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import {
  DIRECCION_PERMS,
  ME,
  apiError,
  installFakeApi,
  jsonResponse,
  meWith,
} from '../../test/fake-api';

/**
 * Pruebas de componentes del panel de personal (jsdom + `fetch` falso). NO son pruebas de navegador real. Comprueban que la
 * interfaz adapta los controles a los permisos efectivos y que envia lo correcto; la autorizacion real es del servidor.
 */
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SELF_ID = ME.user.id;
const user = (over: Record<string, unknown> = {}) => ({
  id: OTHER_ID,
  email: 'maria@escuela.mx',
  emailKind: 'institutional',
  displayName: 'María Pérez',
  accountDomain: 'school',
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastLoginAt: null,
  locked: false,
  roles: [
    {
      key: 'prefectura',
      name: 'Prefectura',
      domain: 'school',
      grantedAt: '2026-10-02T10:00:00.000Z',
    },
  ],
  activation: null,
  ...over,
});
const list = (items: unknown[], over = {}) => ({
  items,
  page: 1,
  pageSize: 10,
  total: items.length,
  ...over,
});
const ROLES = [
  { key: 'prefectura', name: 'Prefectura', description: '', domain: 'school', requiresMfa: false },
  {
    key: 'trabajo_social',
    name: 'Trabajo social',
    description: '',
    domain: 'school',
    requiresMfa: false,
  },
  { key: 'direccion', name: 'Dirección', description: '', domain: 'school', requiresMfa: true },
];

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
const baseRoutes = (perms: string[] = DIRECCION_PERMS) => ({
  'GET /auth/me': () => jsonResponse(200, meWith(perms)),
  'GET /health': () => jsonResponse(200, { status: 'ok' }),
  'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'csrf-ficticio' }),
  'GET /admin/roles': () => jsonResponse(200, ROLES),
});

describe('acceso al panel segun permisos efectivos', () => {
  it('sin permisos de administracion no aparece la navegacion y la ruta lo explica sin llamar a la API', async () => {
    const api = installFakeApi({
      ...baseRoutes(['catalog:read']),
      'GET /admin/users': () => jsonResponse(200, list([])),
    });
    renderAt('/personal');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Personal' })).toBeNull();
    expect(api.count('GET /admin/users')).toBe(0);
  });

  it('con permisos aparece el enlace "Personal" y se carga la lista', async () => {
    installFakeApi({
      ...baseRoutes(),
      'GET /admin/users': () => jsonResponse(200, list([user()])),
    });
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Personal' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Personal' }));
    expect(await screen.findByText('María Pérez')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nueva cuenta' })).toBeTruthy();
  });

  it('una cuenta que solo puede leer no ve "Nueva cuenta"... ni se le ofrece administrar si no administra ningun dominio', async () => {
    installFakeApi({
      ...baseRoutes(['users:read']),
      'GET /admin/users': () => jsonResponse(200, list([])),
    });
    renderAt('/personal');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('button', { name: 'Nueva cuenta' })).toBeNull();
  });
});

describe('listado, busqueda, filtros y paginacion', () => {
  it('muestra estados de carga, vacio y error con reintento', async () => {
    let fail = true;
    installFakeApi({
      ...baseRoutes(),
      'GET /admin/users': () =>
        fail ? apiError(500, 'INTERNAL_ERROR') : jsonResponse(200, list([])),
    });
    renderAt('/personal');
    expect(await screen.findByText(/No se pudo cargar la lista de personal/)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText(/Todavía no hay cuentas registradas/)).toBeTruthy();
  });

  it('busca con retraso (minimo 2 caracteres), filtra por estado y vuelve a la primera pagina', async () => {
    const api = installFakeApi({
      ...baseRoutes(),
      'GET /admin/users': () => jsonResponse(200, list([user()])),
    });
    renderAt('/personal');
    await screen.findByText('María Pérez');
    await userEvent.type(screen.getByLabelText('Buscar por nombre o correo'), 'm');
    await new Promise((r) => setTimeout(r, 400));
    expect(api.calls.some((c) => c.url.includes('q='))).toBe(false); // 1 caracter: no se consulta
    await userEvent.type(screen.getByLabelText('Buscar por nombre o correo'), 'ar');
    await waitFor(() => expect(api.calls.some((c) => c.url.includes('q=mar'))).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'pending');
    await waitFor(() => expect(api.calls.at(-1)!.url).toContain('status=pending'));
    expect(api.calls.at(-1)!.url).toContain('page=1');
    expect(screen.queryByLabelText('Dominio')).toBeNull(); // solo administra un dominio: no hay filtro de dominio
  });

  it('con filtros sin resultados muestra un vacio distinto del vacio inicial', async () => {
    installFakeApi({ ...baseRoutes(), 'GET /admin/users': () => jsonResponse(200, list([])) });
    renderAt('/personal');
    await screen.findByText(/Todavía no hay cuentas/);
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'disabled');
    expect(await screen.findByText(/No hay cuentas que coincidan con los filtros/)).toBeTruthy();
  });

  it('pagina: siguiente/anterior consultan la pagina correspondiente', async () => {
    const api = installFakeApi({
      ...baseRoutes(),
      'GET /admin/users': (call) =>
        jsonResponse(
          200,
          list(
            [user({ displayName: call.url.includes('page=2') ? 'Persona dos' : 'Persona uno' })],
            {
              total: 25,
              page: call.url.includes('page=2') ? 2 : 1,
            },
          ),
        ),
    });
    renderAt('/personal');
    await screen.findByText('Persona uno');
    expect(screen.getByText(/Página 1 de 3 · 25 cuentas/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Anterior' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('Persona dos')).toBeTruthy();
    expect(api.calls.at(-1)!.url).toContain('page=2');
  });

  it('con permisos de dos dominios ofrece el filtro de dominio', async () => {
    installFakeApi({
      ...baseRoutes([...DIRECCION_PERMS, 'users:manage_technical']),
      'GET /admin/users': () => jsonResponse(200, list([])),
    });
    renderAt('/personal');
    expect(await screen.findByLabelText('Dominio')).toBeTruthy();
  });
});

describe('detalle, roles y deshabilitar', () => {
  const open = async (
    routes: Record<string, () => Response>,
    perms = DIRECCION_PERMS,
    who = user(),
  ) => {
    const api = installFakeApi({
      ...baseRoutes(perms),
      'GET /admin/users': () => jsonResponse(200, list([who])),
      ...routes,
    });
    renderAt('/personal');
    await userEvent.click(await screen.findByText(who.displayName));
    return { api, detail: await screen.findByRole('region', { name: who.displayName }) };
  };

  it('muestra el detalle sin datos sensibles y con controles para quien puede conceder roles', async () => {
    const { detail } = await open({});
    expect(within(detail).getByText('Prefectura')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Revocar el rol Prefectura' })).toBeTruthy();
    expect(within(detail).getByLabelText('Asignar un rol')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Deshabilitar cuenta' })).toBeTruthy();
    expect(detail.textContent).not.toMatch(/hash|token|contraseña:/i);
  });

  it('quien solo puede leer/administrar cuentas (sin roles:grant) no ve asignar ni revocar roles', async () => {
    const { detail } = await open({}, ['users:read', 'roles:read', 'users:manage_school']);
    expect(within(detail).queryByLabelText('Asignar un rol')).toBeNull();
    expect(within(detail).queryByRole('button', { name: /Revocar/ })).toBeNull();
    expect(within(detail).getByRole('button', { name: 'Deshabilitar cuenta' })).toBeTruthy();
  });

  it('no ofrece cambiar los roles ni deshabilitar la propia cuenta', async () => {
    const { detail } = await open(
      {},
      DIRECCION_PERMS,
      user({ id: SELF_ID, displayName: 'Yo Misma' }),
    );
    expect(within(detail).queryByLabelText('Asignar un rol')).toBeNull();
    expect(within(detail).queryByRole('button', { name: /Revocar/ })).toBeNull();
    expect(within(detail).queryByRole('button', { name: 'Deshabilitar cuenta' })).toBeNull();
    expect(detail.textContent).toMatch(/propia cuenta/);
  });

  it('asigna un rol: pide CSRF, envia solo la clave del rol y actualiza el detalle', async () => {
    const { api, detail } = await open({
      'POST /admin/users/22222222-2222-4222-8222-222222222222/roles': () =>
        jsonResponse(
          201,
          user({
            roles: [
              ...user().roles,
              {
                key: 'trabajo_social',
                name: 'Trabajo social',
                domain: 'school',
                grantedAt: '2026-10-03T10:00:00.000Z',
              },
            ],
          }),
        ),
    });
    // los roles ya asignados no se ofrecen
    const select = within(detail).getByLabelText('Asignar un rol') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain('prefectura');
    await userEvent.selectOptions(select, 'trabajo_social');
    await userEvent.click(within(detail).getByRole('button', { name: 'Asignar rol' }));
    expect(await within(detail).findByText('Trabajo social')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/roles'))!;
    expect(post.body).toEqual({ roleKey: 'trabajo_social' });
    expect(post.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(api.calls.findIndex((c) => c.url === '/api/auth/csrf')).toBeLessThan(
      api.calls.indexOf(post),
    );
  });

  it('revocar pide confirmacion y solo despues llama a la API', async () => {
    const { api, detail } = await open({
      'DELETE /admin/users/22222222-2222-4222-8222-222222222222/roles/prefectura': () =>
        jsonResponse(200, user({ roles: [] })),
    });
    await userEvent.click(
      within(detail).getByRole('button', { name: 'Revocar el rol Prefectura' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '¿Revocar este rol?' });
    expect(
      api.count('DELETE /admin/users/22222222-2222-4222-8222-222222222222/roles/prefectura'),
    ).toBe(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(
      within(detail).getByRole('button', { name: 'Revocar el rol Prefectura' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revocar rol' }),
    );
    expect(await within(detail).findByText(/no tiene roles/i)).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'DELETE')!.headers['X-CSRF-Token']).toBe(
      'csrf-ficticio',
    );
  });

  it('muestra el error del servidor al revocar (p. ej. ultimo titular) y mantiene el dialogo', async () => {
    const { detail } = await open({
      'DELETE /admin/users/22222222-2222-4222-8222-222222222222/roles/prefectura': () =>
        apiError(
          409,
          'LAST_AUTHORITY',
          'No puede revocarse al último titular con autoridad del dominio',
        ),
    });
    await userEvent.click(
      within(detail).getByRole('button', { name: 'Revocar el rol Prefectura' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revocar rol' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/último titular/);
  });

  it('deshabilitar exige confirmacion y actualiza el estado', async () => {
    const { detail } = await open({
      'POST /admin/users/22222222-2222-4222-8222-222222222222/disable': () =>
        jsonResponse(200, user({ status: 'disabled' })),
    });
    await userEvent.click(within(detail).getByRole('button', { name: 'Deshabilitar cuenta' }));
    const dialog = await screen.findByRole('dialog', { name: '¿Deshabilitar esta cuenta?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deshabilitar' }));
    expect(await within(detail).findByText('Deshabilitada')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Deshabilitar cuenta' })).toBeNull();
  });

  it('una cuenta pendiente explica el estado de activacion y que nadie mas conoce la contrasena', async () => {
    const { detail } = await open(
      {},
      DIRECCION_PERMS,
      user({ status: 'pending', roles: [], activation: 'requested' }),
    );
    expect(detail.textContent).toMatch(/falta verificar a la persona/);
    expect(detail.textContent).toMatch(/\/activar/);
  });
});

describe('crear cuenta pendiente', () => {
  const openCreate = async (routes: Record<string, () => Response> = {}) => {
    const api = installFakeApi({
      ...baseRoutes(),
      'GET /admin/users': () => jsonResponse(200, list([])),
      ...routes,
    });
    renderAt('/personal');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva cuenta' }));
    return { api, dialog: await screen.findByRole('dialog', { name: 'Nueva cuenta de personal' }) };
  };

  it('no tiene campo de contrasena y valida antes de enviar', async () => {
    const { api, dialog } = await openCreate();
    expect(within(dialog).queryByLabelText(/contraseña/i)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }));
    expect(within(dialog).getByText('Escribe el nombre completo.')).toBeTruthy();
    expect(within(dialog).getByText('Escribe el correo electrónico.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Nombre completo'), 'Ana López');
    await userEvent.type(
      within(dialog).getByLabelText('Correo electrónico institucional'),
      'no-es-correo',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }));
    expect(within(dialog).getByText('Escribe un correo electrónico válido.')).toBeTruthy();
    expect(api.count('POST /admin/users')).toBe(0);
  });

  it('crea la cuenta enviando solo nombre, correo y dominio (con CSRF) y la deja seleccionada', async () => {
    const created = user({
      id: '33333333-3333-4333-8333-333333333333',
      email: 'ana@escuela.mx',
      displayName: 'Ana López',
      status: 'pending',
      roles: [],
    });
    const { api, dialog } = await openCreate({
      'POST /admin/users': () => jsonResponse(201, created),
    });
    await userEvent.type(within(dialog).getByLabelText('Nombre completo'), 'Ana López');
    await userEvent.type(
      within(dialog).getByLabelText('Correo electrónico institucional'),
      'ana@escuela.mx',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('region', { name: 'Ana López' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Cuenta creada para Ana López/);
    const post = api.calls.find((c) => c.method === 'POST' && c.url === '/api/admin/users')!;
    expect(post.body).toEqual({
      email: 'ana@escuela.mx',
      displayName: 'Ana López',
      accountDomain: 'school',
    });
    expect(post.headers['X-CSRF-Token']).toBe('csrf-ficticio');
  });

  it('un correo duplicado se informa sin cerrar el dialogo', async () => {
    const { dialog } = await openCreate({
      'POST /admin/users': () => apiError(409, 'CONFLICT', 'Ya existe una cuenta con ese correo'),
    });
    await userEvent.type(within(dialog).getByLabelText('Nombre completo'), 'Ana López');
    await userEvent.type(
      within(dialog).getByLabelText('Correo electrónico institucional'),
      'ana@escuela.mx',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /Ya existe una cuenta con ese correo/,
    );
  });

  it('Escape cierra el dialogo', async () => {
    await openCreate();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('solicitudes de activacion', () => {
  const REQ = {
    id: '44444444-4444-4444-8444-444444444444',
    userId: OTHER_ID,
    email: 'luis@escuela.mx',
    displayName: 'Luis Soto',
    accountDomain: 'school',
    createdByActor: false,
    state: 'requested',
    requestedAt: '2026-10-26T10:00:00.000Z',
    expiresAt: '2026-10-26T10:30:00.000Z',
  };
  const openTab = async (routes: Record<string, () => Response> = {}) => {
    const api = installFakeApi({
      ...baseRoutes(),
      'GET /admin/users': () => jsonResponse(200, list([])),
      'GET /admin/activation-requests': () => jsonResponse(200, { items: [REQ] }),
      ...routes,
    });
    renderAt('/personal');
    await userEvent.click(await screen.findByRole('tab', { name: 'Solicitudes de activación' }));
    return api;
  };

  it('lista las solicitudes; la autoridad NO ve codigo ni hash', async () => {
    await openTab();
    expect(await screen.findByText('Luis Soto')).toBeTruthy();
    expect(screen.getByText('Esperando verificación')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
  });

  it('estado vacio', async () => {
    await openTab({ 'GET /admin/activation-requests': () => jsonResponse(200, { items: [] }) });
    expect(await screen.findByText(/No hay solicitudes de activación pendientes/)).toBeTruthy();
  });

  it('aprobar exige un codigo de 10 caracteres y envia codigo + metodo (con CSRF)', async () => {
    const api = await openTab({
      'POST /admin/activation-requests/44444444-4444-4444-8444-444444444444/approve': () =>
        jsonResponse(200, { state: 'authorized' }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Verificar identidad de Luis Soto' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Verificar identidad' });
    await userEvent.type(within(dialog).getByLabelText(/Código que muestra la pantalla/), 'ABC');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmar identidad' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/10 caracteres/);
    expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/approve'))).toBe(false);
    await userEvent.clear(within(dialog).getByLabelText(/Código que muestra la pantalla/));
    await userEvent.type(
      within(dialog).getByLabelText(/Código que muestra la pantalla/),
      '7k3qm-b9xw2',
    );
    await userEvent.click(within(dialog).getByLabelText('La conozco personalmente'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmar identidad' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/approve'))!;
    expect(post.body).toEqual({ code: '7k3qm-b9xw2', verificationMethod: 'in_person_known' });
    expect(post.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(screen.getByRole('status').textContent).toMatch(/Identidad verificada/);
  });

  it('un codigo que no coincide se informa y no cierra el dialogo', async () => {
    await openTab({
      'POST /admin/activation-requests/44444444-4444-4444-8444-444444444444/approve': () =>
        apiError(
          400,
          'CODE_MISMATCH',
          'El código no coincide con el que muestra la pantalla de la persona',
        ),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Verificar identidad de Luis Soto' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(/Código que muestra la pantalla/),
      '00000-00000',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmar identidad' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/no coincide/);
  });

  it('cancelar pide confirmacion', async () => {
    const api = await openTab({
      'POST /admin/activation-requests/44444444-4444-4444-8444-444444444444/cancel': () =>
        jsonResponse(200, { state: 'cancelled' }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cancelar la solicitud de Luis Soto' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '¿Cancelar esta solicitud?' });
    expect(api.calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar solicitud' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/cancel'))).toBe(true),
    );
  });

  it('si la cuenta la creo quien consulta, avisa del control dual y del procedimiento excepcional', async () => {
    await openTab({
      'GET /admin/activation-requests': () =>
        jsonResponse(200, { items: [{ ...REQ, createdByActor: true }] }),
    });
    expect((await screen.findByText(/Creaste esta cuenta/)).textContent).toMatch(/otra autoridad/);
    expect(screen.getByText(/procedimiento excepcional con acta/)).toBeTruthy();
  });
});
