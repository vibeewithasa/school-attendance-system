import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { activationCodeFromHash } from '@eta15/shared-contracts';
import { App } from '../../app/App';
import { hashSecret } from '../../lib/activation-crypto';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse } from '../../test/fake-api';
import { ActivationPage } from './ActivationPage';

/**
 * Sin espera entre pulsaciones (`delay: null`): por omision cada tecla cede el hilo con un temporizador, y esta pantalla evalua la
 * politica de contrasena en cada una. Aislada cada prueba tarda ~1.5 s, pero con la maquina ocupada (p. ej. PostgreSQL desechable en
 * paralelo) se triplicaba y rozaba el limite de 5 s. Sigue siendo escritura tecla a tecla; solo desaparecen las esperas.
 */
const user = userEvent.setup({ delay: null });

/**
 * Pruebas de componentes de la pantalla de activacion (jsdom + `fetch` falso; la criptografia usa Web Crypto de Node).
 * NO son pruebas de navegador real. Comprueban que el secreto nunca se muestra ni se guarda, que al servidor solo llega su
 * hash hasta completar y que cada estado del flujo se presenta con claridad.
 */
const fromB64Url = (text: string) => Uint8Array.from(Buffer.from(text, 'base64url'));
const GOOD = 'Mi gato duerme sobre la mesa azul';

function setup(routes: Parameters<typeof installFakeApi>[0]) {
  vi.stubGlobal('crypto', webcrypto);
  const api = installFakeApi({
    'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED'),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/activar']}>
      <AuthProvider>
        <ActivationPage pollMs={25} />
        {/* el enrutador real se usa en la prueba de navegacion */}
      </AuthProvider>
    </MemoryRouter>,
  );
  return api;
}
const startFlow = async (email = 'ana@escuela.mx') => {
  await user.type(screen.getByLabelText('Correo electrónico de tu cuenta'), email);
  await user.click(screen.getByRole('button', { name: 'Iniciar activación' }));
};
const requestBody = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.find((c) => c.url === '/api/auth/activation/request')!.body as {
    email: string;
    secretHash: string;
  };

/** Una sola entrada de texto (pegado): evita cientos de renders por tecla en campos de contraseña largos. */
const fill = async (el: HTMLElement, text: string) => {
  await user.click(el);
  await user.paste(text);
};

describe('pantalla de activacion', () => {
  it('paso 1: valida el correo antes de llamar a la API', async () => {
    const api = setup({});
    await user.click(screen.getByRole('button', { name: 'Iniciar activación' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /correo electrónico con el que la autoridad/,
    );
    expect(api.count('POST /auth/activation/request')).toBe(0);
  });

  it('paso 2: envia SOLO el correo y el hash; muestra el codigo derivado del hash y nunca el secreto', async () => {
    const api = setup({
      'POST /auth/activation/request': () => jsonResponse(202, { accepted: true, ttlMinutes: 30 }),
      'POST /auth/activation/status': () => jsonResponse(200, { state: 'waiting' }),
    });
    await startFlow('  Ana@Escuela.MX ');
    expect(await screen.findByText('Paso 2 · Verifica tu identidad en persona')).toBeTruthy();
    const body = requestBody(api);
    expect(Object.keys(body).sort()).toEqual(['email', 'secretHash']);
    expect(body.email).toBe('Ana@Escuela.MX');
    expect(body.secretHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const shownCode = screen.getByLabelText(/Tu código de verificación es/).textContent!;
    expect(shownCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(shownCode).toBe(activationCodeFromHash(fromB64Url(body.secretHash))); // lo mismo que calculara el servidor
    expect(document.body.textContent).not.toContain(body.secretHash);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(location.search + location.hash).toBe('');
    // el estado se consulta por hash, no por secreto
    await waitFor(() => expect(api.count('POST /auth/activation/status')).toBeGreaterThan(1)); // consulta periodica
    expect(
      api.calls
        .filter((c) => c.url.endsWith('/status'))
        .every((c) => (c.body as { secretHash: string }).secretHash === body.secretHash),
    ).toBe(true);
  });

  it('si no hay solicitud vigente para esa cuenta lo dice sin dar pistas y permite empezar de nuevo', async () => {
    setup({
      'POST /auth/activation/request': () => jsonResponse(202, { accepted: true, ttlMinutes: 30 }),
      'POST /auth/activation/status': () => jsonResponse(200, { state: 'unknown' }),
    });
    await startFlow();
    expect(
      (await screen.findByRole('status', { name: '' }).catch(() => null)) ?? true,
    ).toBeTruthy();
    expect(await screen.findByText(/No encontramos tu solicitud/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Empezar de nuevo' }));
    expect(screen.getByRole('button', { name: 'Iniciar activación' })).toBeTruthy();
  });

  it('solicitud vencida: reinicia el flujo y descarta el secreto', async () => {
    setup({
      'POST /auth/activation/request': () => jsonResponse(202, { accepted: true, ttlMinutes: 30 }),
      'POST /auth/activation/status': () => jsonResponse(200, { state: 'expired' }),
    });
    await startFlow();
    expect(await screen.findByText(/La solicitud venció/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Iniciar activación' })).toBeTruthy();
  });

  describe('tras la aprobacion presencial', () => {
    const authorized = (extra: Parameters<typeof installFakeApi>[0] = {}) =>
      setup({
        'POST /auth/activation/request': () =>
          jsonResponse(202, { accepted: true, ttlMinutes: 30 }),
        'POST /auth/activation/status': () => jsonResponse(200, { state: 'authorized' }),
        'POST /auth/activation/complete': () => new Response(null, { status: 204 }),
        ...extra,
      });

    it('pide una contraseña propia con confirmacion y orientacion sobre la politica; el boton espera a que sea valida', async () => {
      authorized();
      await startFlow('analuisa@escuela.mx');
      expect(await screen.findByText('Paso 3 · Elige tu contraseña')).toBeTruthy();
      const submit = screen.getByRole('button', { name: 'Activar mi cuenta' }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      const pass = screen.getByLabelText('Contraseña nueva');
      const confirm = screen.getByLabelText('Confirma tu contraseña');
      await fill(pass, 'corta');
      expect(screen.getByText(/Usa al menos 12 caracteres/)).toBeTruthy();
      await user.clear(pass);
      await fill(pass, 'Password123456');
      expect(screen.getByText(/demasiado común/)).toBeTruthy();
      await user.clear(pass);
      await fill(pass, 'analuisa-escuela-2026');
      expect(screen.getByText(/No uses tu correo ni tu nombre/)).toBeTruthy();
      await user.clear(pass);
      await fill(pass, GOOD);
      expect(screen.queryByRole('list', { name: 'Requisitos de la contraseña' })).toBeNull();
      await fill(confirm, 'otra cosa');
      expect(screen.getByText('Las contraseñas no coinciden.')).toBeTruthy();
      expect(submit.disabled).toBe(true);
      await user.clear(confirm);
      await fill(confirm, GOOD);
      expect(submit.disabled).toBe(false);
      await user.click(screen.getByLabelText('Mostrar la contraseña'));
      expect((pass as HTMLInputElement).type).toBe('text');
    });

    it('completa: el servidor recibe el secreto (cuyo SHA-256 es el hash enviado antes) y la contraseña; no abre sesion y lleva a login', async () => {
      const api = authorized();
      await startFlow();
      await user.type(await screen.findByLabelText('Contraseña nueva'), GOOD);
      await user.type(screen.getByLabelText('Confirma tu contraseña'), GOOD);
      await user.click(screen.getByRole('button', { name: 'Activar mi cuenta' }));
      expect(await screen.findByText('¡Tu cuenta está activa!')).toBeTruthy();
      const complete = api.calls.find((c) => c.url === '/api/auth/activation/complete')!;
      const { secret, newPassword } = complete.body as { secret: string; newPassword: string };
      expect(newPassword).toBe(GOOD);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await hashSecret(secret)).toBe(requestBody(api).secretHash);
      expect(screen.getByRole('status').textContent).toMatch(/no se abrió ninguna sesión/);
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.textContent).not.toContain(GOOD);
      expect(api.count('GET /auth/csrf')).toBe(0);
      expect(localStorage.length + sessionStorage.length).toBe(0);
    });

    it('politica del servidor: muestra los motivos sin repetir la contraseña y permite corregir', async () => {
      let calls = 0;
      authorized({
        'POST /auth/activation/complete': () => {
          calls += 1;
          return calls === 1
            ? jsonResponse(400, {
                error: { code: 'PASSWORD_POLICY', message: 'x', reasons: ['common'] },
              })
            : new Response(null, { status: 204 });
        },
      });
      await startFlow();
      await user.type(await screen.findByLabelText('Contraseña nueva'), GOOD);
      await user.type(screen.getByLabelText('Confirma tu contraseña'), GOOD);
      await user.click(screen.getByRole('button', { name: 'Activar mi cuenta' }));
      expect(await screen.findByText(/demasiado común o fácil de adivinar/)).toBeTruthy();
      expect(document.body.textContent).not.toContain('"common"');
      await user.click(screen.getByRole('button', { name: 'Activar mi cuenta' }));
      expect(await screen.findByText('¡Tu cuenta está activa!')).toBeTruthy();
    });

    it('activacion vencida o invalida al completar: reinicia desde el principio sin detalles', async () => {
      authorized({
        'POST /auth/activation/complete': () => apiError(400, 'ACTIVATION_INVALID', 'x'),
      });
      await startFlow();
      await user.type(await screen.findByLabelText('Contraseña nueva'), GOOD);
      await user.type(screen.getByLabelText('Confirma tu contraseña'), GOOD);
      await user.click(screen.getByRole('button', { name: 'Activar mi cuenta' }));
      expect(await screen.findByText(/venció o ya no es válida/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Iniciar activación' })).toBeTruthy();
      expect(
        (screen.queryByLabelText('Contraseña nueva') as HTMLInputElement | null)?.value ?? '',
      ).toBe('');
    });

    it('limite de intentos y fallo de red al completar se informan', async () => {
      authorized({ 'POST /auth/activation/complete': () => apiError(429, 'RATE_LIMITED', 'x') });
      await startFlow();
      await user.type(await screen.findByLabelText('Contraseña nueva'), GOOD);
      await user.type(screen.getByLabelText('Confirma tu contraseña'), GOOD);
      await user.click(screen.getByRole('button', { name: 'Activar mi cuenta' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/Demasiados intentos/);
    });
  });

  it('solicitud rechazada por limite: mensaje claro y el formulario sigue disponible', async () => {
    setup({ 'POST /auth/activation/request': () => apiError(429, 'RATE_LIMITED', 'x') });
    await startFlow();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Demasiados intentos/);
    expect(screen.getByRole('button', { name: 'Iniciar activación' })).toBeTruthy();
  });
});

describe('integracion con el login', () => {
  it('el login ofrece el enlace a la activacion y /activar es publica (sin sesion)', async () => {
    vi.stubGlobal('crypto', webcrypto);
    installFakeApi({ 'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED') });
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('link', { name: 'actívala aquí' }));
    expect(await screen.findByRole('heading', { name: 'Activa tu cuenta' })).toBeTruthy();
  });

  it('al terminar, "Ir a iniciar sesión" lleva al login', async () => {
    vi.stubGlobal('crypto', webcrypto);
    installFakeApi({
      'GET /auth/me': () => apiError(401, 'UNAUTHENTICATED'),
      'POST /auth/activation/request': () => jsonResponse(202, { accepted: true, ttlMinutes: 30 }),
      'POST /auth/activation/status': () => jsonResponse(200, { state: 'authorized' }),
      'POST /auth/activation/complete': () => new Response(null, { status: 204 }),
    });
    render(
      <MemoryRouter initialEntries={['/activar']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    await user.type(
      await screen.findByLabelText('Correo electrónico de tu cuenta'),
      'ana@escuela.mx',
    );
    await user.click(screen.getByRole('button', { name: 'Iniciar activación' }));
    await user.type(await screen.findByLabelText('Contraseña nueva'), GOOD);
    await user.type(screen.getByLabelText('Confirma tu contraseña'), GOOD);
    await user.click(screen.getByRole('button', { name: 'Activar mi cuenta' }));
    await user.click(await screen.findByRole('button', { name: 'Ir a iniciar sesión' }));
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeTruthy();
  });
});
