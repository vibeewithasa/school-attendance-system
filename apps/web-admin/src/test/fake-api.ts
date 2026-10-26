import { vi } from 'vitest';

/**
 * API FALSA para pruebas de componentes: sustituye a `fetch`. Sirve para comprobar lo que la interfaz envia y como reacciona;
 * NO demuestra el comportamiento de cookies, CORS ni CSRF de un navegador real (eso se prueba contra la API real).
 */
export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: RequestCredentials | undefined;
}
type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const jsonResponse = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
export const apiError = (status: number, code: string, message = 'mensaje') =>
  jsonResponse(status, { error: { code, message, requestId: 'req-1' } });

export const ME = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    accountDomain: 'school',
    mustChangePassword: false,
  },
  roles: ['prefectura'],
  permissions: [{ permission: 'catalog:read', scope: 'all' }],
  session: {
    expiresAt: '2030-01-01T12:00:00.000Z',
    idleExpiresAt: '2030-01-01T11:00:00.000Z',
    mfaVerified: false,
  },
  mfa: { required: false, enforced: true, verified: false },
};

/** Instala el fetch falso. Las rutas se indican como "METODO /ruta" (sin el prefijo /api). */
export function installFakeApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: RecordedCall = {
      method,
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials,
    };
    calls.push(call);
    const path = url.replace(/^\/api/, '');
    const handler = routes[`${method} ${path}`];
    if (!handler) return apiError(404, 'NOT_FOUND');
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    count: (key: string) =>
      calls.filter((c) => `${c.method} ${c.url.replace(/^\/api/, '')}` === key).length,
  };
}
