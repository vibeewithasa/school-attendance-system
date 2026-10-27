import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes de Alumnos (jsdom + `fetch` falso). NO son pruebas de navegador real: comprueban que la interfaz adapta
 * los controles a los permisos efectivos, valida antes de enviar, no pide datos fuera del modelo minimo y envia lo correcto.
 * Todos los datos son FICTICIOS. La autorizacion real, el alcance por grupo y las reglas son del servidor.
 */
const SID = 'cccccccc-0000-4000-8000-000000000001';
const EID = 'dddddddd-0000-4000-8000-000000000001';
const YEAR = 'aaaaaaaa-0000-4000-8000-000000000001';
const YEAR2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const GA = 'bbbbbbbb-0000-4000-8000-000000000001';
const GB = 'bbbbbbbb-0000-4000-8000-000000000002';

const groupRef = (id: string, code: string) => ({
  id,
  schoolYearId: YEAR,
  schoolYearName: '2026-2027',
  grade: 1,
  code,
  shift: 'matutino',
});
const student = (over: Record<string, unknown> = {}) => ({
  id: SID,
  givenNames: 'Ana Lucía',
  familyName: 'Pérez Ficticia',
  schoolCode: 'ESC-001',
  isActive: true,
  currentGroup: groupRef(GA, 'A'),
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});
const enrollment = (over: Record<string, unknown> = {}) => ({
  id: EID,
  studentId: SID,
  schoolYearId: YEAR,
  schoolYearName: '2026-2027',
  startsOn: '2026-08-31',
  endsOn: null,
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  assignments: [
    {
      id: 'asg-1',
      enrollmentId: EID,
      group: groupRef(GA, 'A'),
      startsOn: '2026-08-31',
      endsOn: null,
      current: true,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
  ],
  ...over,
});
const year = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  startsOn: '2026-08-31',
  endsOn: '2027-07-15',
  isActive: id === YEAR,
  period: 'current',
  groupCount: 2,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  ...over,
});
const group = (id: string, code: string) => ({
  id,
  schoolYearId: YEAR,
  schoolYearName: '2026-2027',
  grade: 1,
  code,
  shift: 'matutino',
  expectedEntryTime: null,
  isActive: true,
  historical: false,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
});
const page = (items: unknown[], over = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  ...over,
});

const DIRECCION = [
  'students:read_basic',
  'students:read',
  'students:manage',
  'enrollments:manage',
  'catalog:read',
  'catalog:manage_school',
];
const READ_BASIC = ['students:read_basic'];

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
  'GET /school/students': () => jsonResponse(200, page([student()])),
  [`GET /school/students/${SID}`]: () => jsonResponse(200, student()),
  [`GET /school/students/${SID}/enrollments`]: () => jsonResponse(200, [enrollment()]),
  'GET /catalog/school-years': () =>
    jsonResponse(
      200,
      page([year(YEAR, '2026-2027'), year(YEAR2, '2027-2028', { period: 'future' })]),
    ),
  'GET /catalog/groups': () => jsonResponse(200, page([group(GA, 'A'), group(GB, 'B')])),
  ...extra,
});
const setValue = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const open = async (perms: string[], extra: Record<string, () => Response> = {}) => {
  const fake = installFakeApi(base(perms, extra));
  renderAt('/alumnos');
  return fake;
};
const select = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /Pérez Ficticia, Ana Lucía/ }));
  await screen.findByRole('heading', { name: 'Pérez Ficticia, Ana Lucía' });
};

describe('acceso segun permisos efectivos', () => {
  it('sin students:read_basic (p. ej. admin_tecnico) no aparece el enlace y la ruta lo explica sin llamar a la API', async () => {
    const api = installFakeApi(base(['users:read', 'users:manage_technical', 'system:config']));
    renderAt('/alumnos');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No tienes permiso para consultar alumnos/,
    );
    expect(screen.queryByRole('link', { name: 'Alumnos' })).toBeNull();
    expect(api.count('GET /school/students')).toBe(0);
  });

  it('con students:read_basic aparece el enlace "Alumnos" y se lista, sin controles de escritura ni expediente', async () => {
    const api = installFakeApi(base(READ_BASIC));
    renderAt('/');
    await userEvent.click(await screen.findByRole('link', { name: 'Alumnos' }));
    await select();
    expect(screen.queryByRole('button', { name: 'Registrar alumno' })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /Corregir datos|Desactivar alumno|Inscribir en un ciclo/,
      }),
    ).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Matrículas por ciclo' })).toBeNull();
    expect(api.count(`GET /school/students/${SID}/enrollments`)).toBe(0); // sin students:read no se pide el expediente
    expect(screen.queryByLabelText('Ciclo escolar')).toBeNull(); // sin catalog:read no hay filtros del catalogo
  });

  it('un error al cargar ofrece reintentar; 503 explica que el modulo aun no esta habilitado', async () => {
    let mode: 'fail' | 'down' | 'ok' = 'fail';
    installFakeApi({
      ...base(DIRECCION),
      'GET /school/students': () =>
        mode === 'fail'
          ? apiError(500, 'INTERNAL_ERROR')
          : mode === 'down'
            ? apiError(503, 'STUDENTS_UNAVAILABLE', 'detalle interno')
            : jsonResponse(200, page([student()])),
    });
    renderAt('/alumnos');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo/);
    mode = 'down';
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/aún no está habilitado/),
    );
    expect(screen.getByRole('alert').textContent).not.toMatch(/detalle interno/);
    mode = 'ok';
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText(/Pérez Ficticia, Ana Lucía/)).toBeTruthy();
  });
});

describe('listado, busqueda y filtros', () => {
  it('muestra grupo vigente, busca (min. 2 letras) y filtra por ciclo y grupo en el servidor', async () => {
    const api = await open(DIRECCION);
    expect(
      await screen.findByText(/Código ESC-001 · 1\.º A · matutino|Código ESC-001 · 1\.º A/),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Buscar por nombre o código'), 'Pé');
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.includes('/school/students?')).at(-1)!.url).toContain(
        'q=',
      ),
    );
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), YEAR);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.includes('/school/students?')).at(-1)!.url).toContain(
        `schoolYearId=${YEAR}`,
      ),
    );
    await userEvent.selectOptions(await screen.findByLabelText('Grupo'), GB);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.includes('/school/students?')).at(-1)!.url).toContain(
        `groupId=${GB}`,
      ),
    );
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'inactive');
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.includes('/school/students?')).at(-1)!.url).toContain(
        'isActive=false',
      ),
    );
  });

  it('estados vacios con y sin filtros', async () => {
    installFakeApi({
      ...base(DIRECCION),
      'GET /school/students': () => jsonResponse(200, page([])),
    });
    renderAt('/alumnos');
    expect(await screen.findByText(/Todavía no hay alumnos\. Registra el primero/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'active');
    expect(await screen.findByText(/No hay alumnos que coincidan/)).toBeTruthy();
  });
});

describe('registro y correccion de alumnos (datos minimos)', () => {
  it('el formulario solo pide nombre, apellidos y codigo opcional: nada de CURP, nacimiento, tutores ni contacto', async () => {
    await open(DIRECCION);
    await userEvent.click(await screen.findByRole('button', { name: 'Registrar alumno' }));
    const dialog = screen.getByRole('dialog');
    const fields = [...dialog.querySelectorAll('input,select,textarea')].map((e) =>
      e.id ? dialog.querySelector(`label[for="${e.id}"]`)?.textContent : '',
    );
    expect(fields).toEqual(['Nombre o nombres', 'Apellidos', 'Código escolar (opcional)']);
    expect(dialog.textContent).not.toMatch(/CURP|nacimiento|tutor|teléfono|dirección|foto|médic/i);
  });

  it('valida antes de enviar y lleva el foco al primer campo con error', async () => {
    const api = await open(DIRECCION);
    await userEvent.click(await screen.findByRole('button', { name: 'Registrar alumno' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Registrar alumno' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Nombre o nombres'));
    expect(within(dialog).getAllByText(/Escribe/).length).toBe(2);
    await userEvent.type(within(dialog).getByLabelText('Nombre o nombres'), 'Ana2');
    await userEvent.type(within(dialog).getByLabelText('Apellidos'), 'Pérez');
    await userEvent.type(within(dialog).getByLabelText('Código escolar (opcional)'), 'A B');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Registrar alumno' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Nombre o nombres'));
    expect(within(dialog).getByText(/Solo letras/)).toBeTruthy();
    expect(within(dialog).getByText(/Letras A-Z sin acentos/)).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('registra con nombres normalizados y codigo canonico, con CSRF; avisa y abre el detalle', async () => {
    const api = await open(DIRECCION, {
      'POST /school/students': () => jsonResponse(201, student()),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Registrar alumno' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nombre o nombres'), '  Ana   Lucía ');
    await userEvent.type(within(dialog).getByLabelText('Apellidos'), 'Pérez Ficticia');
    await userEvent.type(within(dialog).getByLabelText('Código escolar (opcional)'), ' esc-001 ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Registrar alumno' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/registrado/);
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      givenNames: 'Ana Lucía',
      familyName: 'Pérez Ficticia',
      schoolCode: 'ESC-001',
    });
    expect(post.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(await screen.findByRole('heading', { name: 'Pérez Ficticia, Ana Lucía' })).toBeTruthy();
  });

  it('el codigo es opcional (se envia null) y un codigo duplicado (409) se muestra dentro del dialogo', async () => {
    let dup = false;
    const api = await open(DIRECCION, {
      'POST /school/students': () =>
        dup
          ? apiError(409, 'DUPLICATE_SCHOOL_CODE', 'Ya existe un alumno con ese código escolar')
          : jsonResponse(201, student({ schoolCode: null })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Registrar alumno' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Nombre o nombres'), 'Ana');
    await userEvent.type(within(dialog).getByLabelText('Apellidos'), 'Pérez');
    dup = true;
    await userEvent.type(within(dialog).getByLabelText('Código escolar (opcional)'), 'ESC-001');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Registrar alumno' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /Ya existe un alumno con ese código/,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    dup = false;
    await userEvent.clear(within(dialog).getByLabelText('Código escolar (opcional)'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Registrar alumno' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(api.calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({
      givenNames: 'Ana',
      familyName: 'Pérez',
      schoolCode: null,
    });
  });

  it('corrige datos enviando solo lo que cambio; sin cambios no llama a la API', async () => {
    const api = await open(DIRECCION, {
      [`PATCH /school/students/${SID}`]: () =>
        jsonResponse(200, student({ familyName: 'Pérez Corregida' })),
    });
    await select();
    await userEvent.click(screen.getByRole('button', { name: 'Corregir datos' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/No hay cambios/);
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
    await userEvent.clear(within(dialog).getByLabelText('Apellidos'));
    await userEvent.type(within(dialog).getByLabelText('Apellidos'), 'Pérez Corregida');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      familyName: 'Pérez Corregida',
    });
  });
});

describe('detalle, matriculas e historial de grupos', () => {
  it('muestra matriculas por ciclo con su historial de grupos y acciones segun permisos', async () => {
    await open(DIRECCION, {
      [`GET /school/students/${SID}/enrollments`]: () =>
        jsonResponse(200, [
          enrollment({
            assignments: [
              {
                id: 'a1',
                enrollmentId: EID,
                group: groupRef(GA, 'A'),
                startsOn: '2026-08-31',
                endsOn: '2026-09-29',
                current: false,
                createdAt: '2026-10-01T10:00:00.000Z',
              },
              {
                id: 'a2',
                enrollmentId: EID,
                group: groupRef(GB, 'B'),
                startsOn: '2026-09-30',
                endsOn: null,
                current: true,
                createdAt: '2026-10-01T10:00:00.000Z',
              },
            ],
          }),
        ]),
    });
    await select();
    expect(await screen.findByRole('heading', { name: 'Matrículas por ciclo' })).toBeTruthy();
    const history = await screen.findByRole('list', { name: 'Grupos del ciclo 2026-2027' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/1\.º A.*29 sep 2026/);
    expect(items[1]!.textContent).toMatch(/1\.º B/);
    expect(items[1]!.textContent).toContain('Hoy');
    expect(
      screen.getByRole('button', { name: /Trasladar de grupo en el ciclo 2026-2027/ }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Asignar grupo en el ciclo/ })).toBeNull(); // ya tiene grupo
    expect(screen.getByRole('button', { name: /Dar de baja la matrícula del ciclo/ })).toBeTruthy();
  });

  it('una matricula con baja o de un ciclo terminado es historial: sin acciones', async () => {
    await open(DIRECCION, {
      [`GET /school/students/${SID}/enrollments`]: () =>
        jsonResponse(200, [
          enrollment({ status: 'withdrawn', endsOn: '2026-10-01' }),
          enrollment({
            id: 'e2',
            status: 'completed',
            schoolYearName: '2025-2026',
            schoolYearId: 'y0',
          }),
        ]),
    });
    await select();
    await screen.findByText('Ciclo 2025-2026');
    expect(
      screen.queryByRole('button', { name: /Trasladar|Dar de baja la matrícula|Asignar grupo/ }),
    ).toBeNull();
    expect(
      screen.getAllByText('Con baja').length + screen.getAllByText('Ciclo terminado').length,
    ).toBeGreaterThan(1);
  });

  it('inscribe en un ciclo no inscrito (retroactivo opcional) y envia el cuerpo correcto', async () => {
    const api = await open(DIRECCION, {
      [`POST /school/students/${SID}/enrollments`]: () =>
        jsonResponse(
          201,
          enrollment({
            id: 'e9',
            schoolYearId: YEAR2,
            schoolYearName: '2027-2028',
            status: 'upcoming',
          }),
        ),
    });
    await select();
    await userEvent.click(await screen.findByRole('button', { name: 'Inscribir en un ciclo' }));
    const dialog = screen.getByRole('dialog');
    const yearSelect = within(dialog).getByLabelText('Ciclo escolar') as HTMLSelectElement;
    expect([...yearSelect.options].map((o) => o.textContent)).toEqual(['2027-2028']); // el vigente ya esta inscrito
    setValue(within(dialog).getByLabelText('Primer día inscrito (opcional)'), '2027-01-10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inscribir' }));
    expect((await screen.findByRole('status')).textContent).toMatch(
      /inscrito en el ciclo 2027-2028/,
    );
    expect(
      api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/enrollments'))!.body,
    ).toEqual({ schoolYearId: YEAR2, startsOn: '2027-01-10' });
  });

  it('valida la fecha de inscripcion fuera del ciclo con foco en el campo', async () => {
    const api = await open(DIRECCION);
    await select();
    await userEvent.click(await screen.findByRole('button', { name: 'Inscribir en un ciclo' }));
    const dialog = screen.getByRole('dialog');
    setValue(within(dialog).getByLabelText('Primer día inscrito (opcional)'), '2020-01-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inscribir' }));
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText('Primer día inscrito (opcional)'),
    );
    expect(within(dialog).getByText(/La fecha debe estar entre/)).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('traslada de grupo: excluye el grupo actual, envia effectiveOn y muestra SAME_DAY del servidor', async () => {
    let reject = true;
    const api = await open(DIRECCION, {
      [`POST /school/enrollments/${EID}/transfer`]: () =>
        reject
          ? apiError(
              409,
              'SAME_DAY',
              'La asignación vigente empezó ese mismo día: el modelo trabaja con días y no admite dos grupos el mismo día',
            )
          : jsonResponse(200, enrollment()),
    });
    await select();
    await userEvent.click(
      await screen.findByRole('button', { name: /Trasladar de grupo en el ciclo/ }),
    );
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: /1\.º B/ });
    expect(within(dialog).queryByRole('option', { name: /1\.º A/ })).toBeNull(); // el grupo actual no se ofrece
    await userEvent.selectOptions(within(dialog).getByLabelText('Grupo nuevo'), GB);
    setValue(
      within(dialog).getByLabelText('Primer día en el grupo nuevo (opcional)'),
      '2026-11-02',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trasladar' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /no admite dos grupos el mismo día/,
    );
    reject = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trasladar' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Traslado de grupo registrado/);
    const posts = api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/transfer'));
    expect(posts[1]!.body).toEqual({ groupId: GB, effectiveOn: '2026-11-02' });
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('valida que se elija un grupo (foco en el campo) antes de trasladar', async () => {
    const api = await open(DIRECCION);
    await select();
    await userEvent.click(
      await screen.findByRole('button', { name: /Trasladar de grupo en el ciclo/ }),
    );
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: /1\.º B/ });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trasladar' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Grupo nuevo'));
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('asigna el primer grupo de una matricula sin grupo', async () => {
    const api = await open(DIRECCION, {
      [`GET /school/students/${SID}/enrollments`]: () =>
        jsonResponse(200, [enrollment({ assignments: [] })]),
      [`POST /school/enrollments/${EID}/group-assignments`]: () => jsonResponse(201, enrollment()),
    });
    await select();
    await userEvent.click(await screen.findByRole('button', { name: /Asignar grupo en el ciclo/ }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: /1\.º A/ });
    await userEvent.selectOptions(within(dialog).getByLabelText('Grupo'), GA);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar grupo' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Grupo asignado/);
    expect(
      api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/group-assignments'))!.body,
    ).toEqual({ groupId: GA });
  });

  it('da de baja la matricula con fecha opcional, sin borrar', async () => {
    const api = await open(DIRECCION, {
      [`POST /school/enrollments/${EID}/withdraw`]: () =>
        jsonResponse(200, enrollment({ status: 'withdrawn', endsOn: '2026-10-30' })),
    });
    await select();
    await userEvent.click(
      await screen.findByRole('button', { name: /Dar de baja la matrícula del ciclo/ }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/No se borra\s+nada/);
    setValue(within(dialog).getByLabelText('Último día inscrito (opcional)'), '2026-10-30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dar de baja' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Baja de matrícula registrada/);
    expect(api.calls.find((c) => c.url.endsWith('/withdraw'))!.body).toEqual({
      endsOn: '2026-10-30',
    });
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('desactivar pide confirmacion y muestra el rechazo si hay una matricula sin baja', async () => {
    let block = true;
    const api = await open(DIRECCION, {
      [`POST /school/students/${SID}/deactivate`]: () =>
        block
          ? apiError(
              409,
              'HAS_OPEN_ENROLLMENT',
              'El alumno tiene una matrícula sin baja: da de baja la matrícula antes de desactivarlo',
            )
          : jsonResponse(200, student({ isActive: false })),
    });
    await select();
    await userEvent.click(await screen.findByRole('button', { name: 'Desactivar alumno' }));
    expect(screen.getByRole('dialog').textContent).toMatch(/No se borra nada/);
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Desactivar alumno' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Desactivar alumno' }),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/matrícula sin baja/);
    block = false;
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Desactivar alumno' }),
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/desactivado/);
  });

  it('un alumno inactivo ofrece reactivar y no ofrece inscribir', async () => {
    await open(DIRECCION, {
      [`GET /school/students/${SID}`]: () => jsonResponse(200, student({ isActive: false })),
    });
    await select();
    expect(await screen.findByRole('button', { name: 'Reactivar alumno' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inscribir en un ciclo' })).toBeNull();
  });
});
