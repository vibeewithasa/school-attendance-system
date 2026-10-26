import type {
  ActivationRequestList,
  ActivationStatusResponse,
  AdminRole,
  AdminUser,
  AdminUserList,
  ApiErrorBody,
  ApproveActivationBody,
  AuthCsrfResponse,
  AuthLoginResponse,
  AuthMeResponse,
  CreateUserBody,
  HealthResponse,
  ListUsersQuery,
} from '@eta15/shared-contracts';

/** Base de la API. En desarrollo Vite redirige /api a la API local (ver vite.config.ts). */
const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Motivos de la politica de contrasenas (solo con PASSWORD_POLICY); nunca la contrasena. */
    public readonly reasons: string[] = [],
  ) {
    super(message);
  }
}

/** Fallo de red o respuesta ilegible: la API no pudo contactarse (distinto de un rechazo de la API). */
export class NetworkError extends Error {}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** El proveedor de sesion se registra aqui para volver a login cuando cualquier llamada recibe 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Valor para X-CSRF-Token (solo en memoria; se obtiene de GET /auth/csrf cuando se necesita). */
  csrf?: string;
  /** No avisar al manejador global de 401 (p. ej. la comprobacion inicial de sesion o rutas publicas). */
  quiet401?: boolean;
}

/**
 * La sesion vive en una cookie HttpOnly gestionada por el navegador: este codigo nunca ve, guarda ni envia manualmente el token
 * (nada en localStorage, sessionStorage, URL ni estado persistente). `credentials: 'same-origin'` basta porque en desarrollo
 * Vite hace de proxy y la API queda en el mismo origen (http://127.0.0.1:5173/api).
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    throw new NetworkError('No se pudo contactar con el servidor', { cause });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      (ApiErrorBody & { error: { reasons?: string[] } }) | null;
    if (res.status === 401 && !options.quiet401) onUnauthorized?.();
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.reasons ?? [],
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Mutaciones autenticadas: piden un valor CSRF ligado a la sesion justo antes de cada cambio (no se guarda: no hay estado
 * obsoleto que invalidar) y lo envian en la cabecera. El servidor ademas comprueba Origin y Fetch Metadata.
 */
async function mutate<T>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const { csrfToken } = await request<AuthCsrfResponse>('/auth/csrf');
  return request<T>(path, { method, body, csrf: csrfToken });
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => request<HealthResponse>('/health'),
  /** Comprobacion de sesion: un 401 aqui es el estado normal "sin sesion", no un evento. */
  me: () => request<AuthMeResponse>('/auth/me', { quiet401: true }),
  login: (email: string, password: string) =>
    request<AuthLoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      quiet401: true,
    }),
  /** Cierra la sesion actual: obtiene un valor CSRF ligado a la sesion y lo envia en la cabecera. */
  async logout(): Promise<void> {
    const { csrfToken } = await request<AuthCsrfResponse>('/auth/csrf', { quiet401: true });
    await request<void>('/auth/logout', { method: 'POST', csrf: csrfToken, quiet401: true });
  },

  // --- Administracion de cuentas (el servidor autoriza cada llamada; la interfaz solo adapta lo que muestra) ---
  listUsers: (q: Partial<ListUsersQuery>) =>
    request<AdminUserList>(`/admin/users${query({ ...q })}`),
  getUser: (id: string) => request<AdminUser>(`/admin/users/${id}`),
  createUser: (
    body: Omit<CreateUserBody, 'emailKind'> & { emailKind?: CreateUserBody['emailKind'] },
  ) => mutate<AdminUser>('/admin/users', 'POST', body),
  disableUser: (id: string) => mutate<AdminUser>(`/admin/users/${id}/disable`, 'POST'),
  listRoles: () => request<AdminRole[]>('/admin/roles'),
  assignRole: (id: string, roleKey: string) =>
    mutate<AdminUser>(`/admin/users/${id}/roles`, 'POST', { roleKey }),
  revokeRole: (id: string, roleKey: string) =>
    mutate<AdminUser>(`/admin/users/${id}/roles/${roleKey}`, 'DELETE'),
  listActivations: () => request<ActivationRequestList>('/admin/activation-requests'),
  approveActivation: (id: string, body: ApproveActivationBody) =>
    mutate<{ state: 'authorized' }>(`/admin/activation-requests/${id}/approve`, 'POST', body),
  cancelActivation: (id: string) =>
    mutate<{ state: 'cancelled' }>(`/admin/activation-requests/${id}/cancel`, 'POST'),

  // --- Activacion por la persona titular (rutas publicas; el secreto nunca sale de esta pagina salvo al completar) ---
  activationRequest: (email: string, secretHash: string) =>
    request<{ accepted: true; ttlMinutes: number }>('/auth/activation/request', {
      method: 'POST',
      body: { email, secretHash },
      quiet401: true,
    }),
  activationStatus: (secretHash: string) =>
    request<ActivationStatusResponse>('/auth/activation/status', {
      method: 'POST',
      body: { secretHash },
      quiet401: true,
    }),
  activationComplete: (secret: string, newPassword: string) =>
    request<void>('/auth/activation/complete', {
      method: 'POST',
      body: { secret, newPassword },
      quiet401: true,
    }),
};
