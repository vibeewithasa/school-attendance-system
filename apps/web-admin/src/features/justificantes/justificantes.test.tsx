import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { ME, apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes de Justificantes (recepcion, Trabajo Social; jsdom + `fetch` falso). NO son pruebas de navegador real ni
 * E2E: comprueban que la interfaz adapta los controles a los permisos, envia SOLO alumno, fecha y la clave de envio, evita el doble
 * envio, conserva la clave en los reintentos, nunca dice "justificada", "aprobado" ni "eliminada", y no toca la asistencia ni los
 * reportes. Todos los datos son FICTICIOS. La autorizacion real, la hora y el folio son del servidor.
 */
const S1 = 'eeeeeeee-0000-4000-8000-000000000001';
const YEAR = 'aaaaaaaa-0000-4000-8000-000000000001';
const GA = 'bbbbbbbb-0000-4000-8000-000000000001';
const R1 = 'cccccccc-0000-4000-8000-000000000001';
const DATE = '2026-10-14'; // miercoles

const student = (
  id: string,
  givenNames: string,
  familyName: string,
  code: string | null = null,
) => ({
  id,
  givenNames,
  familyName,
  schoolCode: code,
  currentGroup: {
    id: GA,
    schoolYearId: YEAR,
    schoolYearName: '2026-2027',
    grade: 1,
    code: 'A',
    shift: 'matutino',
  },
});
const receipt = (over: Record<string, unknown> = {}) => ({
  id: R1,
  folio: 'JR-000001',
  status: 'received',
  student: { id: S1, givenNames: 'Ana', familyName: 'Ficticia' },
  schoolDate: DATE,
  receivedAt: '2026-10-28T20:15:00.000Z',
  receivedBy: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Persona de Trabajo Social',
  },
  ...over,
});
const list = (items: unknown[] = [receipt()], over: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 10,
  total: items.length,
  ...over,
});

const SOCIAL = ['justifications:read', 'justifications:create'];
const DIRECCION = ['justifications:read'];

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
  'GET /school/justifications/receipts': () => jsonResponse(200, list()),
  'GET /school/justifications/students': () =>
    jsonResponse(200, { items: [student(S1, 'Ana', 'Ficticia', 'FIC-1')], truncated: false }),
  ...extra,
});
const open = (perms: string[] = SOCIAL, extra: Routes = {}) => {
  const fake = installFakeApi(base(perms, extra));
  renderAt('/justificantes');
  return fake;
};
const searchFor = async (text = 'Ana', fieldName = 'Alumno') => {
  const form = await screen.findByRole('search', { name: fieldName });
  await userEvent.type(within(form).getByRole('searchbox'), text);
  await userEvent.click(within(form).getByRole('button', { name: 'Buscar' }));
};
const chooseStudent = async () => {
  await searchFor();
  await userEvent.click(await screen.findByRole('button', { name: /Elegir a Ana Ficticia/ }));
};
const setDate = (value = DATE) =>
  fireEvent.change(screen.getByLabelText('Fecha escolar del justificante'), { target: { value } });
const submit = () => userEvent.click(screen.getByRole('button', { name: 'Registrar recepción' }));
const posts = (fake: ReturnType<typeof installFakeApi>) =>
  fake.calls.filter((c) => c.method === 'POST' && c.url.includes('/justifications/receipts'));
const FORBIDDEN_PHRASES =
  /falta justificada|justificante aprobado|ausencia eliminada|justificado|aprobad[ao]\b/i;

describe('acceso segun permisos efectivos', () => {
  it('sin permiso (p. ej. prefectura con alcance por grupos): aviso, sin enlace y sin llamar a la API de justificantes', async () => {
    const fake = installFakeApi(
      base([], {
        'GET /auth/me': () =>
          jsonResponse(200, {
            ...ME,
            permissions: [
              { permission: 'attendance:read', scope: 'assigned_groups' },
              { permission: 'justifications:read', scope: 'assigned_groups' },
            ],
          }),
      }),
    );
    renderAt('/justificantes');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Justificantes' })).toBeNull();
    expect(fake.calls.some((c) => c.url.includes('/justifications'))).toBe(false);
  });

  it('las rutas exigen sesion: sin ella se muestra el acceso, sin llamar a la API de justificantes', async () => {
    const fake = installFakeApi({ 'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED') });
    renderAt('/justificantes');
    expect(await screen.findByRole('heading', { name: /Iniciar sesión|Acceso/i })).toBeTruthy();
    expect(fake.calls.some((c) => c.url.includes('/justifications'))).toBe(false);
  });

  it('Trabajo Social ve la entrada del menu, el aviso, el formulario y el historial', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Justificantes' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Justificantes' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain(
      'El registro de recepción no modifica la asistencia ni acredita la justificación de una falta.',
    );
    expect(
      screen.getByRole('form', { name: 'Registro de recepción de justificante' }),
    ).toBeTruthy();
    expect(await screen.findByRole('table', { name: /Recepciones de justificantes/ })).toBeTruthy();
  });

  it('una cuenta de solo consulta (Direccion) ve el historial pero no el formulario de registro', async () => {
    open(DIRECCION);
    expect(await screen.findByRole('table', { name: /Recepciones de justificantes/ })).toBeTruthy();
    expect(
      screen.queryByRole('form', { name: 'Registro de recepción de justificante' }),
    ).toBeNull();
    expect(screen.getByText(/no registrar recepciones/)).toBeTruthy();
  });

  it('el enlace del menu lleva a la pantalla', async () => {
    installFakeApi(base(SOCIAL));
    renderAt('/');
    await userEvent.click(await screen.findByRole('link', { name: 'Justificantes' }));
    expect(await screen.findByRole('heading', { name: 'Justificantes' })).toBeTruthy();
  });
});

describe('busqueda del alumno', () => {
  it('exige al menos 3 letras antes de llamar a la API y lo avisa de forma accesible', async () => {
    const fake = open();
    const form = await screen.findByRole('search', { name: 'Alumno' });
    await userEvent.type(within(form).getByRole('searchbox'), 'An');
    await userEvent.click(within(form).getByRole('button', { name: 'Buscar' }));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toMatch(/al menos 3 letras/);
    expect(within(form).getByRole('searchbox').getAttribute('aria-invalid')).toBe('true');
    expect(fake.calls.some((c) => c.url.includes('/justifications/students'))).toBe(false);
  });

  it('busca, muestra datos minimos (nombre, codigo y grupo) y permite elegir y cambiar de alumno', async () => {
    const fake = open();
    await searchFor('Ana');
    const results = await screen.findByRole('list', {
      name: 'Resultados de la búsqueda de alumnos',
    });
    expect(results.textContent).toMatch(/Ana Ficticia · FIC-1 · 1.º A/);
    expect(
      new URL(
        fake.calls.find((c) => c.url.includes('/students'))!.url,
        'http://x',
      ).searchParams.get('q'),
    ).toBe('Ana');
    await userEvent.click(within(results).getByRole('button', { name: /Elegir a Ana Ficticia/ }));
    expect(screen.getByRole('button', { name: 'Cambiar alumno' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Resultados de la búsqueda de alumnos' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar alumno' }));
    expect(await screen.findByRole('search', { name: 'Alumno' })).toBeTruthy();
  });

  it('sin resultados, con mas coincidencias de las mostradas y con error de la API', async () => {
    let mode: 'none' | 'many' | 'error' = 'none';
    open(SOCIAL, {
      'GET /school/justifications/students': () =>
        mode === 'error'
          ? apiError(500, 'INTERNAL')
          : jsonResponse(200, {
              items: mode === 'many' ? [student(S1, 'Ana', 'Ficticia')] : [],
              truncated: mode === 'many',
            }),
    });
    await searchFor('Zzz');
    expect((await screen.findByText(/No se encontraron alumnos/)).textContent).toBeTruthy();
    mode = 'many';
    await userEvent.click(
      within(screen.getByRole('search', { name: 'Alumno' })).getByRole('button', {
        name: 'Buscar',
      }),
    );
    expect(await screen.findByText(/Hay más coincidencias/)).toBeTruthy();
    mode = 'error';
    await userEvent.click(
      within(screen.getByRole('search', { name: 'Alumno' })).getByRole('button', {
        name: 'Buscar',
      }),
    );
    expect(
      (await screen.findAllByRole('alert')).some((a) =>
        /No se pudo buscar/.test(a.textContent ?? ''),
      ),
    ).toBe(true);
  });
});

describe('registro de la recepcion', () => {
  const created =
    (over: Record<string, unknown> = {}, replayed = false) =>
    () =>
      jsonResponse(replayed ? 200 : 201, { receipt: receipt(over), replayed });

  it('envia SOLO la clave de envio, el alumno y la fecha (nunca hora, actor, folio ni estado) y muestra el folio', async () => {
    const fake = open(SOCIAL, { 'POST /school/justifications/receipts': created() });
    await chooseStudent();
    setDate();
    await submit();
    const ok = await screen.findByText(/Recepción registrada/);
    expect(ok.textContent).toContain('JR-000001');
    const [call] = posts(fake);
    expect(Object.keys(call!.body as object).sort()).toEqual([
      'requestId',
      'schoolDate',
      'studentId',
    ]);
    expect(call!.body).toMatchObject({ studentId: S1, schoolDate: DATE });
    expect((call!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    const status = screen.getAllByRole('status').find((s) => /Folio/.test(s.textContent ?? ''))!;
    expect(status.textContent).toMatch(/Persona de Trabajo Social/);
    expect(status.textContent).toContain(
      'no modifica la asistencia ni acredita la justificación de una falta',
    );
    // el formulario se limpia y el historial se refresca
    expect(screen.getByRole('search', { name: 'Alumno' })).toBeTruthy();
    expect(
      (screen.getByLabelText('Fecha escolar del justificante') as HTMLInputElement).value,
    ).toBe('');
    await waitFor(() => expect(fake.count('GET /school/justifications/receipts')).toBe(2));
  });

  it('el doble clic no duplica el envio mientras el primero esta en curso (boton deshabilitado y "Registrando…")', async () => {
    let release: (r: Response) => void = () => undefined;
    const fake = open(SOCIAL, {
      'POST /school/justifications/receipts': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await chooseStudent();
    setDate();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Registrar recepción' }));
    expect(posts(fake)).toHaveLength(1);
    const busy = screen.getByRole('button', { name: 'Registrando…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    release(jsonResponse(201, { receipt: receipt(), replayed: false }));
    expect(await screen.findByText(/Recepción registrada/)).toBeTruthy();
    expect(posts(fake)).toHaveLength(1);
  });

  it('tras un fallo de red el reintento conserva la MISMA clave de envio; tras un exito, el siguiente registro usa otra', async () => {
    let n = 0;
    const fake = open(SOCIAL, {
      'POST /school/justifications/receipts': () => {
        n += 1;
        return n === 1
          ? Promise.reject(new TypeError('network'))
          : jsonResponse(201, { receipt: receipt(), replayed: false });
      },
    });
    await chooseStudent();
    setDate();
    await submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No se pudo conectar con el servidor/,
    );
    await submit();
    await screen.findByText(/Recepción registrada/);
    const [a, b] = posts(fake).map((c) => (c.body as { requestId: string }).requestId);
    expect(a).toBe(b);
    // segundo documento del mismo alumno y fecha: otra clave
    await chooseStudent();
    setDate();
    await submit();
    await waitFor(() => expect(posts(fake)).toHaveLength(3));
    expect((posts(fake)[2]!.body as { requestId: string }).requestId).not.toBe(a);
  });

  it('un reintento ya registrado (replayed) se dice claramente y no se presenta como un registro nuevo', async () => {
    open(SOCIAL, { 'POST /school/justifications/receipts': created({}, true) });
    await chooseStudent();
    setDate();
    await submit();
    expect((await screen.findByText(/Ya estaba registrado/)).textContent).toContain('JR-000001');
  });

  it('validaciones en pantalla (accesibles) sin llamar a la API: alumno, fecha, fin de semana y fecha futura', async () => {
    const fake = open();
    await screen.findByRole('form', { name: 'Registro de recepción de justificante' });
    await submit();
    expect((await screen.findByText('Elige al alumno.')).getAttribute('role')).toBe('alert');
    await chooseStudent();
    await submit();
    expect((await screen.findByText(/Indica la fecha escolar/)).textContent).toBeTruthy();
    setDate('2026-10-17'); // sabado
    await submit();
    expect(
      (await screen.findByText(/lunes a viernes/, { selector: 'p[role=alert]' })).textContent,
    ).toBeTruthy();
    const input = screen.getByLabelText('Fecha escolar del justificante');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    setDate('2999-01-04');
    await submit();
    expect(
      (await screen.findByText(/fechas futuras/, { selector: 'p[role=alert]' })).textContent,
    ).toBeTruthy();
    expect(posts(fake)).toHaveLength(0);
  });

  it.each([
    [400, 'NOT_ENROLLED_ON_DATE', /no estaba inscrito en esa fecha/],
    [400, 'NOT_SCHOOL_DAY', /lunes a viernes/],
    [400, 'DATE_IN_FUTURE', /fechas futuras/],
    [404, 'STUDENT_NOT_FOUND', /No se encontró al alumno/],
    [409, 'IDEMPOTENCY_MISMATCH', /ya se usó con otros datos/],
    [403, 'FORBIDDEN', /No tienes permiso/],
    [503, 'JUSTIFICATIONS_UNAVAILABLE', /aún no está habilitado/],
    [500, 'INTERNAL', /No se pudo registrar la recepción/],
  ])(
    'error HTTP %s %s: mensaje comprensible, sin folio ni exito falso',
    async (status, code, text) => {
      const fake = open(SOCIAL, {
        'POST /school/justifications/receipts': () => apiError(status, code),
      });
      await chooseStudent();
      setDate();
      await submit();
      expect((await screen.findByRole('alert')).textContent).toMatch(text);
      expect(screen.queryByText(/Recepción registrada/)).toBeNull();
      expect(posts(fake)).toHaveLength(1);
    },
  );
});

describe('historial', () => {
  it('muestra folio, alumno, fecha escolar, quien y cuando lo recibio, y el estado "Recibido"', async () => {
    open();
    const table = await screen.findByRole('table', { name: /Recepciones de justificantes/ });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByRole('rowheader').textContent).toBe('JR-000001');
    expect(within(row).getByText('Ana Ficticia')).toBeTruthy();
    expect(within(row).getByText(DATE)).toBeTruthy();
    expect(within(row).getByText('Persona de Trabajo Social')).toBeTruthy();
    expect(within(row).getByText('Recibido')).toBeTruthy();
  });

  it('estado de carga y luego resultados; sin resultados; error con reintento', async () => {
    let mode: 'slow' | 'empty' | 'error' | 'ok' = 'slow';
    let release: (r: Response) => void = () => undefined;
    const fake = open(SOCIAL, {
      'GET /school/justifications/receipts': () => {
        if (mode === 'slow')
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        if (mode === 'empty') return jsonResponse(200, list([]));
        if (mode === 'error') return apiError(500, 'INTERNAL');
        return jsonResponse(200, list());
      },
    });
    expect(await screen.findByText('Cargando…')).toBeTruthy();
    mode = 'empty';
    release(jsonResponse(200, list([])));
    expect((await screen.findByText(/No hay recepciones registradas/)).textContent).toBeTruthy();
    mode = 'error';
    fireEvent.change(screen.getByLabelText('Fecha escolar desde'), {
      target: { value: '2026-10-01' },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No se pudo cargar el historial/,
    );
    mode = 'ok';
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table', { name: /Recepciones de justificantes/ })).toBeTruthy();
    expect(fake.count('GET /school/justifications/receipts')).toBeGreaterThanOrEqual(3);
  });

  it('pagina el historial (10 por pagina) y pide la pagina elegida', async () => {
    const fake = open(SOCIAL, {
      'GET /school/justifications/receipts': (call) => {
        const page = Number(new URL(call.url, 'http://x').searchParams.get('page') ?? '1');
        return jsonResponse(
          200,
          list([receipt({ folio: `JR-0000${10 + page}` })], { page, total: 25 }),
        );
      },
    });
    const nav = await screen.findByRole('navigation', { name: 'Paginación del historial' });
    expect(nav.textContent).toContain('Página 1 de 3');
    expect(
      (within(nav).getByRole('button', { name: 'Anterior' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(within(nav).getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('JR-000012')).toBeTruthy();
    const last = [...fake.calls].reverse().find((c) => c.url.includes('/receipts'))!;
    expect(new URL(last.url, 'http://x').searchParams.get('page')).toBe('2');
    expect(
      screen.getByRole('navigation', { name: 'Paginación del historial' }).textContent,
    ).toContain('Página 2 de 3');
  });

  it('filtra por rango de fecha escolar y por alumno; un rango invertido se avisa sin llamar a la API', async () => {
    const fake = open();
    await screen.findByRole('table', { name: /Recepciones de justificantes/ });
    fireEvent.change(screen.getByLabelText('Fecha escolar desde'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(screen.getByLabelText('Fecha escolar hasta'), {
      target: { value: '2026-10-20' },
    });
    const filtered = async () => {
      await waitFor(() => {
        const q = new URL(
          [...fake.calls].reverse().find((c) => c.url.includes('/receipts'))!.url,
          'http://x',
        ).searchParams;
        expect([q.get('from'), q.get('to')]).toEqual(['2026-10-01', '2026-10-20']);
      });
    };
    await filtered();
    // por alumno (segundo selector, el del historial)
    await searchFor('Ana', 'Filtrar por alumno');
    await userEvent.click(await screen.findByRole('button', { name: /Elegir a Ana Ficticia/ }));
    await waitFor(() => {
      const q = new URL(
        [...fake.calls].reverse().find((c) => c.url.includes('/receipts'))!.url,
        'http://x',
      ).searchParams;
      expect(q.get('studentId')).toBe(S1);
    });
    const before = fake.count('GET /school/justifications/receipts');
    fireEvent.change(screen.getByLabelText('Fecha escolar hasta'), {
      target: { value: '2026-09-01' },
    });
    expect((await screen.findByText(/inicio no puede ser posterior/)).getAttribute('role')).toBe(
      'alert',
    );
    expect(fake.count('GET /school/justifications/receipts')).toBe(before);
  });
});

describe('semantica de recepcion e independencia de la asistencia', () => {
  it('nunca dice "justificada", "aprobado" ni "eliminada", ni antes ni despues de registrar', async () => {
    open(SOCIAL, {
      'POST /school/justifications/receipts': () =>
        jsonResponse(201, { receipt: receipt(), replayed: false }),
    });
    await screen.findByRole('table', { name: /Recepciones de justificantes/ });
    const clean = () => {
      const text = document.body.textContent ?? '';
      // el aviso obligatorio menciona "acredita la justificación de una falta" (para NEGARLO): se excluye solo ese texto
      expect(text.replaceAll('ni acredita la justificación de una falta', '')).not.toMatch(
        FORBIDDEN_PHRASES,
      );
    };
    clean();
    await chooseStudent();
    setDate();
    await submit();
    await screen.findByText(/Recepción registrada/);
    clean();
  });

  it('registrar y consultar no llama a ningun endpoint de asistencia ni de reportes', async () => {
    const fake = open(SOCIAL, {
      'POST /school/justifications/receipts': () =>
        jsonResponse(201, { receipt: receipt(), replayed: false }),
    });
    await chooseStudent();
    setDate();
    await submit();
    await screen.findByText(/Recepción registrada/);
    expect(fake.calls.some((c) => c.url.includes('/school/attendance'))).toBe(false);
    expect(
      fake.calls
        .filter((c) => c.method !== 'GET')
        .every((c) => c.url.includes('/justifications/receipts')),
    ).toBe(true);
  });
});

describe('regresion E2E: el selector de alumno no puede ser un formulario anidado', () => {
  // Defecto hallado por el E2E en navegador real: el selector de alumno era un <form> DENTRO del formulario de registro. Un <form>
  // anidado es HTML invalido y Chrome enviaba el formulario externo: la busqueda no funcionaba. jsdom no lo detectaba.
  it('no hay ningun <form> dentro de otro <form> y los botones de buscar no envian formularios', async () => {
    open();
    await screen.findByRole('form', { name: 'Registro de recepción de justificante' });
    expect(document.querySelectorAll('form form')).toHaveLength(0);
    for (const b of screen.getAllByRole('button', { name: 'Buscar' }))
      expect((b as HTMLButtonElement).type).toBe('button');
    expect(screen.getAllByRole('search')).toHaveLength(2);
  });

  it('Enter en el cuadro de busqueda busca al alumno y NO envia el registro', async () => {
    const fake = open();
    const form = await screen.findByRole('search', { name: 'Alumno' });
    await userEvent.type(within(form).getByRole('searchbox'), 'Ana{Enter}');
    expect(
      await screen.findByRole('list', { name: 'Resultados de la búsqueda de alumnos' }),
    ).toBeTruthy();
    expect(posts(fake)).toHaveLength(0);
    expect(screen.queryByText('Elige al alumno.')).toBeNull();
  });
});
