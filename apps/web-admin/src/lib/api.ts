import type { ApiErrorBody, HealthResponse } from '@eta15/shared-contracts';

/** Base de la API. En desarrollo Vite redirige /api a la API local (ver vite.config.ts). */
const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      body?.error.code ?? 'UNKNOWN',
      body?.error.message ?? res.statusText,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
};
