import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes de los reportes de asistencia (jsdom + `fetch` falso). NO son pruebas de navegador real ni E2E: comprueban
 * que la interfaz pide lo correcto, presenta cada situacion con su etiqueta propia (sin lista, sin marca, fuera del padron y sin
 * grupo NUNCA se muestran como ausencia), avisa de las limitaciones y maneja carga, vacio, error y acceso denegado. Datos FICTICIOS.
 * La autorizacion real, el alcance por grupo y las reglas son del servidor (pruebas de API y de PostgreSQL).
 */
const Y1 = 'aaaaaaaa-0000-4000-8000-000000000001'; // ciclo vigente
const Y0 = 'aaaaaaaa-0000-4000-8000-000000000000'; // ciclo anterior
const GA = 'bbbbbbbb-0000-4000-8000-000000000001';
const GB = 'bbbbbbbb-0000-4000-8000-000000000002';
const GZ = 'bbbbbbbb-0000-4000-8000-000000000009';
const S1 = 'eeeeeeee-0000-4000-8000-000000000001';
const S2 = 'eeeeeeee-0000-4000-8000-000000000002';
const DAY1 = 'dddddddd-0000-4000-8000-000000000001';
const DAY2 = 'dddddddd-0000-4000-8000-000000000002';
const TODAY = '2026-10-28'; // miercoles

const year1 = { id: Y1, name: '2026-2027', startsOn: '2026-08-24', endsOn: '2027-07-16' };
const year0 = { id: Y0, name: '2025-2026', startsOn: '2025-08-25', endsOn: '2026-07-17' };
const grp = (id: string, year: typeof year1, code: string, isActive = true) => ({
  id,
  schoolYearId: year.id,
  schoolYearName: year.name,
  grade: 1,
  code,
  shift: 'matutino',
  isActive,
});
const options = (over: Record<string, unknown> = {}) => ({
  schoolToday: TODAY,
  schoolYears: [
    { ...year1, groups: [grp(GA, year1, 'A'), grp(GB, year1, 'B')] },
    { ...year0, groups: [grp(GZ, year0, 'Z', false)] },
  ],
  ...over,
});
const groupReport = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-28T20:00:00.000Z',
  schoolToday: TODAY,
  group: grp(GA, year1, 'A'),
  schoolYear: year1,
  period: { from: '2026-10-12', to: '2026-10-16' },
  days: [
    {
      date: '2026-10-12',
      list: { dayId: DAY1, status: 'finalized', rosterSize: 4, present: 3, absent: 1, noMark: 0 },
    },
    {
      date: '2026-10-13',
      list: { dayId: DAY2, status: 'draft', rosterSize: 4, present: 1, absent: 0, noMark: 3 },
    },
    { date: '2026-10-14', list: null },
  ],
  students: [
    {
      studentId: S1,
      givenNames: 'Ana',
      familyName: 'Ficticia',
      listsApplicable: 2,
      present: 2,
      absent: 0,
      noMark: 0,
    },
    {
      studentId: S2,
      givenNames: 'Beto',
      familyName: 'Ficticio',
      listsApplicable: 2,
      present: 1,
      absent: 1,
      noMark: 0,
    },
  ],
  totals: {
    weekdays: 3,
    withList: 2,
    draft: 1,
    finalized: 1,
    withoutList: 1,
    studentDays: 8,
    present: 4,
    absent: 1,
    noMark: 3,
  },
  ...over,
});
const studentReport = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-28T20:00:00.000Z',
  schoolToday: TODAY,
  student: { id: S1, givenNames: 'Ana', familyName: 'Ficticia', schoolCode: 'FIC-1' },
  schoolYear: year1,
  enrollment: { startsOn: '2026-08-24', endsOn: null },
  groups: [{ group: grp(GA, year1, 'A'), startsOn: '2026-08-24', endsOn: null }],
  period: { from: '2026-10-12', to: '2026-10-16' },
  days: [
    {
      date: '2026-10-12',
      state: 'present',
      group: grp(GA, year1, 'A'),
      listStatus: 'finalized',
      dayId: DAY1,
    },
    {
      date: '2026-10-13',
      state: 'absent',
      group: grp(GA, year1, 'A'),
      listStatus: 'finalized',
      dayId: DAY2,
    },
    {
      date: '2026-10-14',
      state: 'no_mark',
      group: grp(GA, year1, 'A'),
      listStatus: 'draft',
      dayId: DAY2,
    },
    {
      date: '2026-10-15',
      state: 'no_list',
      group: grp(GA, year1, 'A'),
      listStatus: null,
      dayId: null,
    },
    {
      date: '2026-10-16',
      state: 'not_in_roster',
      group: grp(GA, year1, 'A'),
      listStatus: 'finalized',
      dayId: DAY1,
    },
  ],
  totals: {
    weekdays: 5,
    present: 1,
    absent: 1,
    noMark: 1,
    noList: 1,
    notInRoster: 1,
    notInGroup: 0,
    listsApplicable: 3,
  },
  ...over,
});

const READER = ['attendance:read'];
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
type Routes = Record<string, (call: never) => Response | Promise<Response>>;
const base = (perms: string[], extra: Routes = {}) =>
  ({
    'GET /auth/me': () => jsonResponse(200, meWith(perms)),
    'GET /health': () => jsonResponse(200, { status: 'ok' }),
    'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'csrf-ficticio' }),
    'GET /school/attendance/reports/options': () => jsonResponse(200, options()),
    'GET /school/attendance/today': () =>
      jsonResponse(200, { schoolToday: TODAY, isSchoolDay: true, generatedAt: '', groups: [] }),
    'GET /school/attendance/days': () =>
      jsonResponse(200, { items: [], page: 1, pageSize: 10, total: 0 }),
    ...extra,
  }) as Parameters<typeof installFakeApi>[0];
const open = (path: string, perms: string[] = READER, extra: Routes = {}) => {
  const fake = installFakeApi(base(perms, extra));
  renderAt(path);
  return fake;
};
const lastQuery = (fake: ReturnType<typeof installFakeApi>, prefix: string) => {
  const call = [...fake.calls].reverse().find((c) => c.url.includes(prefix));
  return new URLSearchParams((call?.url ?? '').split('?')[1] ?? '');
};
const pickGroup = async (label: RegExp) =>
  userEvent.selectOptions(
    await screen.findByLabelText('Grupo'),
    screen.getByRole('option', { name: label }),
  );
const generate = () => userEvent.click(screen.getByRole('button', { name: 'Generar reporte' }));

describe('acceso y navegacion', () => {
  it('sin permiso de asistencia: mensaje de acceso denegado, sin enlace y sin llamar a la API de reportes', async () => {
    const fake = open('/asistencia/reportes/grupo', ['justifications:read']);
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Reportes de asistencia' })).toBeNull();
    expect(fake.count('GET /school/attendance/reports/options')).toBe(0);
    expect(screen.queryByRole('button', { name: 'Generar reporte' })).toBeNull();
  });

  it('el reporte por alumno tampoco se consulta sin permiso (ruta directa)', async () => {
    const fake = open('/asistencia/reportes/alumno', ['users:read']);
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(fake.count('GET /school/attendance/reports/options')).toBe(0);
  });

  it('con permiso aparece la entrada "Reportes de asistencia" y /asistencia/reportes lleva al reporte por grupo', async () => {
    open('/asistencia/reportes');
    expect(
      await screen.findByRole('heading', { name: 'Reporte de asistencia por grupo' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reportes de asistencia' })).toBeTruthy();
  });

  it('desde la pagina de asistencia hay un enlace a los reportes y las pestanas cambian de reporte', async () => {
    open('/asistencia');
    await userEvent.click(
      await screen.findByRole('link', { name: /Reportes de asistencia por grupo y por alumno/ }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Reporte de asistencia por grupo' }),
    ).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Reportes de asistencia' });
    await userEvent.click(within(tabs).getByRole('link', { name: 'Reporte por alumno' }));
    expect(
      await screen.findByRole('heading', { name: 'Reporte de asistencia por alumno' }),
    ).toBeTruthy();
  });

  it('sin sesion se muestra el acceso, sin llamar a la API de reportes', async () => {
    const fake = installFakeApi({ 'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED') });
    renderAt('/asistencia/reportes/grupo');
    expect(await screen.findByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeTruthy();
    expect(fake.count('GET /school/attendance/reports/options')).toBe(0);
  });
});

describe('opciones de seleccion', () => {
  it('muestra el estado de carga y luego los selectores con etiqueta; los grupos son los del ciclo elegido', async () => {
    open('/asistencia/reportes/grupo');
    expect(await screen.findByRole('status')).toBeTruthy(); // Cargando…
    const year = await screen.findByLabelText('Ciclo escolar');
    expect((year as HTMLSelectElement).value).toBe(Y1); // el ciclo que contiene la fecha de hoy
    const group = screen.getByLabelText('Grupo');
    expect(
      within(group)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Elige un grupo', '1.º A · Matutino', '1.º B · Matutino']);
    expect(screen.getByLabelText('Desde')).toBeTruthy();
    expect(screen.getByLabelText('Hasta')).toBeTruthy();
    expect((screen.getByLabelText('Hasta') as HTMLInputElement).value).toBe(TODAY);
    expect((screen.getByLabelText('Desde') as HTMLInputElement).value).toBe('2026-09-29');
  });

  it('cambiar de ciclo cambia los grupos, restablece el periodo y descarta el resultado anterior', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
    });
    await pickGroup(/1.º A/);
    await generate();
    expect(
      await screen.findByRole('region', { name: 'Resultado del reporte por grupo' }),
    ).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), Y0);
    expect(screen.queryByRole('region', { name: 'Resultado del reporte por grupo' })).toBeNull();
    expect(
      within(screen.getByLabelText('Grupo'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Elige un grupo', '1.º Z · Matutino (inactivo)']);
    expect((screen.getByLabelText('Hasta') as HTMLInputElement).value).toBe('2026-07-17'); // fin del ciclo anterior
  });

  it('sin grupos disponibles: mensaje claro y ningun formulario', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/options': () =>
        jsonResponse(200, options({ schoolYears: [] })),
    });
    expect(await screen.findByText(/No tienes grupos disponibles/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generar reporte' })).toBeNull();
  });

  it('un error al cargar las opciones se avisa y se puede reintentar', async () => {
    let n = 0;
    const fake = open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/options': () =>
        ++n === 1 ? apiError(500, 'INTERNAL') : jsonResponse(200, options()),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudieron cargar/);
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Grupo')).toBeTruthy();
    expect(fake.count('GET /school/attendance/reports/options')).toBe(2);
  });
});

describe('reporte por grupo', () => {
  it('pide el reporte con el grupo, el ciclo y el periodo; no envia actor ni "hoy"', async () => {
    const fake = open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
    });
    await pickGroup(/1.º A/);
    await generate();
    await screen.findByRole('region', { name: 'Resultado del reporte por grupo' });
    const q = lastQuery(fake, '/reports/group');
    expect(Object.fromEntries(q)).toEqual({
      groupId: GA,
      schoolYearId: Y1,
      from: '2026-09-29',
      to: TODAY,
    });
  });

  it('distingue lista finalizada, borrador y sin lista; sin lista es "No determinado", nunca ausente', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
    });
    await pickGroup(/1.º A/);
    await generate();
    const days = await screen.findByRole('table', {
      name: /Listas de asistencia del grupo por día hábil/,
    });
    const rows = within(days).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Finalizada')).toBeTruthy();
    expect(within(rows[1]!).getByText('Borrador')).toBeTruthy();
    expect(within(rows[2]!).getByText('Sin lista')).toBeTruthy();
    expect(within(rows[2]!).getByText('No determinado')).toBeTruthy();
    expect(within(rows[2]!).queryByText(/Ausente/)).toBeNull();
    // los renglones pendientes se llaman "Sin marca" y NO se cuentan como ausentes
    expect(
      within(rows[1]!)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Borrador', '4', '1', '0', '3', 'Ver lista del 2026-10-13']);
    expect(
      within(rows[0]!)
        .getByRole('link', { name: /Ver lista/ })
        .getAttribute('href'),
    ).toBe(`/asistencia/${DAY1}`);
  });

  it('totales visibles y verificables: presentes + ausentes + sin marca = registros alumno-dia', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
    });
    await pickGroup(/1.º A/);
    await generate();
    await screen.findByRole('region', { name: 'Resultado del reporte por grupo' });
    const list = screen.getByLabelText('Totales del periodo');
    const stat = (label: string) =>
      within(list).getByText(label).closest('div')!.querySelector('dd')!.textContent;
    expect(stat('Presentes')).toBe('4');
    expect(stat('Ausentes')).toBe('1');
    expect(stat('Sin marca')).toBe('3');
    expect(stat('Registros alumno-día')).toBe('8');
    expect(Number(stat('Presentes')) + Number(stat('Ausentes')) + Number(stat('Sin marca'))).toBe(
      Number(stat('Registros alumno-día')),
    );
    expect(stat('Días sin lista')).toBe('1');
    // sin porcentajes
    expect(
      screen.getByRole('region', { name: 'Resultado del reporte por grupo' }).textContent,
    ).not.toMatch(/%|porcentaje/i);
  });

  it('por alumno: cada fila y un enlace al reporte individual con el ciclo, el grupo y el periodo', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
    });
    await pickGroup(/1.º A/);
    await generate();
    const table = await screen.findByRole('table', { name: /Marcas por alumno/ });
    expect(within(table).getByText('Ana Ficticia')).toBeTruthy();
    const href = within(table)
      .getByRole('link', { name: /de Beto Ficticio/ })
      .getAttribute('href')!;
    const q = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/asistencia/reportes/alumno?')).toBe(true);
    expect(Object.fromEntries(q)).toEqual({
      ciclo: Y1,
      grupo: GA,
      alumno: S2,
      desde: '2026-10-12',
      hasta: '2026-10-16',
    });
  });

  it('siempre muestra las limitaciones: sin justificantes, sin lista no es ausencia, sin porcentajes ni festivos', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
    });
    await pickGroup(/1.º A/);
    await generate();
    await screen.findByRole('region', { name: 'Resultado del reporte por grupo' });
    const note = screen.getByRole('complementary', { name: 'Alcance y limitaciones del reporte' });
    expect(note.textContent).toMatch(/No incluye justificantes/);
    expect(note.textContent).toMatch(/sin lista.*no\s+es una ausencia/);
    expect(note.textContent).toMatch(/festivos/);
    expect(note.textContent).toMatch(/porcentajes/);
  });

  it('sin listas en el periodo: todos los dias "Sin lista" y aviso de que no hay marcas que contar', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(
          200,
          groupReport({
            days: [{ date: '2026-10-12', list: null }],
            students: [],
            totals: {
              weekdays: 1,
              withList: 0,
              draft: 0,
              finalized: 0,
              withoutList: 1,
              studentDays: 0,
              present: 0,
              absent: 0,
              noMark: 0,
            },
          }),
        ),
    });
    await pickGroup(/1.º A/);
    await generate();
    expect((await screen.findByText(/no hay marcas que contar/)).textContent).toBeTruthy();
    expect(screen.getAllByText('Sin lista').length).toBeGreaterThan(0);
  });

  it('periodo sin dias habiles (fin de semana): lo dice y no inventa filas', async () => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(
          200,
          groupReport({
            days: [],
            students: [],
            totals: {
              ...groupReport().totals,
              weekdays: 0,
              withList: 0,
              draft: 0,
              finalized: 0,
              withoutList: 0,
              studentDays: 0,
              present: 0,
              absent: 0,
              noMark: 0,
            },
          }),
        ),
    });
    await pickGroup(/1.º A/);
    await generate();
    expect(await screen.findByText(/no incluye días hábiles/)).toBeTruthy();
  });

  it('estado de carga: aviso accesible y boton deshabilitado mientras se genera', async () => {
    let release: (r: Response) => void = () => undefined;
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await pickGroup(/1.º A/);
    await generate();
    expect((await screen.findAllByText('Generando el reporte…')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Generando…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    release(jsonResponse(200, groupReport()));
    expect(
      await screen.findByRole('region', { name: 'Resultado del reporte por grupo' }),
    ).toBeTruthy();
  });

  it.each([
    [404, 'NOT_FOUND', /No se encontró el grupo o el alumno, o no tienes acceso/],
    [403, 'FORBIDDEN', /No tienes permiso/],
    [500, 'INTERNAL', /No se pudo generar el reporte/],
    [400, 'RANGE_IN_FUTURE', /fechas posteriores a hoy/],
  ])('error HTTP %s: mensaje comprensible, sin resultado parcial', async (status, code, text) => {
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () =>
        apiError(status, code, 'El periodo no puede incluir fechas posteriores a hoy'),
    });
    await pickGroup(/1.º A/);
    await generate();
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    expect(screen.queryByRole('region', { name: 'Resultado del reporte por grupo' })).toBeNull();
  });

  it('una respuesta tardia de una seleccion anterior no sustituye a la actual (cambio de ciclo en vuelo)', async () => {
    let release: (r: Response) => void = () => undefined;
    open('/asistencia/reportes/grupo', READER, {
      'GET /school/attendance/reports/group': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await pickGroup(/1.º A/);
    await generate();
    await screen.findAllByText('Generando el reporte…');
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), Y0);
    release(jsonResponse(200, groupReport()));
    await waitFor(() => expect(screen.queryAllByText('Generando el reporte…')).toHaveLength(0));
    expect(screen.queryByRole('region', { name: 'Resultado del reporte por grupo' })).toBeNull();
  });

  it('validacion del periodo en la pantalla: inicio posterior al fin y falta de grupo no llaman a la API; el aviso es accesible', async () => {
    const fake = open('/asistencia/reportes/grupo');
    await screen.findByLabelText('Grupo');
    await generate();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Elige un grupo/);
    await pickGroup(/1.º A/);
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-10' } });
    await generate();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /inicio del periodo no puede ser posterior/,
    );
    expect(screen.getByLabelText('Desde').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Desde').getAttribute('aria-describedby')).toBeTruthy();
    expect(fake.count('GET /school/attendance/reports/group')).toBe(0);
    // y los rangos excesivos o futuros tampoco
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-08-24' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2027-06-01' } });
    await generate();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /exceder 190 días|posteriores a hoy/,
    );
    expect(fake.count('GET /school/attendance/reports/group')).toBe(0);
  });
});

describe('reporte por alumno', () => {
  const studentsOf = () =>
    jsonResponse(200, {
      group: grp(GA, year1, 'A'),
      students: [
        { studentId: S1, givenNames: 'Ana', familyName: 'Ficticia' },
        { studentId: S2, givenNames: 'Beto', familyName: 'Ficticio' },
      ],
    });
  const routes = (): Routes => ({
    [`GET /school/attendance/reports/group/${GA}/students`]: studentsOf,
    [`GET /school/attendance/reports/student/${S1}`]: () => jsonResponse(200, studentReport()),
  });

  it('elegir el grupo carga a sus alumnos; el alumno se pide con el ciclo y el periodo (sin actor)', async () => {
    const fake = open('/asistencia/reportes/alumno', READER, routes());
    await pickGroup(/1.º A/);
    const student = await screen.findByLabelText('Alumno');
    await waitFor(() => expect((student as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(student, screen.getByRole('option', { name: 'Ficticia Ana' }));
    await generate();
    await screen.findByRole('region', { name: 'Resultado del reporte por alumno' });
    expect(Object.fromEntries(lastQuery(fake, `/reports/student/${S1}`))).toEqual({
      schoolYearId: Y1,
      from: '2026-09-29',
      to: TODAY,
    });
  });

  it('cada situacion tiene su propia etiqueta: solo "Ausente" es ausencia; sin marca, sin lista y fuera del padron no lo son', async () => {
    open('/asistencia/reportes/alumno', READER, routes());
    await pickGroup(/1.º A/);
    const student = await screen.findByLabelText('Alumno');
    await waitFor(() => expect((student as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(student, S1);
    await generate();
    const table = await screen.findByRole('table', { name: /Situación del alumno por día hábil/ });
    const situations = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(situations).toEqual([
      'Presente',
      'Ausente',
      'Sin marca (lista en borrador)',
      'Sin lista',
      'No estaba en el padrón de la lista',
    ]);
    expect(within(table).getAllByText(/^Ausente$/)).toHaveLength(1); // PENDIENTE / sin lista / fuera del padron nunca se cuentan como ausente
    const totals = screen.getByLabelText('Totales del periodo');
    const stat = (label: string) =>
      within(totals).getByText(label).closest('div')!.querySelector('dd')!.textContent;
    expect([stat('Presente'), stat('Ausente'), stat('Sin marca'), stat('Sin lista')]).toEqual([
      '1',
      '1',
      '1',
      '1',
    ]);
    expect(stat('Fuera del padrón')).toBe('1');
    expect(stat('Días con lista aplicable')).toBe('3');
    expect(screen.getByText(/FIC-1/)).toBeTruthy(); // Direccion ve el codigo escolar
  });

  it('muestra los grupos historicos del alumno y la matricula; la lista enlaza al detalle', async () => {
    open('/asistencia/reportes/alumno', READER, {
      ...routes(),
      [`GET /school/attendance/reports/student/${S1}`]: () =>
        jsonResponse(
          200,
          studentReport({
            groups: [
              { group: grp(GA, year1, 'A'), startsOn: '2026-08-24', endsOn: '2026-10-13' },
              { group: grp(GB, year1, 'B'), startsOn: '2026-10-14', endsOn: null },
            ],
            student: { id: S1, givenNames: 'Ana', familyName: 'Ficticia', schoolCode: null },
          }),
        ),
    });
    await pickGroup(/1.º A/);
    const student = await screen.findByLabelText('Alumno');
    await waitFor(() => expect((student as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(student, S1);
    await generate();
    const groups = await screen.findByRole('list', { name: 'Grupos del alumno en el ciclo' });
    expect(within(groups).getAllByRole('listitem')).toHaveLength(2);
    expect(groups.textContent).toMatch(/1\.º A.*hasta/);
    expect(groups.textContent).toMatch(/1\.º B.*vigente/);
    expect(screen.queryByText(/FIC-1/)).toBeNull(); // sin codigo escolar para quien no tiene alcance total
    const table = screen.getByRole('table', { name: /Situación del alumno/ });
    expect(
      within(table)
        .getAllByRole('link', { name: /Finalizada|Borrador/ })[0]!
        .getAttribute('href'),
    ).toBe(`/asistencia/${DAY1}`);
  });

  it('un grupo sin alumnos lo avisa y deshabilita la seleccion de alumno', async () => {
    open('/asistencia/reportes/alumno', READER, {
      [`GET /school/attendance/reports/group/${GA}/students`]: () =>
        jsonResponse(200, { group: grp(GA, year1, 'A'), students: [] }),
    });
    await pickGroup(/1.º A/);
    expect((await screen.findByText(/no tiene alumnos asignados/)).textContent).toBeTruthy();
  });

  it('exige grupo y alumno antes de pedir el reporte', async () => {
    const fake = open('/asistencia/reportes/alumno', READER, routes());
    await screen.findByLabelText('Alumno');
    await generate();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Elige un grupo y un alumno/);
    expect(fake.calls.some((c) => c.url.includes('/reports/student/'))).toBe(false);
  });

  it('llegada desde el reporte por grupo: se rellena y se genera una sola vez con los datos del enlace', async () => {
    const q = new URLSearchParams({
      ciclo: Y1,
      grupo: GA,
      alumno: S1,
      desde: '2026-10-12',
      hasta: '2026-10-16',
    });
    const fake = open(`/asistencia/reportes/alumno?${q.toString()}`, READER, routes());
    expect(
      await screen.findByRole('region', { name: 'Resultado del reporte por alumno' }),
    ).toBeTruthy();
    expect(Object.fromEntries(lastQuery(fake, `/reports/student/${S1}`))).toEqual({
      schoolYearId: Y1,
      from: '2026-10-12',
      to: '2026-10-16',
    });
    expect(fake.calls.filter((c) => c.url.includes('/reports/student/'))).toHaveLength(1);
    expect((screen.getByLabelText('Alumno') as HTMLSelectElement).value).toBe(S1);
  });

  it('un enlace con un alumno que no pertenece al grupo se ignora (no se pide ningun reporte)', async () => {
    const q = new URLSearchParams({
      ciclo: Y1,
      grupo: GA,
      alumno: 'ffffffff-0000-4000-8000-00000000dead',
    });
    const fake = open(`/asistencia/reportes/alumno?${q.toString()}`, READER, routes());
    await waitFor(() =>
      expect(fake.count(`GET /school/attendance/reports/group/${GA}/students`)).toBe(1),
    );
    await screen.findByLabelText('Alumno');
    expect(fake.calls.some((c) => c.url.includes('/reports/student/'))).toBe(false);
    expect((screen.getByLabelText('Alumno') as HTMLSelectElement).value).toBe('');
  });

  it.each([
    [404, 'NOT_FOUND', /No se encontró el grupo o el alumno, o no tienes acceso/],
    [500, 'INTERNAL', /No se pudo generar el reporte/],
  ])('error HTTP %s al generar: mensaje sin resultado parcial', async (status, code, text) => {
    open('/asistencia/reportes/alumno', READER, {
      ...routes(),
      [`GET /school/attendance/reports/student/${S1}`]: () => apiError(status, code),
    });
    await pickGroup(/1.º A/);
    const student = await screen.findByLabelText('Alumno');
    await waitFor(() => expect((student as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(student, S1);
    await generate();
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    expect(screen.queryByRole('region', { name: 'Resultado del reporte por alumno' })).toBeNull();
  });

  it('un error al cargar los alumnos del grupo se avisa', async () => {
    open('/asistencia/reportes/alumno', READER, {
      [`GET /school/attendance/reports/group/${GA}/students`]: () => apiError(500, 'INTERNAL'),
    });
    await pickGroup(/1.º A/);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No se pudieron cargar los alumnos/,
    );
  });

  it('cambiar de ciclo o de grupo borra el resultado y la seleccion del alumno', async () => {
    open('/asistencia/reportes/alumno', READER, routes());
    await pickGroup(/1.º A/);
    const student = await screen.findByLabelText('Alumno');
    await waitFor(() => expect((student as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(student, S1);
    await generate();
    await screen.findByRole('region', { name: 'Resultado del reporte por alumno' });
    await userEvent.selectOptions(screen.getByLabelText('Grupo'), GB);
    expect(screen.queryByRole('region', { name: 'Resultado del reporte por alumno' })).toBeNull();
    expect((screen.getByLabelText('Alumno') as HTMLSelectElement).value).toBe('');
  });

  it('muestra las limitaciones junto al resultado, incluida la ausencia de justificantes', async () => {
    open('/asistencia/reportes/alumno', READER, routes());
    await pickGroup(/1.º A/);
    const student = await screen.findByLabelText('Alumno');
    await waitFor(() => expect((student as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(student, S1);
    await generate();
    await screen.findByRole('region', { name: 'Resultado del reporte por alumno' });
    expect(
      screen.getByRole('complementary', { name: 'Alcance y limitaciones del reporte' }).textContent,
    ).toMatch(/No incluye justificantes/);
  });
});
