import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from './AuthProvider';
import { ME, apiError, installFakeApi, jsonResponse } from '../../test/fake-api';

/**
 * Pruebas de componentes (jsdom + `fetch` falso). NO son una prueba de navegador real: no verifican cookies, CORS ni CSRF
 * del navegador; solo lo que la interfaz envia y como reacciona a las respuestas de la API.
 */
const LOGIN_OK = { mustChangePassword: false, session: { expiresAt: 'x', idleExpiresAt: 'y' } };

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
const loginForm = () => ({
  email: screen.getByLabelText('Correo electrónico') as HTMLInputElement,
  password: screen.getByLabelText('Contraseña') as HTMLInputElement,
  submit: screen.getByRole('button', { name: /iniciar sesión|entrando/i }),
});
const anonymousApi = (extra: Parameters<typeof installFakeApi>[0] = {}) =>
  installFakeApi({
    'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED'),
    'GET /health': () => jsonResponse(200, { status: 'ok' }),
    ...extra,
  });

describe('sesion y rutas protegidas', () => {
  it('sin sesion, una ruta protegida lleva a login y no muestra su contenido', async () => {
    anonymousApi();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeTruthy();
    expect(screen.queryByText(/Tu sesión/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
  });

  it('mientras se comprueba la sesion muestra un estado de carga, no el contenido', async () => {
    installFakeApi({ 'GET /auth/me': () => new Promise<Response>(() => undefined) });
    renderApp('/');
    expect((await screen.findByRole('status')).textContent).toMatch(/Comprobando sesión/);
    expect(screen.queryByRole('heading', { name: 'Iniciar sesión' })).toBeNull();
  });

  it('con sesion valida muestra la zona protegida con la identidad minima', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, ME),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    expect(await screen.findByText('Tu sesión')).toBeTruthy();
    expect(screen.getByText('Prefectura')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeTruthy();
  });

  it('quien ya tiene sesion y abre /login es enviado al inicio', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, ME),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/login');
    expect(await screen.findByText('Tu sesión')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Iniciar sesión' })).toBeNull();
  });

  it('si la API no responde al comprobar la sesion, ofrece reintentar (sin mostrar la zona protegida)', async () => {
    let up = false;
    installFakeApi({
      'GET /auth/me': () => (up ? jsonResponse(200, ME) : apiError(503, 'UNAVAILABLE')),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    expect(await screen.findByText('No se pudo comprobar la sesión')).toBeTruthy();
    expect(screen.queryByText('Tu sesión')).toBeNull();
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Tu sesión')).toBeTruthy();
  });

  it('una sesion que vence a mitad de uso (401 en cualquier llamada) regresa a login sin detalles', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, ME),
      'GET /health': () => apiError(401, 'UNAUTHENTICATED'),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('muestra el aviso cuando la verificacion en dos pasos esta diferida (solo desarrollo local)', async () => {
    installFakeApi({
      'GET /auth/me': () =>
        jsonResponse(200, {
          ...ME,
          roles: ['direccion'],
          mfa: { required: true, enforced: false, verified: false },
        }),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    expect((await screen.findByRole('note')).textContent).toMatch(/diferida/);
  });
});

describe('formulario de login', () => {
  it('muestra campos etiquetados, atributos de autocompletado y espacio para el logotipo', async () => {
    anonymousApi();
    renderApp('/login');
    const { email, password } = loginForm();
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('username');
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    expect(screen.getByRole('img', { name: /logotipo/i })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar' }));
    expect(password.type).toBe('text');
  });

  it('valida en el cliente sin llamar a la API', async () => {
    const api = anonymousApi();
    renderApp('/login');
    await userEvent.click(loginForm().submit);
    expect(screen.getByText('Escribe tu correo electrónico.')).toBeTruthy();
    expect(loginForm().email.getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(loginForm().email, 'no-es-correo');
    await userEvent.click(loginForm().submit);
    expect(screen.getByText('Escribe un correo electrónico válido.')).toBeTruthy();
    await userEvent.clear(loginForm().email);
    await userEvent.type(loginForm().email, 'persona@escuela.mx');
    await userEvent.click(loginForm().submit);
    expect(screen.getByText('Escribe tu contraseña.')).toBeTruthy();
    expect(api.count('POST /auth/login')).toBe(0);
  });

  it('inicia sesion: envia JSON con credenciales al mismo origen, consulta /auth/me y NO guarda nada en el navegador', async () => {
    let loggedIn = false;
    const api = installFakeApi({
      'GET /auth/me': () => (loggedIn ? jsonResponse(200, ME) : apiError(401, 'UNAUTHENTICATED')),
      'POST /auth/login': () => {
        loggedIn = true;
        return jsonResponse(200, LOGIN_OK);
      },
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });
    await userEvent.type(loginForm().email, '  Persona@Escuela.mx ');
    await userEvent.type(loginForm().password, 'contraseña-ficticia');
    await userEvent.click(loginForm().submit);
    expect(await screen.findByText('Tu sesión')).toBeTruthy();

    const login = api.calls.find((c) => c.method === 'POST' && c.url === '/api/auth/login')!;
    expect(login.body).toEqual({ email: 'Persona@Escuela.mx', password: 'contraseña-ficticia' });
    expect(login.credentials).toBe('same-origin');
    expect(login.headers['Content-Type']).toBe('application/json');
    expect(Object.keys(login.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(login.url).not.toContain('?'); // nada en la URL
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe(''); // la cookie de sesion es HttpOnly: el codigo no puede verla
  });

  it('durante el envio deshabilita el formulario y evita dobles envios', async () => {
    let release: (r: Response) => void = () => undefined;
    const api = installFakeApi({
      'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });
    await userEvent.type(loginForm().email, 'persona@escuela.mx');
    await userEvent.type(loginForm().password, 'x-ficticia');
    await userEvent.click(loginForm().submit);
    const busy = screen.getByRole('button', { name: 'Entrando…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await userEvent.click(busy);
    expect(api.count('POST /auth/login')).toBe(1);
    release(apiError(401, 'INVALID_CREDENTIALS'));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Iniciar sesión' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  const failureCases: Array<[string, () => Response, RegExp]> = [
    [
      'credenciales incorrectas',
      () => apiError(401, 'INVALID_CREDENTIALS'),
      /Correo o contraseña incorrectos/,
    ],
    ['demasiados intentos', () => apiError(429, 'RATE_LIMITED'), /Demasiados intentos/],
    ['MFA requerido', () => apiError(403, 'MFA_REQUIRED'), /verificación en dos pasos/],
    ['origen no permitido', () => apiError(403, 'FORBIDDEN_ORIGIN'), /desde esta dirección/],
    ['datos invalidos', () => apiError(400, 'VALIDATION_ERROR'), /Revisa el correo/],
    ['error del servidor', () => apiError(500, 'INTERNAL_ERROR'), /No se pudo iniciar sesión/],
  ];
  it.each(failureCases)(
    'muestra un mensaje entendible: %s; conserva el correo y borra la contrasena',
    async (_name, response, message) => {
      anonymousApi({ 'POST /auth/login': response });
      renderApp('/login');
      await screen.findByRole('heading', { name: 'Iniciar sesión' });
      await userEvent.type(loginForm().email, 'persona@escuela.mx');
      await userEvent.type(loginForm().password, 'contraseña-ficticia');
      await userEvent.click(loginForm().submit);
      expect((await screen.findByRole('alert')).textContent).toMatch(message);
      expect(loginForm().email.value).toBe('persona@escuela.mx');
      expect(loginForm().password.value).toBe('');
      expect(document.activeElement).toBe(loginForm().password);
      expect(screen.queryByText(/Tu sesión/)).toBeNull();
    },
  );

  it('un fallo de red se informa como tal', async () => {
    anonymousApi({
      'POST /auth/login': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Iniciar sesión' });
    await userEvent.type(loginForm().email, 'persona@escuela.mx');
    await userEvent.type(loginForm().password, 'x-ficticia');
    await userEvent.click(loginForm().submit);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No se pudo conectar con el servidor/,
    );
  });

  it('despues de iniciar sesion no vuelve a direcciones externas aunque el estado lo pida', async () => {
    let loggedIn = false;
    installFakeApi({
      'GET /auth/me': () => (loggedIn ? jsonResponse(200, ME) : apiError(401, 'UNAUTHENTICATED')),
      'POST /auth/login': () => ((loggedIn = true), jsonResponse(200, LOGIN_OK)),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/login', state: { from: '//evil.example/robo' } }]}
      >
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Iniciar sesión' });
    await userEvent.type(loginForm().email, 'persona@escuela.mx');
    await userEvent.type(loginForm().password, 'x-ficticia');
    await userEvent.click(loginForm().submit);
    expect(await screen.findByText('Tu sesión')).toBeTruthy(); // aterriza en "/" (zona interna)
  });
});

describe('cerrar sesion', () => {
  it('obtiene un valor CSRF de la sesion, lo envia en la cabecera y regresa a login', async () => {
    let loggedIn = true;
    const api = installFakeApi({
      'GET /auth/me': () => (loggedIn ? jsonResponse(200, ME) : apiError(401, 'UNAUTHENTICATED')),
      'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'valor-csrf-ficticio' }),
      'POST /auth/logout': () => ((loggedIn = false), new Response(null, { status: 204 })),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeTruthy();
    const logout = api.calls.find((c) => c.url === '/api/auth/logout')!;
    expect(logout.method).toBe('POST');
    expect(logout.headers['X-CSRF-Token']).toBe('valor-csrf-ficticio');
    expect(logout.credentials).toBe('same-origin');
    expect(api.calls.findIndex((c) => c.url === '/api/auth/csrf')).toBeLessThan(
      api.calls.indexOf(logout),
    );
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('si la sesion ya no existe (401) igualmente termina en login', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, ME),
      'GET /auth/csrf': () => apiError(401, 'UNAUTHENTICATED'),
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeTruthy();
  });

  it('si no hay red al cerrar sesion se avisa y la sesion se mantiene', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, ME),
      'GET /auth/csrf': () => {
        throw new TypeError('Failed to fetch');
      },
      'GET /health': () => jsonResponse(200, { status: 'ok' }),
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo cerrar la sesión/);
    expect(screen.getByText('Tu sesión')).toBeTruthy();
  });
});
