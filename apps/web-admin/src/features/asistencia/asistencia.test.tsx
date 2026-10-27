import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes de Asistencia (jsdom + `fetch` falso). NO son pruebas de navegador real: comprueban que la interfaz adapta
 * los controles a los permisos y al estado que declara el servidor, que no envia fechas ni actores, que no sobrescribe en silencio
 * ante un conflicto y que envia lo correcto. Todos los datos son FICTICIOS. La autorizacion real y las reglas son del servidor.
 */
const YEAR = 'aaaaaaaa-0000-4000-8000-000000000001';
const GA = 'bbbbbbbb-0000-4000-8000-000000000001';
const GB = 'bbbbbbbb-0000-4000-8000-000000000002';
const DAY = 'dddddddd-0000-4000-8000-000000000001';
const S1 = 'eeeeeeee-0000-4000-8000-000000000001';
const S2 = 'eeeeeeee-0000-4000-8000-000000000002';
const S3 = 'eeeeeeee-0000-4000-8000-000000000003';
const TODAY = '2026-10-28'; // miercoles

const groupRef = (id: string, code: string) => ({
  id,
  schoolYearId: YEAR,
  schoolYearName: '2026-2027',
  grade: 1,
  code,
  shift: 'matutino',
});
const rec = (studentId: string, givenNames: string, status = 'pending') => ({
  studentId,
  givenNames,
  familyName: 'Ficticia',
  status,
  markedAt: status === 'pending' ? null : '2026-10-28T15:00:00.000Z',
});
const detail = (over: Record<string, unknown> = {}) => ({
  id: DAY,
  group: groupRef(GA, 'A'),
  attendanceDate: TODAY,
  status: 'draft',
  revision: 1,
  counts: { total: 3, present: 0, absent: 0, pending: 3 },
  createdAt: '2026-10-28T14:00:00.000Z',
  finalizedAt: null,
  createdBy: null,
  finalizedBy: null,
  schoolToday: TODAY,
  editable: true,
  records: [rec(S1, 'Ana'), rec(S2, 'Beto'), rec(S3, 'Carla')],
  discrepancies: { addedToRoster: 0, removedFromRoster: 0 },
  ...over,
});
/** La forma "resumen" de una lista (sin renglones ni datos de la consulta individual), como en GET /today y en el listado. */
const summary = (d: ReturnType<typeof detail>) => {
  const rest: Record<string, unknown> = { ...d };
  for (const key of ['records', 'schoolToday', 'editable', 'discrepancies']) delete rest[key];
  return rest;
};
const todayWith = (over: Record<string, unknown> = {}) => ({
  schoolToday: TODAY,
  isSchoolDay: true,
  generatedAt: '2026-10-28T14:00:00.000Z',
  groups: [
    { group: groupRef(GA, 'A'), canCapture: true, day: null },
    { group: groupRef(GB, 'B'), canCapture: true, day: null },
  ],
  ...over,
});
const emptyList = { items: [], page: 1, pageSize: 10, total: 0 };

const PREFECTA = ['attendance:read', 'attendance:capture'];
const SUPERVISION = ['attendance:read'];

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
  'GET /school/attendance/today': () => jsonResponse(200, todayWith()),
  'GET /school/attendance/days': () => jsonResponse(200, emptyList),
  [`GET /school/attendance/days/${DAY}`]: () => jsonResponse(200, detail()),
  ...extra,
});
const openPage = (path: string, perms: string[], extra: Record<string, () => Response> = {}) => {
  const fake = installFakeApi(base(perms, extra));
  renderAt(path);
  return fake;
};
const radio = (student: string, label: 'Presente' | 'Ausente') =>
  within(screen.getByRole('radiogroup', { name: `Asistencia de ${student} Ficticia` })).getByRole(
    'radio',
    { name: label },
  );
const saveBtn = () => screen.getByRole('button', { name: 'Guardar borrador' });
const finalizeBtn = () => screen.getByRole('button', { name: 'Finalizar lista' });

describe('acceso segun permisos efectivos', () => {
  it('sin permiso de asistencia (p. ej. trabajo social o control de acceso) no hay enlace ni se llama a la API', async () => {
    const api = openPage('/asistencia', ['justifications:read']);
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Asistencia' })).toBeNull();
    expect(api.count('GET /school/attendance/today')).toBe(0);
  });

  it('la lista de un grupo tampoco se consulta sin permiso (ruta directa)', async () => {
    const api = openPage(`/asistencia/${DAY}`, ['users:read']);
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(api.count(`GET /school/attendance/days/${DAY}`)).toBe(0);
  });

  it('las rutas de asistencia exigen sesion: sin ella se muestra el acceso, sin llamar a la API de asistencia', async () => {
    const api = installFakeApi({ 'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED') });
    renderAt('/asistencia');
    expect(await screen.findByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeTruthy();
    expect(api.count('GET /school/attendance/today')).toBe(0);
  });
});

describe('grupos del dia', () => {
  it('la prefecta ve la fecha escolar y SUS grupos con el boton de abrir la lista', async () => {
    openPage('/asistencia', PREFECTA);
    expect(
      await screen.findByRole('heading', { name: /Hoy:.*28 de octubre de 2026/i }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Asistencia' })).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'Grupos del día' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Abrir la lista de 1.º A/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Abrir la lista de 1.º B/ })).toBeTruthy();
  });

  it('abre la lista enviando SOLO el grupo (nunca una fecha ni un actor) y muestra a los alumnos', async () => {
    const api = openPage('/asistencia', PREFECTA, {
      'POST /school/attendance/days': () => jsonResponse(201, { day: detail(), created: true }),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Abrir la lista de 1.º A/ }));
    expect(await screen.findByText('Ana Ficticia')).toBeTruthy();
    const post = api.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/school/attendance/days'),
    )!;
    expect(post.body).toEqual({ groupId: GA });
    expect(post.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(screen.getByRole('heading', { name: /1.º A/ })).toBeTruthy();
  });

  it('en fin de semana no ofrece abrir listas y avisa; las anteriores siguen consultables', async () => {
    openPage('/asistencia', PREFECTA, {
      'GET /school/attendance/today': () =>
        jsonResponse(200, todayWith({ schoolToday: '2026-10-31', isSchoolDay: false })),
    });
    expect(await screen.findByText(/no se toma lista en sábado ni domingo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Abrir la lista/ })).toBeNull();
  });

  it('una lista ya abierta ofrece continuarla (no crea otra) y la cuenta de supervision solo puede verla', async () => {
    const d = summary(detail({ counts: { total: 3, present: 1, absent: 0, pending: 2 } }));
    const withDay = () =>
      jsonResponse(
        200,
        todayWith({ groups: [{ group: groupRef(GA, 'A'), canCapture: true, day: d }] }),
      );
    const api = openPage('/asistencia', PREFECTA, { 'GET /school/attendance/today': withDay });
    expect(await screen.findByRole('link', { name: /Continuar la lista de 1.º A/ })).toBeTruthy();
    expect(screen.getByText('1 de 3 marcados')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Abrir la lista/ })).toBeNull();
    expect(api.count('POST /school/attendance/days')).toBe(0);
  });

  it('Direccion (solo lectura) no ve controles de captura', async () => {
    openPage('/asistencia', SUPERVISION, {
      'GET /school/attendance/today': () =>
        jsonResponse(
          200,
          todayWith({
            groups: [
              { group: groupRef(GA, 'A'), canCapture: false, day: null },
              {
                group: groupRef(GB, 'B'),
                canCapture: false,
                day: summary(detail({ group: groupRef(GB, 'B') })),
              },
            ],
          }),
        ),
    });
    // (esperar primero a lo que depende de la respuesta de la API: el texto de introduccion aparece antes que los grupos)
    expect(await screen.findByRole('link', { name: /Ver la lista de 1.º B/ })).toBeTruthy();
    expect(screen.getByText(/Consulta de supervisión/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Abrir la lista/ })).toBeNull();
    expect(screen.getByText('Sin lista abierta hoy.')).toBeTruthy();
  });

  it('muestra error con reintento y el estado de base sin habilitar', async () => {
    let fail = true;
    openPage('/asistencia', PREFECTA, {
      'GET /school/attendance/today': () =>
        fail ? apiError(503, 'ATTENDANCE_UNAVAILABLE') : jsonResponse(200, todayWith()),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/aún no está habilitada/);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: /Abrir la lista de 1.º A/ })).toBeTruthy();
  });

  it('el aviso de un error al abrir recibe el foco (lector de pantalla)', async () => {
    openPage('/asistencia', PREFECTA, {
      'POST /school/attendance/days': () => apiError(409, 'EMPTY_ROSTER', 'x'),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Abrir la lista de 1.º A/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no tiene alumnos inscritos/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe('captura y borrador', () => {
  it('muestra a los alumnos como pendientes, marca presente/ausente y actualiza los conteos', async () => {
    openPage(`/asistencia/${DAY}`, PREFECTA);
    expect(await screen.findByText('Ana Ficticia')).toBeTruthy();
    expect(screen.getAllByText('Pendiente')).toHaveLength(3);
    expect(
      screen.getByText(/Marcados: 0 de 3 · Presentes: 0 · Ausentes: 0 · Pendientes: 3/),
    ).toBeTruthy();
    await userEvent.click(radio('Ana', 'Presente'));
    await userEvent.click(radio('Beto', 'Ausente'));
    expect((radio('Ana', 'Presente') as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(/Marcados: 2 de 3 · Presentes: 1 · Ausentes: 1 · Pendientes: 1/),
    ).toBeTruthy();
    expect(screen.getByText(/cambios sin guardar/)).toBeTruthy();
    expect(screen.getAllByText('Pendiente')).toHaveLength(1);
  });

  it('guardar envia solo lo que cambio, la revision vista y un identificador de solicitud; no finaliza con pendientes', async () => {
    const saved = detail({
      revision: 2,
      counts: { total: 3, present: 1, absent: 1, pending: 1 },
      records: [rec(S1, 'Ana', 'present'), rec(S2, 'Beto', 'absent'), rec(S3, 'Carla')],
    });
    const api = openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`POST /school/attendance/days/${DAY}/marks`]: () =>
        jsonResponse(200, { day: saved, changed: 2, replayed: false }),
    });
    await screen.findByText('Ana Ficticia');
    expect((saveBtn() as HTMLButtonElement).disabled).toBe(true); // nada que guardar
    await userEvent.click(radio('Ana', 'Presente'));
    await userEvent.click(radio('Beto', 'Ausente'));
    expect((finalizeBtn() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Guarda tus cambios para poder finalizar/)).toBeTruthy();
    await userEvent.click(saveBtn());
    expect(await screen.findByText('Borrador guardado.')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/marks'))!;
    expect(post.body).toMatchObject({ expectedRevision: 1 });
    const body = post.body as {
      requestId: string;
      marks: Array<{ studentId: string; status: string }>;
    };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...body.marks].sort((a, b) => a.studentId.localeCompare(b.studentId))).toEqual([
      { studentId: S1, status: 'present' },
      { studentId: S2, status: 'absent' },
    ]);
    expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'marks', 'requestId']);
    // queda un pendiente: no se puede finalizar
    expect((finalizeBtn() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Faltan 1 por marcar para poder finalizar/)).toBeTruthy();
    expect(api.count(`POST /school/attendance/days/${DAY}/finalize`)).toBe(0);
  });

  it('volver a elegir el valor guardado descarta el cambio local', async () => {
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () =>
        jsonResponse(
          200,
          detail({ records: [rec(S1, 'Ana', 'present'), rec(S2, 'Beto'), rec(S3, 'Carla')] }),
        ),
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(radio('Ana', 'Ausente'));
    expect(screen.getByText(/cambios sin guardar/)).toBeTruthy();
    await userEvent.click(radio('Ana', 'Presente'));
    expect(screen.queryByText(/cambios sin guardar/)).toBeNull();
    expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
  });

  it('un fallo de red conserva las marcas y el reintento reutiliza el MISMO identificador (no duplica historial)', async () => {
    let first = true;
    const api = openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`POST /school/attendance/days/${DAY}/marks`]: () => {
        if (first) {
          first = false;
          throw new TypeError('network down');
        }
        return jsonResponse(200, { day: detail({ revision: 2 }), changed: 1, replayed: false });
      },
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(radio('Ana', 'Presente'));
    await userEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo contactar/);
    expect((radio('Ana', 'Presente') as HTMLInputElement).checked).toBe(true); // la marca sigue ahi
    await userEvent.click(saveBtn());
    expect(await screen.findByText('Borrador guardado.')).toBeTruthy();
    const ids = api.calls
      .filter((c) => c.method === 'POST' && c.url.endsWith('/marks'))
      .map((c) => (c.body as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('conflictos con otra persona', () => {
  it('409 de revision: avisa, no pierde las marcas locales, y al recargar respeta lo que otra persona ya marco', async () => {
    let reloaded = false;
    const api = openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`POST /school/attendance/days/${DAY}/marks`]: () => apiError(409, 'REVISION_CONFLICT', 'x'),
      [`GET /school/attendance/days/${DAY}`]: () =>
        jsonResponse(
          200,
          reloaded
            ? detail({
                revision: 3,
                counts: { total: 3, present: 0, absent: 1, pending: 2 },
                // otra persona marco a Ana como AUSENTE mientras yo la tenia como presente
                records: [rec(S1, 'Ana', 'absent'), rec(S2, 'Beto'), rec(S3, 'Carla')],
              })
            : detail(),
        ),
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(radio('Ana', 'Presente'));
    await userEvent.click(radio('Carla', 'Presente'));
    await userEvent.click(saveBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Otra persona modificó esta lista/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    // nada se sobrescribio: las marcas locales siguen visibles y sin guardar
    expect((radio('Ana', 'Presente') as HTMLInputElement).checked).toBe(true);
    expect((radio('Carla', 'Presente') as HTMLInputElement).checked).toBe(true);
    reloaded = true;
    await userEvent.click(within(alert).getByRole('button', { name: 'Recargar la lista' }));
    expect(await screen.findByText(/1 alumno ya había sido marcado por otra persona/)).toBeTruthy();
    expect((radio('Ana', 'Ausente') as HTMLInputElement).checked).toBe(true); // se respeta el valor de la otra persona
    expect((radio('Carla', 'Presente') as HTMLInputElement).checked).toBe(true); // mi marca de Carla sigue sin guardar
    expect(screen.queryByRole('alert')).toBeNull();
    // al guardar ahora envia la revision nueva y solo Carla
    api.calls.length = 0;
    await userEvent.click(saveBtn()).catch(() => undefined);
    const post = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/marks'));
    expect(post?.body).toMatchObject({
      expectedRevision: 3,
      marks: [{ studentId: S3, status: 'present' }],
    });
  });

  it('finalizar con revision vieja (otra persona guardo despues) pide recargar y no finaliza', async () => {
    const all = detail({
      counts: { total: 3, present: 3, absent: 0, pending: 0 },
      records: [rec(S1, 'Ana', 'present'), rec(S2, 'Beto', 'present'), rec(S3, 'Carla', 'present')],
    });
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () => jsonResponse(200, all),
      [`POST /school/attendance/days/${DAY}/finalize`]: () =>
        apiError(409, 'REVISION_CONFLICT', 'x'),
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(finalizeBtn());
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Finalizar' }),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /modificó esta lista antes de finalizarla/,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Recargar la lista' })).toBeTruthy();
  });

  it('si la lista se finalizo mientras tanto, guardar lo informa y la recarga la muestra bloqueada', async () => {
    let finalized = false;
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () =>
        jsonResponse(
          200,
          finalized
            ? detail({
                status: 'finalized',
                editable: false,
                revision: 5,
                finalizedAt: '2026-10-28T16:00:00.000Z',
                counts: { total: 3, present: 3, absent: 0, pending: 0 },
                records: [
                  rec(S1, 'Ana', 'present'),
                  rec(S2, 'Beto', 'present'),
                  rec(S3, 'Carla', 'present'),
                ],
              })
            : detail(),
        ),
      [`POST /school/attendance/days/${DAY}/marks`]: () => {
        finalized = true;
        return apiError(409, 'DAY_FINALIZED', 'x');
      },
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(radio('Ana', 'Ausente'));
    await userEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/ya fue finalizada/);
    expect(await screen.findByText(/fue finalizada y ya no se puede modificar/)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('finalizar', () => {
  const complete = detail({
    counts: { total: 3, present: 2, absent: 1, pending: 0 },
    records: [rec(S1, 'Ana', 'present'), rec(S2, 'Beto', 'absent'), rec(S3, 'Carla', 'present')],
  });

  it('con todos marcados pide confirmacion con el resumen, envia la revision y deja la lista en solo lectura', async () => {
    const finalized = detail({
      status: 'finalized',
      editable: false,
      revision: 2,
      finalizedAt: '2026-10-28T16:00:00.000Z',
      counts: complete.counts,
      records: complete.records,
    });
    const api = openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () => jsonResponse(200, complete),
      [`POST /school/attendance/days/${DAY}/finalize`]: () =>
        jsonResponse(200, { day: finalized, alreadyFinalized: false }),
    });
    await screen.findByText('Ana Ficticia');
    expect((finalizeBtn() as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(finalizeBtn());
    const dialog = screen.getByRole('dialog', { name: 'Finalizar la lista' });
    expect(dialog.textContent).toMatch(/2 presente\(s\) y 1 ausente\(s\)/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(api.count(`POST /school/attendance/days/${DAY}/finalize`)).toBe(0);
    await userEvent.click(finalizeBtn());
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Finalizar' }),
    );
    expect(await screen.findByText(/Lista finalizada\. Ya no se puede modificar/)).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/finalize'))!;
    expect(post.body).toEqual({ expectedRevision: 1 });
    // bloqueo de la edicion ordinaria y consulta conservada
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guardar borrador' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finalizar lista' })).toBeNull();
    expect(screen.getAllByText('Presente')).toHaveLength(2);
    expect(screen.getByText('Ausente')).toBeTruthy();
    expect(screen.getAllByText('Finalizada').length).toBeGreaterThan(0);
  });

  it('un error al finalizar se muestra dentro del dialogo y no cierra la lista', async () => {
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () => jsonResponse(200, complete),
      [`POST /school/attendance/days/${DAY}/finalize`]: () => apiError(409, 'DAY_NOT_CURRENT', 'x'),
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(finalizeBtn());
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Finalizar' }),
    );
    expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toMatch(
      /fecha escolar cambió/,
    );
  });
});

describe('solo lectura y proteccion', () => {
  it('una lista de un dia anterior se muestra sin controles de edicion', async () => {
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () =>
        jsonResponse(200, detail({ editable: false, schoolToday: '2026-10-29' })),
    });
    expect(await screen.findByText(/es de un día anterior/)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guardar borrador' })).toBeNull();
  });

  it('la cuenta de supervision ve la lista sin controles, con los alumnos y su estado', async () => {
    openPage(`/asistencia/${DAY}`, SUPERVISION, {
      [`GET /school/attendance/days/${DAY}`]: () =>
        jsonResponse(
          200,
          detail({
            editable: false,
            records: [rec(S1, 'Ana', 'present'), rec(S2, 'Beto'), rec(S3, 'Carla')],
          }),
        ),
    });
    expect(await screen.findByText(/Consulta de supervisión/)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finalizar lista' })).toBeNull();
    expect(screen.getByText('Presente')).toBeTruthy();
    expect(screen.getAllByText('Pendiente')).toHaveLength(2);
  });

  it('un identificador de otro grupo o inexistente (404) no revela nada y ofrece volver', async () => {
    openPage('/asistencia/ffffffff-0000-4000-8000-0000000000ff', PREFECTA, {
      'GET /school/attendance/days/ffffffff-0000-4000-8000-0000000000ff': () =>
        apiError(404, 'NOT_FOUND', 'No se encontró la lista de asistencia'),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No se encontró la lista o ya no tienes acceso/,
    );
    expect(screen.getByRole('link', { name: /Volver a asistencia/ })).toBeTruthy();
    expect(screen.queryByText('Ana Ficticia')).toBeNull();
  });

  it('avisa del cambio de padron despues de abrir la lista, sin modificarla', async () => {
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`GET /school/attendance/days/${DAY}`]: () =>
        jsonResponse(200, detail({ discrepancies: { addedToRoster: 1, removedFromRoster: 2 } })),
    });
    expect((await screen.findByText(/El padrón del grupo cambió/)).textContent).toMatch(
      /1 alumno\(s\) nuevo\(s\), 2 que ya no está/,
    );
    expect(screen.getAllByRole('radiogroup')).toHaveLength(3); // los renglones no cambiaron
  });

  it('una sesion que vence al guardar regresa al acceso', async () => {
    openPage(`/asistencia/${DAY}`, PREFECTA, {
      [`POST /school/attendance/days/${DAY}/marks`]: () => apiError(401, 'UNAUTHENTICATED'),
    });
    await screen.findByText('Ana Ficticia');
    await userEvent.click(radio('Ana', 'Presente'));
    await userEvent.click(saveBtn());
    expect(await screen.findByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeTruthy();
  });

  it('accesibilidad: cada alumno es un grupo de opciones nombrado, el resumen es una region viva y no hay botones sin nombre', async () => {
    const { container } = openPage(`/asistencia/${DAY}`, PREFECTA) && { container: document.body };
    await screen.findByText('Ana Ficticia');
    expect(screen.getAllByRole('radiogroup').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Asistencia de Ana Ficticia',
      'Asistencia de Beto Ficticia',
      'Asistencia de Carla Ficticia',
    ]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(/Marcados/);
    for (const b of screen.getAllByRole('button'))
      expect((b.textContent ?? '').trim().length).toBeGreaterThan(0);
  });
});
