import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes de Asignaciones de prefectura (jsdom + `fetch` falso). NO son pruebas de navegador real: comprueban que
 * la interfaz adapta los controles a los permisos efectivos, valida antes de enviar, no manda el ciclo ni ningun actor, y envia lo
 * correcto. Todos los datos son FICTICIOS. La autorizacion real y las reglas son del servidor.
 */
const YEAR = 'aaaaaaaa-0000-4000-8000-000000000001';
const GA = 'bbbbbbbb-0000-4000-8000-000000000001';
const GB = 'bbbbbbbb-0000-4000-8000-000000000002';
const U1 = 'cccccccc-0000-4000-8000-000000000001';
const U2 = 'cccccccc-0000-4000-8000-000000000002';
const AID = 'dddddddd-0000-4000-8000-000000000001';

const groupRef = (id: string, code: string) => ({
  id,
  schoolYearId: YEAR,
  schoolYearName: '2026-2027',
  grade: 1,
  code,
  shift: 'matutino',
});
const assignment = (over: Record<string, unknown> = {}) => ({
  id: AID,
  user: { id: U1, displayName: 'Prefecta Uno Ficticia' },
  group: groupRef(GA, 'A'),
  startsOn: '2026-10-01',
  endsOn: null,
  status: 'active',
  grantsAccess: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  createdBy: 'dir-1',
  revokedAt: null,
  revokedBy: null,
  revocationReason: null,
  ...over,
});
const page = (items: unknown[], over = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  ...over,
});
const year = {
  id: YEAR,
  name: '2026-2027',
  startsOn: '2026-08-31',
  endsOn: '2027-07-15',
  isActive: true,
  period: 'current',
  groupCount: 2,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};
const group = (id: string, code: string) => ({
  ...groupRef(id, code),
  expectedEntryTime: null,
  isActive: true,
  historical: false,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
});
const candidates = [
  { id: U1, displayName: 'Prefecta Uno Ficticia', email: 'uno@escuela.test' },
  { id: U2, displayName: 'Prefecta Dos Ficticia', email: 'dos@escuela.test' },
];

const DIRECCION = [
  'prefect_assignments:read',
  'prefect_assignments:manage',
  'catalog:read',
  'students:read_basic',
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
const base = (perms: string[], extra: Record<string, () => Response> = {}) => ({
  'GET /auth/me': () => jsonResponse(200, meWith(perms)),
  'GET /health': () => jsonResponse(200, { status: 'ok' }),
  'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'csrf-ficticio' }),
  'GET /school/prefect-assignments': () => jsonResponse(200, page([assignment()])),
  'GET /school/prefect-candidates': () => jsonResponse(200, candidates),
  'GET /catalog/school-years': () => jsonResponse(200, page([year])),
  'GET /catalog/groups': () => jsonResponse(200, page([group(GA, 'A'), group(GB, 'B')])),
  ...extra,
});
const open = (perms: string[], extra: Record<string, () => Response> = {}) => {
  const fake = installFakeApi(base(perms, extra));
  renderAt('/prefectura');
  return fake;
};

describe('acceso segun permisos efectivos', () => {
  it('sin permiso (p. ej. la propia prefectura, con alcance propio, o admin_tecnico) no hay enlace ni se llama a la API', async () => {
    const api = installFakeApi({
      ...base(['students:read_basic', 'users:read']),
      'GET /auth/me': () =>
        jsonResponse(200, {
          ...meWith(['students:read_basic']),
          permissions: [
            { permission: 'students:read_basic', scope: 'assigned_groups' },
            { permission: 'prefect_assignments:read', scope: 'own' },
          ],
        }),
    });
    renderAt('/prefectura');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Asignaciones de prefectura' })).toBeNull();
    expect(api.count('GET /school/prefect-assignments')).toBe(0);
    expect(screen.queryByRole('button', { name: 'Asignar grupos' })).toBeNull();
  });

  it('quien solo puede consultar ve el historial sin controles de administracion', async () => {
    open(['prefect_assignments:read']);
    expect(await screen.findByText(/Prefecta Uno Ficticia · 1.º A/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Asignar grupos' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revocar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cerrar la asignación/ })).toBeNull();
  });

  it('Direccion ve el enlace, el listado y los controles', async () => {
    open(DIRECCION);
    expect(await screen.findByText(/Prefecta Uno Ficticia · 1.º A/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Asignar grupos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Revocar el acceso de Prefecta Uno/ })).toBeTruthy();
  });
});

describe('listado e historial', () => {
  it('muestra estados vacio, filtrado sin resultados y error con reintento', async () => {
    let fail = true;
    open(DIRECCION, {
      'GET /school/prefect-assignments': () =>
        fail ? apiError(500, 'INTERNAL_ERROR') : jsonResponse(200, page([])),
    });
    expect(await screen.findByText(/No se pudo cargar la lista de asignaciones/)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText(/Todavía no hay asignaciones/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'revoked');
    expect(await screen.findByText(/No hay asignaciones que coincidan/)).toBeTruthy();
  });

  it('el historial muestra revocadas con su motivo y avisa cuando una vigente no tiene efecto', async () => {
    open(DIRECCION, {
      'GET /school/prefect-assignments': () =>
        jsonResponse(
          200,
          page([
            assignment({ id: 'a1', status: 'active', grantsAccess: false }),
            assignment({
              id: 'a2',
              status: 'revoked',
              grantsAccess: false,
              revokedAt: '2026-10-05T10:00:00.000Z',
              revokedBy: 'dir-1',
              revocationReason: 'Cambio de comision',
            }),
          ]),
        ),
    });
    expect(await screen.findByText(/Sin efecto hoy/)).toBeTruthy();
    expect(screen.getByText(/Motivo: Cambio de comision/)).toBeTruthy();
    // una revocada no ofrece acciones
    expect(screen.getAllByRole('button', { name: /Revocar el acceso/ })).toHaveLength(1);
  });

  it('filtra por prefecta, ciclo y estado enviando los identificadores y vuelve a la primera pagina', async () => {
    const api = open(DIRECCION, {
      'GET /school/prefect-assignments': () =>
        jsonResponse(200, page([assignment()], { total: 45 })),
    });
    await screen.findByText(/Prefecta Uno Ficticia · 1.º A/);
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    await waitFor(() => expect(api.calls.at(-1)!.url).toContain('page=2'));
    await userEvent.selectOptions(await screen.findByLabelText('Prefecta'), U2);
    await waitFor(() => expect(api.calls.at(-1)!.url).toContain(`userId=${U2}`));
    expect(api.calls.at(-1)!.url).toContain('page=1');
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), YEAR);
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'upcoming');
    await waitFor(() => expect(api.calls.at(-1)!.url).toContain('status=upcoming'));
    expect(api.calls.at(-1)!.url).toContain(`schoolYearId=${YEAR}`);
  });
});

describe('asignar grupos', () => {
  const fill = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Asignar grupos' }));
    const dialog = await screen.findByRole('dialog');
    return dialog;
  };

  it('valida antes de enviar, pone el foco en el primer campo invalido y no llama a la API', async () => {
    const api = open(DIRECCION);
    const dialog = await fill();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    expect(within(dialog).getByText('Elige a la prefecta.')).toBeTruthy();
    expect(within(dialog).getByText('Elige al menos un grupo.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Prefecta'));
    expect(api.count('POST /school/prefect-assignments')).toBe(0);
  });

  it('valida fechas: fin anterior al inicio y fuera del ciclo', async () => {
    open(DIRECCION);
    const dialog = await fill();
    await userEvent.selectOptions(within(dialog).getByLabelText('Prefecta'), U1);
    await userEvent.click(await within(dialog).findByLabelText('1.º A'));
    fireEvent.change(within(dialog).getByLabelText(/Desde/), { target: { value: '2026-10-10' } });
    fireEvent.change(within(dialog).getByLabelText(/Hasta/), { target: { value: '2026-10-05' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    expect(within(dialog).getByText(/no puede ser anterior a la inicial/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Desde/), { target: { value: '2028-01-01' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    expect(within(dialog).getByText(/Debe estar entre/)).toBeTruthy();
  });

  it('asigna varios grupos con una peticion por grupo, sin enviar ciclo ni actor, y refresca la lista', async () => {
    const api = open(DIRECCION, {
      'POST /school/prefect-assignments': () => jsonResponse(201, assignment()),
    });
    const dialog = await fill();
    await userEvent.selectOptions(within(dialog).getByLabelText('Prefecta'), U2);
    await userEvent.click(await within(dialog).findByLabelText('1.º A'));
    await userEvent.click(within(dialog).getByLabelText('1.º B'));
    fireEvent.change(within(dialog).getByLabelText(/Hasta/), { target: { value: '2026-12-15' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/2 grupos asignados/);
    const posts = api.calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('prefect-assignments'),
    );
    expect(posts.map((p) => p.body)).toEqual([
      { userId: U2, groupId: GA, endsOn: '2026-12-15' },
      { userId: U2, groupId: GB, endsOn: '2026-12-15' },
    ]);
    expect(posts[0]!.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(JSON.stringify(posts)).not.toMatch(/schoolYearId|actor|createdBy/);
  });

  it('resultado parcial: no declara exito total, lista lo asignado y lo fallido, refresca y reintenta solo lo pendiente', async () => {
    let n = 0;
    let blockB = true;
    const api = open(DIRECCION, {
      'POST /school/prefect-assignments': () => {
        n += 1;
        const groupId = (api.calls.at(-1)!.body as { groupId: string }).groupId;
        if (groupId === GB && blockB)
          return apiError(
            409,
            'OVERLAPS_EXISTING',
            'La prefecta ya tiene ese grupo asignado en un periodo que se traslapa',
          );
        return jsonResponse(
          201,
          assignment({ id: `a-${n}`, group: groupRef(groupId, groupId === GA ? 'A' : 'B') }),
        );
      },
    });
    const dialog = await fill();
    await userEvent.selectOptions(within(dialog).getByLabelText('Prefecta'), U1);
    await userEvent.click(await within(dialog).findByLabelText('1.º A'));
    await userEvent.click(within(dialog).getByLabelText('1.º B'));
    const listCalls = () => api.count('GET /school/prefect-assignments');
    const before = listCalls();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/Resultado parcial: se asignaron 1 de 2 grupos y 1 no/);
    expect(alert.textContent).toMatch(/Asignados correctamente: 1.º A/);
    expect(alert.textContent).toMatch(/1.º B:.*se traslapa/);
    // no hay mensaje de exito total y la lista de la pagina ya muestra lo creado
    expect(screen.queryByText(/grupos? asignados?.$/)).toBeNull();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    expect((within(dialog).getByLabelText('1.º A') as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByLabelText('1.º B') as HTMLInputElement).checked).toBe(true);
    // reintento: solo se envia el grupo pendiente (nada se duplica) y ahora si hay exito total acumulado
    blockB = false;
    const postsBefore = api.calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('prefect-assignments'),
    ).length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/2 grupos asignados/);
    const retried = api.calls
      .filter((c) => c.method === 'POST' && c.url.endsWith('prefect-assignments'))
      .slice(postsBefore);
    expect(retried.map((c) => (c.body as { groupId: string }).groupId)).toEqual([GB]);
  });

  it('si ningun grupo se asigna, lo dice sin hablar de exito y conserva la seleccion', async () => {
    open(DIRECCION, {
      'POST /school/prefect-assignments': () =>
        apiError(
          409,
          'USER_NOT_ELIGIBLE',
          'Solo una cuenta activa con el rol de prefectura puede recibir grupos',
        ),
    });
    const dialog = await fill();
    await userEvent.selectOptions(within(dialog).getByLabelText('Prefecta'), U1);
    await userEvent.click(await within(dialog).findByLabelText('1.º A'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/No se pudo asignar ningún grupo/);
    expect(alert.textContent).toMatch(/1.º A:.*rol de prefectura/);
    expect(alert.textContent).not.toMatch(/Asignados correctamente/);
    expect((within(dialog).getByLabelText('1.º A') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('muestra el aviso claro cuando la base aun no habilita las asignaciones (503)', async () => {
    open(DIRECCION, {
      'POST /school/prefect-assignments': () =>
        apiError(503, 'PREFECT_ASSIGNMENTS_UNAVAILABLE', 'detalle interno que no debe verse'),
    });
    const dialog = await fill();
    await userEvent.selectOptions(within(dialog).getByLabelText('Prefecta'), U1);
    await userEvent.click(await within(dialog).findByLabelText('1.º A'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupos' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/aún no están habilitadas/);
    expect(alert.textContent).not.toMatch(/detalle interno/);
  });
});

describe('cerrar y revocar', () => {
  it('cerrar envia la fecha elegida y confirma', async () => {
    const api = open(DIRECCION, {
      [`POST /school/prefect-assignments/${AID}/close`]: () =>
        jsonResponse(200, assignment({ endsOn: '2026-11-30' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Cerrar la asignación de/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Último día/), {
      target: { value: '2026-11-30' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cerrar asignación' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Asignación cerrada/);
    const call = api.calls.find((c) => c.url.endsWith('/close'))!;
    expect(call.body).toEqual({ endsOn: '2026-11-30' });
  });

  it('revocar exige un motivo, explica el efecto inmediato y envia solo el motivo', async () => {
    const api = open(DIRECCION, {
      [`POST /school/prefect-assignments/${AID}/revoke`]: () =>
        jsonResponse(200, assignment({ status: 'revoked', grantsAccess: false })),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Revocar el acceso de/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/de inmediato/);
    expect(dialog.textContent).toMatch(/sin conexión no recibe el aviso/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revocar acceso' }));
    expect(within(dialog).getByText(/Escribe el motivo/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Motivo'));
    expect(api.count(`POST /school/prefect-assignments/${AID}/revoke`)).toBe(0);
    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Cambio de comision');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revocar acceso' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Acceso revocado de inmediato/);
    expect(api.calls.find((c) => c.url.endsWith('/revoke'))!.body).toEqual({
      reason: 'Cambio de comision',
    });
  });

  it('un rechazo del servidor (409) se muestra en el dialogo sin cerrarlo', async () => {
    open(DIRECCION, {
      [`POST /school/prefect-assignments/${AID}/revoke`]: () =>
        apiError(409, 'ALREADY_REVOKED', 'La asignación ya estaba revocada'),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Revocar el acceso de/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Motivo'), 'Fin de cobertura');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revocar acceso' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/ya estaba revocada/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
