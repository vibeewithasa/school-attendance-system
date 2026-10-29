import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';
import { FOLLOWUP_NOTICE } from './FollowupPage';

/**
 * Pruebas de componentes de «Seguimiento de ausencias» (jsdom + `fetch` falso). NO son E2E ni pruebas de navegador real: comprueban
 * que la pantalla reutiliza el reporte por grupo, cuenta solo ausencias registradas, ordena de forma determinista, avisa de los datos
 * incompletos, no ofrece acciones ni lenguaje de alerta y maneja todos los estados. Datos FICTICIOS. La autorizacion, el alcance y
 * las reglas son del servidor (pruebas de API y de PostgreSQL).
 */
const Y1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const Y0 = 'aaaaaaaa-0000-4000-8000-000000000000';
const GA = 'bbbbbbbb-0000-4000-8000-000000000001';
const GB = 'bbbbbbbb-0000-4000-8000-000000000002';
const GZ = 'bbbbbbbb-0000-4000-8000-000000000009';
const TODAY = '2026-10-28';
const year1 = { id: Y1, name: '2026-2027', startsOn: '2026-08-24', endsOn: '2027-07-16' };
const year0 = { id: Y0, name: '2025-2026', startsOn: '2025-08-25', endsOn: '2026-07-17' };
const grp = (id: string, year: typeof year1, code: string) => ({
  id,
  schoolYearId: year.id,
  schoolYearName: year.name,
  grade: 1,
  code,
  shift: 'matutino',
  isActive: true,
});
const options = (over: Record<string, unknown> = {}) => ({
  schoolToday: TODAY,
  schoolYears: [
    { ...year1, groups: [grp(GA, year1, 'A'), grp(GB, year1, 'B')] },
    { ...year0, groups: [grp(GZ, year0, 'Z')] },
  ],
  ...over,
});
const st = (
  id: string,
  givenNames: string,
  familyName: string,
  present: number,
  absent: number,
  noMark = 0,
) => ({
  studentId: id,
  givenNames,
  familyName,
  listsApplicable: present + absent + noMark,
  present,
  absent,
  noMark,
});
const S = {
  a: 'eeeeeeee-0000-4000-8000-00000000000a',
  b: 'eeeeeeee-0000-4000-8000-00000000000b',
  c: 'eeeeeeee-0000-4000-8000-00000000000c',
  d: 'eeeeeeee-0000-4000-8000-00000000000d',
};
const sumOf = (students: ReturnType<typeof st>[], k: 'present' | 'absent' | 'noMark') =>
  students.reduce((acc, s) => acc + s[k], 0);
const groupReport = (
  students = [
    st(S.a, 'Ana', 'Zamora', 3, 2),
    st(S.b, 'Beto', 'Álvarez', 5, 0),
    st(S.c, 'Carla', 'Zamora', 3, 2), // empata con Ana: decide el nombre
    st(S.d, 'Dora', 'Pérez', 1, 4),
  ],
  totals: Record<string, number> = {},
) => ({
  generatedAt: '2026-10-28T20:00:00.000Z',
  schoolToday: TODAY,
  group: grp(GA, year1, 'A'),
  schoolYear: year1,
  period: { from: '2026-09-29', to: TODAY },
  days: [],
  students,
  totals: {
    weekdays: 22,
    withList: 5,
    draft: 0,
    finalized: 5,
    withoutList: 17,
    studentDays: sumOf(students, 'present') + sumOf(students, 'absent') + sumOf(students, 'noMark'),
    present: sumOf(students, 'present'),
    absent: sumOf(students, 'absent'),
    noMark: sumOf(students, 'noMark'),
    ...totals,
  },
});
const COMPLETE = { weekdays: 5, withList: 5, draft: 0, finalized: 5, withoutList: 0 };

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
type Routes = Parameters<typeof installFakeApi>[0];
const base = (perms: string[], extra: Routes = {}): Routes => ({
  'GET /auth/me': () => jsonResponse(200, meWith(perms)),
  'GET /health': () => jsonResponse(200, { status: 'ok' }),
  'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'csrf-ficticio' }),
  'GET /school/attendance/reports/options': () => jsonResponse(200, options()),
  'GET /school/attendance/reports/group': () => jsonResponse(200, groupReport()),
  'GET /school/attendance/today': () =>
    jsonResponse(200, { schoolToday: TODAY, isSchoolDay: true, generatedAt: '', groups: [] }),
  'GET /school/attendance/days': () =>
    jsonResponse(200, { items: [], page: 1, pageSize: 10, total: 0 }),
  ...extra,
});
const PATH = '/asistencia/reportes/seguimiento';
const open = (path = PATH, perms = READER, extra: Routes = {}) => {
  const fake = installFakeApi(base(perms, extra));
  renderAt(path);
  return fake;
};
const pickGroup = async (label: RegExp) =>
  userEvent.selectOptions(
    await screen.findByLabelText('Grupo'),
    screen.getByRole('option', { name: label }),
  );
const consult = () =>
  userEvent.click(screen.getByRole('button', { name: 'Consultar seguimiento' }));
const loaded = async (path = PATH, perms = READER, extra: Routes = {}) => {
  const fake = open(path, perms, extra);
  await pickGroup(/1.º A/);
  await consult();
  await screen.findByRole('region', { name: 'Resultado del seguimiento de ausencias' });
  return fake;
};
const order = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getByRole('rowheader').textContent);
const lastQuery = (fake: ReturnType<typeof installFakeApi>) =>
  new URLSearchParams(
    ([...fake.calls].reverse().find((c) => c.url.includes('/reports/group'))?.url ?? '').split(
      '?',
    )[1] ?? '',
  );

describe('acceso y navegacion', () => {
  it('sin permiso de asistencia (p. ej. Trabajo Social con justifications:*): acceso denegado y sin llamar a la API de reportes', async () => {
    const fake = open(PATH, ['justifications:read', 'justifications:create']);
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(fake.calls.some((c) => c.url.includes('/reports/'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Consultar seguimiento' })).toBeNull();
  });

  it('sin sesion se muestra el acceso, sin llamar a la API de reportes', async () => {
    const fake = installFakeApi({ 'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED') });
    renderAt(PATH);
    expect(await screen.findByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeTruthy();
    expect(fake.calls.some((c) => c.url.includes('/reports/'))).toBe(false);
  });

  it('la pestana «Seguimiento de ausencias» esta entre los reportes y navega entre ellos', async () => {
    open('/asistencia/reportes/grupo');
    const tabs = await screen.findByRole('navigation', { name: 'Reportes de asistencia' });
    await userEvent.click(within(tabs).getByRole('link', { name: 'Seguimiento de ausencias' }));
    expect(await screen.findByRole('heading', { name: 'Seguimiento de ausencias' })).toBeTruthy();
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Reportes de asistencia' })).getByRole('link', {
        name: 'Reporte por alumno',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Reporte de asistencia por alumno' }),
    ).toBeTruthy();
  });

  it('la aclaracion obligatoria es visible desde el principio, antes de consultar', async () => {
    open();
    await screen.findByLabelText('Grupo');
    expect(screen.getByRole('note').textContent).toBe(FOLLOWUP_NOTICE);
    expect(FOLLOWUP_NOTICE).toBe(
      'Los conteos reflejan únicamente ausencias registradas. No incluyen reglas de justificantes ni representan alertas oficiales.',
    );
  });
});

describe('estados de carga y de seleccion', () => {
  it('cargando, luego selectores con etiqueta y periodo predeterminado; sin grupos disponibles se avisa', async () => {
    open();
    expect(await screen.findByText('Cargando…')).toBeTruthy();
    expect(((await screen.findByLabelText('Ciclo escolar')) as HTMLSelectElement).value).toBe(Y1);
    expect((screen.getByLabelText('Desde') as HTMLInputElement).value).toBe('2026-09-29');
    expect((screen.getByLabelText('Hasta') as HTMLInputElement).value).toBe(TODAY);
  });

  it('sin grupos disponibles', async () => {
    open(PATH, READER, {
      'GET /school/attendance/reports/options': () =>
        jsonResponse(200, options({ schoolYears: [] })),
    });
    expect(await screen.findByText(/No tienes grupos disponibles/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Consultar seguimiento' })).toBeNull();
  });

  it('error al cargar las opciones con reintento', async () => {
    let n = 0;
    open(PATH, READER, {
      'GET /school/attendance/reports/options': () =>
        ++n === 1 ? apiError(500, 'INTERNAL') : jsonResponse(200, options()),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudieron cargar/);
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Grupo')).toBeTruthy();
  });

  it('exige elegir un grupo; no consulta sin el', async () => {
    const fake = open();
    await screen.findByLabelText('Grupo');
    await consult();
    expect((await screen.findByText('Elige un grupo.')).getAttribute('role')).toBe('alert');
    expect(fake.calls.some((c) => c.url.includes('/reports/group'))).toBe(false);
  });

  it('periodo invertido o futuro: aviso accesible y ninguna llamada', async () => {
    const fake = open();
    await pickGroup(/1.º A/);
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-10' } });
    await consult();
    expect(
      (await screen.findByText(/inicio del periodo no puede ser posterior/)).getAttribute('role'),
    ).toBe('alert');
    expect(screen.getByLabelText('Desde').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2027-01-01' } });
    await consult();
    expect(
      (await screen.findByText(/posteriores a hoy|dentro del ciclo/)).textContent,
    ).toBeTruthy();
    expect(fake.calls.some((c) => c.url.includes('/reports/group'))).toBe(false);
  });
});

describe('seguimiento por grupo', () => {
  it('pide el reporte por grupo existente con grupo, ciclo y periodo (sin actor ni endpoint nuevo)', async () => {
    const fake = await loaded();
    expect(Object.fromEntries(lastQuery(fake))).toEqual({
      groupId: GA,
      schoolYearId: Y1,
      from: '2026-09-29',
      to: TODAY,
    });
    expect(fake.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(fake.calls.every((c) => !c.url.includes('/justifications'))).toBe(true);
  });

  it('orden inicial: mayor numero de ausencias registradas, con desempate por apellidos y nombres', async () => {
    await loaded();
    expect(order()).toEqual(['Pérez Dora', 'Zamora Ana', 'Zamora Carla', 'Álvarez Beto']);
    expect((screen.getByLabelText('Ordenar por') as HTMLSelectElement).value).toBe('absences_desc');
    expect(screen.getByRole('table').querySelector('caption')!.textContent).toMatch(
      /mayor número de ausencias registradas/,
    );
  });

  it('cambia el orden sin volver a consultar: menor numero de ausencias y nombre del alumno', async () => {
    const fake = await loaded();
    const calls = fake.calls.length;
    await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'absences_asc');
    expect(order()).toEqual(['Álvarez Beto', 'Zamora Ana', 'Zamora Carla', 'Pérez Dora']);
    await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'name');
    expect(order()).toEqual(['Álvarez Beto', 'Pérez Dora', 'Zamora Ana', 'Zamora Carla']);
    expect(fake.calls.length).toBe(calls);
  });

  it('muestra ausencias, presentes, sin marca y listas por alumno y los totales del grupo', async () => {
    await loaded();
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!; // Perez Dora
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 4)
        .map((c) => c.textContent),
    ).toEqual(['4', '1', '0', '5']);
    const totals = screen.getByLabelText('Totales del periodo');
    const stat = (label: string) =>
      within(totals).getByText(label).closest('div')!.querySelector('dd')!.textContent;
    expect([
      stat('Ausencias registradas'),
      stat('Presentes registrados'),
      stat('Registros sin marca'),
    ]).toEqual(['8', '12', '0']);
  });

  it('un renglon sin marca NO es ausencia: queda como «Sin marca» y se avisa que la lista esta en borrador', async () => {
    await loaded(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(
          200,
          groupReport([st(S.a, 'Ana', 'Zamora', 2, 0, 3)], { ...COMPLETE, draft: 1, finalized: 4 }),
        ),
    });
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 3)
        .map((c) => c.textContent),
    ).toEqual(['0', '2', '3']);
    expect(row.textContent).toMatch(/3 registros sin marca/);
    expect(
      screen.getByRole('group', { name: 'Estado de los datos del periodo' }).textContent,
    ).toMatch(/1 lista en borrador/);
  });

  it('datos incompletos: dias sin lista y borradores se dicen; completos solo si todo esta finalizado', async () => {
    await loaded();
    const status = screen.getByRole('group', { name: 'Estado de los datos del periodo' });
    expect(status.textContent).toMatch(/Datos incompletos/);
    expect(status.textContent).toMatch(
      /17 días hábiles sin lista \(no determinado, no es ausencia\)/,
    );
  });

  it('datos completos: todos los dias habiles con lista finalizada', async () => {
    await loaded(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(200, groupReport(undefined, COMPLETE)),
    });
    expect(
      screen.getByRole('group', { name: 'Estado de los datos del periodo' }).textContent,
    ).toMatch(/Datos completos/);
  });

  it('alumno incorporado despues o dado de baja: «no estaba en el padron» (no es ausencia)', async () => {
    await loaded(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(
          200,
          groupReport([st(S.a, 'Ana', 'Zamora', 1, 0), st(S.b, 'Beto', 'Álvarez', 5, 1)], COMPLETE),
        ),
    });
    const ana = within(screen.getByRole('table'))
      .getAllByRole('row')
      .find((r) => /Zamora Ana/.test(r.textContent ?? ''))!;
    expect(ana.textContent).toMatch(
      /No estaba en el padrón de 4 listas del periodo \(no es ausencia\)/,
    );
  });

  it('sin listas en el periodo: sin alumnos y sin inventar a nadie', async () => {
    await loaded(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(
          200,
          groupReport([], { weekdays: 5, withList: 0, draft: 0, finalized: 0, withoutList: 5 }),
        ),
    });
    expect(screen.getAllByText(/no hay marcas que contar/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.getByRole('group', { name: 'Estado de los datos del periodo' }).textContent,
    ).toMatch(/No hay listas en el periodo/);
  });

  it('sin ausencias: todos en cero, sin alarma ni mensaje especial', async () => {
    await loaded(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(200, groupReport([st(S.a, 'Ana', 'Zamora', 5, 0)], COMPLETE)),
    });
    expect(
      within(within(screen.getByRole('table')).getAllByRole('row')[1]!).getAllByRole('cell')[0]!
        .textContent,
    ).toBe('0');
  });

  it('enlace al reporte individual con ciclo, grupo, alumno y periodo', async () => {
    await loaded();
    const link = within(screen.getByRole('table')).getByRole('link', { name: /de Dora Pérez/ });
    const href = link.getAttribute('href')!;
    expect(href.startsWith('/asistencia/reportes/alumno?')).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(href.split('?')[1]))).toEqual({
      ciclo: Y1,
      grupo: GA,
      alumno: S.d,
      desde: '2026-09-29',
      hasta: TODAY,
    });
  });

  it('el reporte recibido con totales inconsistentes no se muestra', async () => {
    open(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        jsonResponse(200, groupReport(undefined, { absent: 99 })),
    });
    await pickGroup(/1.º A/);
    await consult();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /totales recibidos no coinciden/,
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('errores, cambios de filtros y filtros en la URL', () => {
  it.each([
    [404, 'NOT_FOUND', /No se encontró el grupo o el alumno, o no tienes acceso/],
    [403, 'FORBIDDEN', /No tienes permiso/],
    [500, 'INTERNAL', /No se pudo generar el seguimiento/],
    [400, 'RANGE_IN_FUTURE', /fechas posteriores a hoy/],
  ])(
    'error HTTP %s %s: mensaje comprensible, sin resultado parcial',
    async (status, code, text) => {
      open(PATH, READER, {
        'GET /school/attendance/reports/group': () =>
          apiError(status, code, 'El periodo no puede incluir fechas posteriores a hoy'),
      });
      await pickGroup(/1.º A/);
      await consult();
      expect((await screen.findByRole('alert')).textContent).toMatch(text);
      expect(
        screen.queryByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
      ).toBeNull();
    },
  );

  it('error de red', async () => {
    open(PATH, READER, {
      'GET /school/attendance/reports/group': () => Promise.reject(new TypeError('network')),
    });
    await pickGroup(/1.º A/);
    await consult();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No se pudo conectar con el servidor/,
    );
  });

  it('cargando: aviso y boton deshabilitado; una respuesta tardia de otra seleccion no sustituye a la actual', async () => {
    let release: (r: Response) => void = () => undefined;
    open(PATH, READER, {
      'GET /school/attendance/reports/group': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await pickGroup(/1.º A/);
    await consult();
    expect((await screen.findAllByText('Consultando el seguimiento…')).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('button', { name: 'Consultando…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), Y0);
    release(jsonResponse(200, groupReport()));
    await waitFor(() =>
      expect(screen.queryAllByText('Consultando el seguimiento…')).toHaveLength(0),
    );
    expect(
      screen.queryByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
    ).toBeNull();
  });

  it('cambiar de ciclo, de grupo o de fechas descarta el resultado y restablece lo que corresponde', async () => {
    await loaded();
    await userEvent.selectOptions(screen.getByLabelText('Grupo'), GB);
    expect(
      screen.queryByRole('region', { name: 'Resultado del seguimiento de ausencias' }),
    ).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Ciclo escolar'), Y0);
    expect(
      within(screen.getByLabelText('Grupo'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Elige un grupo', '1.º Z · Matutino']);
    expect((screen.getByLabelText('Hasta') as HTMLInputElement).value).toBe('2026-07-17');
  });

  it('llegada con filtros en la URL (p. ej. al volver del reporte individual): consulta una vez y conserva el orden', async () => {
    const q = new URLSearchParams({
      ciclo: Y1,
      grupo: GA,
      desde: '2026-10-05',
      hasta: '2026-10-16',
      orden: 'name',
    });
    const fake = open(`${PATH}?${q.toString()}`);
    await screen.findByRole('region', { name: 'Resultado del seguimiento de ausencias' });
    expect(Object.fromEntries(lastQuery(fake))).toEqual({
      groupId: GA,
      schoolYearId: Y1,
      from: '2026-10-05',
      to: '2026-10-16',
    });
    expect(fake.calls.filter((c) => c.url.includes('/reports/group'))).toHaveLength(1);
    expect((screen.getByLabelText('Ordenar por') as HTMLSelectElement).value).toBe('name');
    expect(order()).toEqual(['Álvarez Beto', 'Pérez Dora', 'Zamora Ana', 'Zamora Carla']);
  });

  it('un grupo o ciclo desconocido en la URL se ignora (no consulta)', async () => {
    const q = new URLSearchParams({ ciclo: Y1, grupo: 'ffffffff-0000-4000-8000-00000000dead' });
    const fake = open(`${PATH}?${q.toString()}`);
    await screen.findByLabelText('Grupo');
    expect(fake.calls.some((c) => c.url.includes('/reports/group'))).toBe(false);
    expect((screen.getByLabelText('Grupo') as HTMLSelectElement).value).toBe('');
  });
});

describe('sin acciones ni lenguaje de alerta', () => {
  it('no ofrece sancionar, notificar, justificar, corregir, finalizar ni aprobar, y no usa niveles de riesgo ni alertas', async () => {
    await loaded();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.join('|')).not.toMatch(
      /sancion|notific|justific|corregir|finaliz|aprob|alert|enviar|exportar|descargar/i,
    );
    expect(
      screen
        .queryAllByRole('link')
        .map((l) => l.textContent)
        .join('|'),
    ).not.toMatch(/sancion|notific|exportar|descargar/i);
    const text =
      screen.getByRole('region', { name: 'Resultado del seguimiento de ausencias' }).textContent ??
      '';
    expect(text).not.toMatch(
      /riesgo|cr[ií]tico|problem[aá]tic|requiere sanci|alerta|%|porcentaje|umbral/i,
    );
  });

  it('no usa colores de alarma (rojo/ambar) en la tabla de conteos', async () => {
    await loaded();
    const html = screen.getByRole('table').outerHTML;
    expect(html).not.toMatch(/red-|amber-|orange-|yellow-|tinto-700 bg|bg-tinto/);
  });
});
