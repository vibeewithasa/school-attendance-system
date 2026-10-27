import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes del catalogo escolar (jsdom + `fetch` falso). NO son pruebas de navegador real: comprueban que la
 * interfaz adapta los controles a los permisos efectivos, valida antes de enviar y envia lo correcto. La autorizacion real y
 * las reglas (traslapes, vigencia, historial) son del servidor y se prueban contra la API real.
 */
const year = (over: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: '2026-2027',
  startsOn: '2026-08-31',
  endsOn: '2027-07-15',
  isActive: false,
  period: 'current',
  groupCount: 2,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  ...over,
});
const PAST = year({
  id: 'aaaaaaaa-0000-4000-8000-000000000003',
  name: '2024-2025',
  startsOn: '2024-08-26',
  endsOn: '2025-07-15',
  period: 'past',
});
const CURRENT = year();
const FUTURE = year({
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  name: '2027-2028',
  startsOn: '2027-08-30',
  endsOn: '2028-07-14',
  period: 'future',
  groupCount: 0,
});
const group = (over: Record<string, unknown> = {}) => ({
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  schoolYearId: CURRENT.id,
  schoolYearName: CURRENT.name,
  grade: 1,
  code: 'A',
  shift: 'matutino',
  expectedEntryTime: '07:00',
  isActive: true,
  historical: false,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  ...over,
});
const page = (items: unknown[], over = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  ...over,
});

const READ = ['catalog:read'];
const MANAGE = ['catalog:read', 'catalog:manage_school'];

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
const base = (perms: string[], years = [CURRENT, FUTURE, PAST], groups: unknown[] = []) => ({
  'GET /auth/me': () => jsonResponse(200, meWith(perms)),
  'GET /health': () => jsonResponse(200, { status: 'ok' }),
  'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'csrf-ficticio' }),
  'GET /catalog/school-years': () => jsonResponse(200, page(years)),
  'GET /catalog/groups': () => jsonResponse(200, page(groups)),
});
const open = async (perms: string[], routes: Record<string, never> | object = {}) => {
  const fake = installFakeApi({ ...base(perms), ...routes } as never);
  renderAt('/catalogo');
  return fake;
};
const setValue = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('acceso segun permisos efectivos', () => {
  it('sin catalog:read no aparece el enlace y la ruta lo explica sin llamar a la API del catalogo', async () => {
    const api = installFakeApi({ ...base(['users:read']) });
    renderAt('/catalogo');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Catálogo escolar' })).toBeNull();
    expect(api.count('GET /catalog/school-years')).toBe(0);
  });

  it('con catalog:read aparece el enlace "Catálogo escolar" y se listan los ciclos', async () => {
    installFakeApi({ ...base(READ) });
    renderAt('/');
    await userEvent.click(await screen.findByRole('link', { name: 'Catálogo escolar' }));
    expect(await screen.findByText('2026-2027')).toBeTruthy();
    expect(screen.getByText('2024-2025')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Grupos' })).toBeTruthy();
  });

  it('solo lectura: no hay botones para crear, editar, activar ni desactivar', async () => {
    await open(READ, { 'GET /catalog/groups': () => jsonResponse(200, page([group()])) });
    await screen.findByText('2026-2027');
    expect(screen.queryByRole('button', { name: 'Nuevo ciclo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Editar|Activar|Desactivar/ })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Grupos' }));
    expect(await screen.findByText(/Entrada 07:00/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nuevo grupo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Editar|Activar|Desactivar/ })).toBeNull();
  });

  it('un error al cargar ofrece reintentar', async () => {
    let fail = true;
    installFakeApi({
      ...base(READ),
      'GET /catalog/school-years': () =>
        fail ? apiError(500, 'INTERNAL_ERROR') : jsonResponse(200, page([CURRENT])),
    });
    renderAt('/catalogo');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo/);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('2026-2027')).toBeTruthy();
  });
});

describe('ciclos escolares', () => {
  it('muestra vigencia: el historico no tiene acciones; el actual se activa; el futuro solo se edita', async () => {
    await open(MANAGE);
    await screen.findByText('2026-2027');
    expect(screen.queryByRole('button', { name: 'Editar ciclo 2024-2025' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activar ciclo 2024-2025' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Activar ciclo 2026-2027' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editar ciclo 2027-2028' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activar ciclo 2027-2028' })).toBeNull();
    expect(screen.getByText('Histórico')).toBeTruthy();
    expect(screen.getByText('Próximo')).toBeTruthy();
  });

  it('valida antes de enviar: fin anterior al inicio, duracion absurda y campos vacios', async () => {
    const api = await open(MANAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo ciclo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect(within(dialog).getByText(/Escribe el nombre/)).toBeTruthy();
    expect(within(dialog).getByText(/fecha de inicio/)).toBeTruthy();

    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), '2028-2029');
    setValue(within(dialog).getByLabelText('Inicio'), '2028-08-28');
    setValue(within(dialog).getByLabelText('Fin'), '2028-08-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect(within(dialog).getByText(/posterior a la de inicio/)).toBeTruthy();

    setValue(within(dialog).getByLabelText('Fin'), '2028-09-10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect(within(dialog).getByText(/debe durar entre 60 y 400/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Fin').getAttribute('aria-invalid')).toBe('true');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('crea un ciclo valido con CSRF, avisa y recarga la lista', async () => {
    let created = false;
    const api = await open(MANAGE, {
      'GET /catalog/school-years': () =>
        jsonResponse(
          200,
          page(created ? [CURRENT, year({ id: 'x', name: '2028-2029' })] : [CURRENT]),
        ),
      'POST /catalog/school-years': () => {
        created = true;
        return jsonResponse(201, year({ id: 'x', name: '2028-2029', period: 'future' }));
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo ciclo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), '  2028-2029  ');
    setValue(within(dialog).getByLabelText('Inicio'), '2028-08-28');
    setValue(within(dialog).getByLabelText('Fin'), '2029-07-13');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Ciclo 2028-2029 creado/);
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: '2028-2029', startsOn: '2028-08-28', endsOn: '2029-07-13' });
    expect(post.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(await screen.findByText('2028-2029')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('muestra el rechazo del servidor (traslape) dentro del dialogo y lo deja abierto', async () => {
    await open(MANAGE, {
      'POST /catalog/school-years': () =>
        apiError(409, 'CONFLICT', 'Las fechas se traslapan con otro ciclo escolar.'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo ciclo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), 'Solapado');
    setValue(within(dialog).getByLabelText('Inicio'), '2027-01-01');
    setValue(within(dialog).getByLabelText('Fin'), '2027-09-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/se traslapan/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('edita enviando solo lo que cambio; sin cambios no llama a la API', async () => {
    const api = await open(MANAGE, {
      [`PATCH /catalog/school-years/${FUTURE.id}`]: () =>
        jsonResponse(200, { ...FUTURE, name: '2027-2028 B' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Editar ciclo 2027-2028' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/No hay cambios/);
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), ' B');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: '2027-2028 B' });
  });

  it('activar pide confirmacion, se puede cancelar y muestra el rechazo del servidor', async () => {
    let reject = true;
    const api = await open(MANAGE, {
      [`POST /catalog/school-years/${CURRENT.id}/activate`]: () =>
        reject
          ? apiError(
              400,
              'VALIDATION',
              'Solo puede activarse el ciclo que incluye la fecha de hoy.',
            )
          : jsonResponse(200, { ...CURRENT, isActive: true }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Activar ciclo 2026-2027' }));
    expect(screen.getByRole('dialog').textContent).toMatch(
      /Si hay otro ciclo vigente, dejará de serlo/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Activar ciclo 2026-2027' }));
    await userEvent.click(screen.getByRole('button', { name: 'Activar ciclo' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/fecha de hoy/);
    reject = false;
    await userEvent.click(screen.getByRole('button', { name: 'Activar ciclo' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/ciclo vigente/);
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('desactivar el vigente pide confirmacion y avisa que el sistema queda sin ciclo vigente', async () => {
    const active = year({ isActive: true });
    const api = await open(MANAGE, {
      'GET /catalog/school-years': () => jsonResponse(200, page([active])),
      [`POST /catalog/school-years/${CURRENT.id}/deactivate`]: () =>
        jsonResponse(200, { ...active, isActive: false }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Desactivar ciclo 2026-2027' }),
    );
    expect(screen.getByRole('dialog').textContent).toMatch(/sin ciclo vigente/);
    await userEvent.click(screen.getByRole('button', { name: 'Desactivar ciclo' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/ya no es el ciclo vigente/);
    expect(api.count(`POST /catalog/school-years/${CURRENT.id}/deactivate`)).toBe(1);
  });

  it('503: explica que la base aun no autoriza escribir, sin detalles internos', async () => {
    await open(MANAGE, {
      'POST /catalog/school-years': () =>
        apiError(503, 'CATALOG_WRITE_UNAVAILABLE', 'permission denied for table school_years'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo ciclo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), '2029-2030');
    setValue(within(dialog).getByLabelText('Inicio'), '2029-08-27');
    setValue(within(dialog).getByLabelText('Fin'), '2030-07-12');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/aún no autoriza modificar el catálogo/);
    expect(alert.textContent).not.toMatch(/permission denied|school_years/);
  });

  it('el filtro de vigencia oculta los ciclos que no corresponden', async () => {
    await open(READ, {
      'GET /catalog/school-years': () =>
        jsonResponse(200, page([year({ isActive: true }), FUTURE, PAST])),
    });
    await screen.findByText('2026-2027');
    await userEvent.selectOptions(screen.getByLabelText('Vigencia'), 'active');
    expect(screen.getByText('2026-2027')).toBeTruthy();
    expect(screen.queryByText('2027-2028')).toBeNull();
  });
});

describe('accesibilidad de formularios: foco al primer campo con error', () => {
  it('ciclo: el foco va al primer campo invalido, y cambia al siguiente cuando el primero se corrige', async () => {
    await open(MANAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo ciclo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Nombre del ciclo'));
    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), '2028-2029');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Inicio'));
    setValue(within(dialog).getByLabelText('Inicio'), '2028-08-28');
    setValue(within(dialog).getByLabelText('Fin'), '2028-08-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Fin'));
    expect(within(dialog).getByLabelText('Fin').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('grupo: el foco va al identificador y despues a la hora de entrada invalida', async () => {
    await open(MANAGE);
    await userEvent.click(await screen.findByRole('tab', { name: 'Grupos' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Grupo'));
    await userEvent.type(within(dialog).getByLabelText('Grupo'), 'A');
    // un valor con segundos (no admitido) se rechaza aunque el campo admita escribirlo
    setValue(within(dialog).getByLabelText('Hora de entrada (opcional)'), '07:00:30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText('Hora de entrada (opcional)'),
    );
  });
});

describe('controles por rol (politica del catalogo)', () => {
  it('Direccion (catalog:manage_school) ve los controles de administracion', async () => {
    await open(['catalog:read', 'catalog:manage_school', 'users:read', 'users:manage_school']);
    expect(await screen.findByRole('button', { name: 'Nuevo ciclo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activar ciclo 2026-2027' })).toBeTruthy();
  });

  it('admin_tecnico (solo lee el catalogo) NO ve controles de administracion escolar', async () => {
    await open(['catalog:read', 'users:read', 'users:manage_technical', 'system:config']);
    await screen.findByText('2026-2027');
    expect(screen.queryByRole('button', { name: 'Nuevo ciclo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Editar|Activar|Desactivar/ })).toBeNull();
    expect(screen.getByText(/puede consultar el catálogo, no modificarlo/)).toBeTruthy();
  });

  it('un permiso ajeno (catalog:manage tecnico reservado) no habilita los controles', async () => {
    await open(['catalog:read', 'catalog:manage']);
    await screen.findByText('2026-2027');
    expect(screen.queryByRole('button', { name: 'Nuevo ciclo' })).toBeNull();
  });

  it('Prefectura (sin catalog:read) no ve el enlace ni llama a la API del catalogo', async () => {
    const api = installFakeApi({ ...base([]) });
    renderAt('/');
    await screen.findByText('Bienvenida, bienvenido');
    expect(screen.queryByRole('link', { name: 'Catálogo escolar' })).toBeNull();
    expect(api.count('GET /catalog/school-years')).toBe(0);
  });

  it('un 403 del servidor al escribir se explica sin detalles internos', async () => {
    await open(MANAGE, {
      'POST /catalog/school-years': () => apiError(403, 'FORBIDDEN', 'No tiene permiso'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo ciclo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nombre del ciclo'), '2029-2030');
    setValue(within(dialog).getByLabelText('Inicio'), '2029-08-27');
    setValue(within(dialog).getByLabelText('Fin'), '2030-07-12');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear ciclo' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/No tienes permiso/);
  });
});

describe('grupos', () => {
  const goToGroups = async () => {
    await userEvent.click(await screen.findByRole('tab', { name: 'Grupos' }));
  };

  it('el ciclo vigente es el filtro inicial; filtra por grado y turno (incluido "sin turno") en el servidor', async () => {
    const active = year({ isActive: true });
    const api = installFakeApi({
      ...base(READ, [active, FUTURE, PAST], [group()]),
      'GET /catalog/school-years': () => jsonResponse(200, page([active, FUTURE, PAST])),
    });
    renderAt('/catalogo');
    await goToGroups();
    await screen.findByText(/Entrada 07:00/);
    const last = () => api.calls.filter((c) => c.url.includes('/catalog/groups')).at(-1)!.url;
    await waitFor(() => expect(last()).toContain(`schoolYearId=${active.id}`));
    await userEvent.selectOptions(screen.getByLabelText('Grado'), '2');
    await waitFor(() => expect(last()).toContain('grade=2'));
    await userEvent.selectOptions(screen.getByLabelText('Turno'), 'none');
    await waitFor(() => expect(last()).toContain('shift=none'));
    await userEvent.selectOptions(screen.getByLabelText('Turno'), 'vespertino');
    await waitFor(() => expect(last()).toContain('shift=vespertino'));
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'inactive');
    await waitFor(() => expect(last()).toContain('isActive=false'));
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), '');
    await waitFor(() => expect(last()).not.toContain('schoolYearId'));
  });

  it('muestra la hora de entrada o "sin configurar", el turno, y marca el historial sin acciones', async () => {
    await open(MANAGE, {
      'GET /catalog/groups': () =>
        jsonResponse(
          200,
          page([
            group(),
            group({ id: 'g2', code: 'B', shift: null, expectedEntryTime: null }),
            group({
              id: 'g3',
              code: 'C',
              schoolYearId: PAST.id,
              schoolYearName: PAST.name,
              historical: true,
            }),
          ]),
        ),
    });
    await goToGroups();
    expect((await screen.findAllByText(/Entrada 07:00/)).length).toBe(2);
    expect(screen.getByText(/Sin turno · Hora de entrada sin configurar/)).toBeTruthy();
    expect(screen.getAllByText('Histórico').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Editar grupo 1.º A/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Editar grupo 1.º C/ })).toBeNull();
  });

  it('estado vacio con y sin filtros', async () => {
    await open(MANAGE);
    await goToGroups();
    expect(await screen.findByText(/Todavía no hay grupos\. Crea el primero/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Grado'), '3');
    expect(await screen.findByText(/No hay grupos que coincidan/)).toBeTruthy();
  });

  it('crea un grupo con hora de entrada 07:50 y codigo normalizado; el ciclo no historico se ofrece', async () => {
    const api = await open(MANAGE, {
      'POST /catalog/groups': () =>
        jsonResponse(201, group({ code: 'TEC 1', expectedEntryTime: '07:50' })),
    });
    await goToGroups();
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    const yearSelect = within(dialog).getByLabelText('Ciclo escolar') as HTMLSelectElement;
    expect([...yearSelect.options].map((o) => o.textContent)).toEqual(['2026-2027', '2027-2028']);
    await userEvent.selectOptions(within(dialog).getByLabelText('Grado'), '2');
    await userEvent.type(within(dialog).getByLabelText('Grupo'), '  tec  1 ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Turno'), 'matutino');
    setValue(within(dialog).getByLabelText('Hora de entrada (opcional)'), '07:50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/creado/);
    expect(api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/groups'))!.body).toEqual({
      schoolYearId: CURRENT.id,
      grade: 2,
      code: 'TEC 1',
      shift: 'matutino',
      expectedEntryTime: '07:50',
    });
  });

  it('la hora de entrada es opcional: sin ella se envia null', async () => {
    const api = await open(MANAGE, {
      'POST /catalog/groups': () => jsonResponse(201, group({ expectedEntryTime: null })),
    });
    await goToGroups();
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Grupo'), 'a');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      code: 'A',
      shift: null,
      expectedEntryTime: null,
    });
  });

  it('valida el identificador antes de enviar', async () => {
    const api = await open(MANAGE);
    await goToGroups();
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(within(dialog).getByText(/Escribe el identificador/)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Grupo'), 'A_B!');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(within(dialog).getByText(/Usa letras sin acentos/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Grupo').getAttribute('aria-invalid')).toBe('true');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('un duplicado (409) se muestra dentro del dialogo', async () => {
    await open(MANAGE, {
      'POST /catalog/groups': () =>
        apiError(
          409,
          'CONFLICT',
          'Ya existe un grupo con ese grado, identificador y turno en el ciclo.',
        ),
    });
    await goToGroups();
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Grupo'), 'A');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Ya existe un grupo/);
  });

  it('edita solo la hora de entrada; ciclo y grado no se pueden cambiar; se puede quitar la hora', async () => {
    const g = group();
    const api = await open(MANAGE, {
      'GET /catalog/groups': () => jsonResponse(200, page([g])),
      [`PATCH /catalog/groups/${g.id}`]: () =>
        jsonResponse(200, { ...g, expectedEntryTime: '07:50' }),
    });
    await goToGroups();
    await userEvent.click(await screen.findByRole('button', { name: /Editar grupo 1.º A/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Ciclo escolar')).toBeNull();
    expect(within(dialog).queryByLabelText('Grado')).toBeNull();
    expect(dialog.textContent).toMatch(/no se pueden cambiar/);
    setValue(within(dialog).getByLabelText('Hora de entrada (opcional)'), '07:50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      expectedEntryTime: '07:50',
    });

    await userEvent.click(await screen.findByRole('button', { name: /Editar grupo 1.º A/ }));
    const second = screen.getByRole('dialog');
    await userEvent.click(
      within(second).getByRole('button', { name: 'Quitar la hora de entrada' }),
    );
    await userEvent.click(within(second).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(api.calls.filter((c) => c.method === 'PATCH')[1]!.body).toEqual({
      expectedEntryTime: null,
    });
  });

  it('desactivar un grupo pide confirmacion y usa la baja logica (PATCH isActive), nunca DELETE', async () => {
    const g = group();
    const api = await open(MANAGE, {
      'GET /catalog/groups': () => jsonResponse(200, page([g])),
      [`PATCH /catalog/groups/${g.id}`]: () => jsonResponse(200, { ...g, isActive: false }),
    });
    await goToGroups();
    await userEvent.click(await screen.findByRole('button', { name: /^Desactivar grupo 1.º A/ }));
    expect(screen.getByRole('dialog').textContent).toMatch(/No se borra/);
    await userEvent.click(screen.getByRole('button', { name: 'Desactivar grupo' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/desactivado/);
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ isActive: false });
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('sin ciclos disponibles no se puede crear un grupo', async () => {
    await open(MANAGE, { 'GET /catalog/school-years': () => jsonResponse(200, page([PAST])) });
    await goToGroups();
    expect(
      (await screen.findByRole('button', { name: 'Nuevo grupo' })).hasAttribute('disabled'),
    ).toBe(true);
  });
});
