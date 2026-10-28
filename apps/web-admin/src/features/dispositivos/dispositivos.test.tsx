import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { AuthProvider } from '../auth/AuthProvider';
import { apiError, installFakeApi, jsonResponse, meWith } from '../../test/fake-api';

/**
 * Pruebas de componentes de Dispositivos moviles (jsdom + `fetch` falso). NO son pruebas de navegador real: comprueban que la
 * interfaz adapta los controles a los permisos efectivos, valida antes de enviar, no manda ningun identificador de persona y que la
 * aprobacion exige TECLEAR la huella (el campo nunca viene relleno). Datos FICTICIOS; la autorizacion real es del servidor.
 */
const REQ = '0a1b2c3d-0000-4000-8000-000000000001';
const DEV = '0a1b2c3d-0000-4000-8000-000000000002';
const FPR = 'A1B2-C3D4-E5F6';

const request = (over: Record<string, unknown> = {}) => ({
  id: REQ,
  status: 'claimed',
  label: 'Tableta ficticia',
  fingerprint: FPR,
  createdAt: '2026-10-27T10:00:00.000Z',
  expiresAt: '2026-10-27T10:10:00.000Z',
  titular: { id: 'u-1', displayName: 'Prefecta Uno Ficticia' },
  ...over,
});
const device = (over: Record<string, unknown> = {}) => ({
  id: DEV,
  label: 'Tableta ficticia',
  fingerprint: FPR,
  status: 'active',
  registeredAt: '2026-10-27T09:00:00.000Z',
  lastSeenAt: null,
  revokedAt: null,
  revokeReason: null,
  titular: { id: 'u-1', displayName: 'Prefecta Uno Ficticia' },
  ...over,
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
const meOwn = () => ({
  ...meWith(['students:read_basic']),
  permissions: [
    { permission: 'mobile_devices:enroll', scope: 'own' },
    { permission: 'prefect_assignments:read', scope: 'own' },
  ],
});
const base = (me: unknown, extra: Record<string, () => Response> = {}) => ({
  'GET /auth/me': () => jsonResponse(200, me),
  'GET /health': () => jsonResponse(200, { status: 'ok' }),
  'GET /auth/csrf': () => jsonResponse(200, { csrfToken: 'csrf-ficticio' }),
  'GET /mobile-devices/mine': () =>
    jsonResponse(200, { requests: [request()], devices: [device()] }),
  'GET /mobile-devices': () => jsonResponse(200, { requests: [request()], devices: [device()] }),
  ...extra,
});
const open = (me: unknown, extra: Record<string, () => Response> = {}) => {
  const fake = installFakeApi(base(me, extra));
  renderAt('/dispositivos');
  return fake;
};
const AUTHORITY = meWith(['mobile_devices:manage', 'users:read']);

describe('acceso segun permisos efectivos', () => {
  it('sin permiso movil no hay enlace, no se llama a la API y se avisa', async () => {
    const api = open(meWith(['students:read_basic']));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(screen.queryByRole('link', { name: 'Dispositivos móviles' })).toBeNull();
    expect(api.count('GET /mobile-devices')).toBe(0);
    expect(api.count('GET /mobile-devices/mine')).toBe(0);
  });

  it('la persona titular ve el formulario de vinculacion y SOLO sus datos; no ve aprobar', async () => {
    const api = open(meOwn());
    expect(await screen.findByRole('form', { name: 'Vincular un dispositivo' })).toBeTruthy();
    expect((await screen.findAllByText(/Tableta ficticia · Prefecta Uno Ficticia/)).length).toBe(2);
    expect(screen.queryByRole('button', { name: /Aprobar/ })).toBeNull();
    expect(api.count('GET /mobile-devices/mine')).toBe(1);
    expect(api.count('GET /mobile-devices')).toBe(0);
    expect(screen.getByText(/ENTORNO DE PRUEBAS/)).toBeTruthy();
  });

  it('la autoridad ve todo, puede aprobar y rechazar, y no ve el formulario de vinculacion', async () => {
    const api = open(AUTHORITY);
    expect(
      await screen.findByRole('button', { name: /Aprobar el dispositivo Tableta ficticia/ }),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Vincular un dispositivo' })).toBeNull();
    expect(screen.getByRole('button', { name: /Rechazar la solicitud/ })).toBeTruthy();
    expect(api.count('GET /mobile-devices')).toBe(1);
    // la lista de la autoridad no revela la huella: se compara en la pantalla del dispositivo
    expect(screen.queryByText(FPR, { exact: false })).toBeTruthy(); // la huella de un dispositivo YA registrado si se muestra
    const requests = screen.getByRole('list', { name: 'Solicitudes de vinculación' });
    expect(within(requests).queryByText(FPR, { exact: false })).toBeNull();
  });
});

describe('reclamo de la persona titular', () => {
  it('valida el formato antes de enviar y no manda ningun identificador de persona', async () => {
    const api = open(meOwn(), {
      'POST /mobile-devices/claims': () => jsonResponse(200, request()),
    });
    await screen.findByRole('form', { name: 'Vincular un dispositivo' });
    await userEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Escribe la clave de solicitud/);
    expect(api.count('POST /mobile-devices/claims')).toBe(0);

    await userEvent.type(screen.getByLabelText('Clave de solicitud'), ` ${REQ} `);
    await userEvent.type(screen.getByLabelText('Código de emparejamiento'), 'abcd-2345');
    await userEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() => expect(api.count('POST /mobile-devices/claims')).toBe(1));
    const call = api.calls.find((c) => c.method === 'POST')!;
    const body = call.body;
    expect(body).toEqual({ requestId: REQ, code: 'ABCD-2345' });
    expect(call.headers['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(JSON.stringify(body)).not.toMatch(/user|role|scope/i);
    expect(await screen.findByText(/Falta que Dirección la apruebe/)).toBeTruthy();
  });

  it('un reclamo rechazado muestra un mensaje generico que no revela si la solicitud existe', async () => {
    open(meOwn(), {
      'POST /mobile-devices/claims': () => apiError(400, 'CLAIM_INVALID', 'interno'),
    });
    await userEvent.type(await screen.findByLabelText('Clave de solicitud'), REQ);
    await userEvent.type(screen.getByLabelText('Código de emparejamiento'), 'ABCD-2345');
    await userEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /no es válido o la solicitud ya no está disponible/,
    );
  });
});

describe('aprobacion de la autoridad', () => {
  it('el campo de huella NO viene relleno y un formato invalido no envia nada', async () => {
    const api = open(AUTHORITY, {
      'POST /mobile-devices/requests/:id/approve': () => jsonResponse(200, request()),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Aprobar el dispositivo/ }));
    const field = screen.getByLabelText('Huella que muestra el dispositivo') as HTMLInputElement;
    expect(field.value).toBe('');
    await userEvent.type(field, 'A1B2');
    await userEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByText(/formato XXXX-XXXX-XXXX/)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('envia la huella tecleada en mayusculas y refresca; una huella distinta se informa sin aprobar', async () => {
    let attempts = 0;
    const api = open(AUTHORITY, {
      [`POST /mobile-devices/requests/${REQ}/approve`]: () => {
        attempts += 1;
        return attempts === 1
          ? apiError(400, 'FINGERPRINT_MISMATCH', 'La huella no coincide')
          : jsonResponse(200, request({ status: 'approved' }));
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /Aprobar el dispositivo/ }));
    const field = screen.getByLabelText('Huella que muestra el dispositivo');
    await userEvent.type(field, 'a1b2-c3d4-0000');
    await userEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /La huella no coincide con la que muestra el dispositivo/,
    );
    await userEvent.clear(field);
    await userEvent.type(field, 'a1b2-c3d4-e5f6');
    await userEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByText(/Vinculación aprobada/)).toBeTruthy();
    expect(attempts).toBe(2);
    const sent = api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/approve'));
    expect(sent.map((c) => c.body)).toEqual([
      { fingerprint: 'A1B2-C3D4-0000' },
      { fingerprint: 'A1B2-C3D4-E5F6' },
    ]);
  });
});

describe('revocacion', () => {
  it('la persona titular revoca SU dispositivo por su ruta, sin cuerpo ni motivo elegido por el cliente', async () => {
    const api = open(meOwn(), {
      [`POST /mobile-devices/mine/devices/${DEV}/revoke`]: () => jsonResponse(200, { id: DEV }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: /Revocar el dispositivo Tableta ficticia/ }),
    );
    expect(screen.queryByLabelText('Motivo')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Revocar' }));
    expect(await screen.findByText(/Dispositivo revocado/)).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.url.includes('/revoke'))!;
    expect(post.url).toBe(`/api/mobile-devices/mine/devices/${DEV}/revoke`);
    expect(post.body).toBeUndefined();
  });

  it('la autoridad elige el motivo y usa la ruta administrativa', async () => {
    const api = open(AUTHORITY, {
      [`POST /mobile-devices/devices/${DEV}/revoke`]: () => jsonResponse(200, { id: DEV }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: /Revocar el dispositivo Tableta ficticia/ }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Motivo'), 'lost');
    await userEvent.click(screen.getByRole('button', { name: 'Revocar' }));
    expect(await screen.findByText(/Dispositivo revocado/)).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.url.includes('/revoke'))!;
    expect(post.url).toBe(`/api/mobile-devices/devices/${DEV}/revoke`);
    expect(post.body).toEqual({ reason: 'lost' });
  });
  it('un dispositivo ya revocado no ofrece acciones y muestra el motivo', async () => {
    open(AUTHORITY, {
      'GET /mobile-devices': () =>
        jsonResponse(200, {
          requests: [],
          devices: [
            device({
              status: 'revoked',
              revokedAt: '2026-10-27T11:00:00.000Z',
              revokeReason: 'lost',
            }),
          ],
        }),
    });
    expect(await screen.findByText(/Pérdida o robo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revocar el dispositivo/ })).toBeNull();
  });
});
