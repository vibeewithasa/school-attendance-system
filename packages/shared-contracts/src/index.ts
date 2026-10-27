/** Contrato de GET /health: solo indica que el proceso HTTP responde. No verifica dependencias. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

/** Contrato de GET /ready: 200 {status:"ready"} o 503 {status:"not_ready"}, sin detalles internos. */
export interface ReadyResponse {
  status: 'ready' | 'not_ready';
}

/** Forma comun de los errores de la API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

/** POST /auth/login (200). El token de sesion viaja SOLO en una cookie HttpOnly, nunca en el JSON. */
export interface AuthLoginResponse {
  mustChangePassword: boolean;
  session: { expiresAt: string; idleExpiresAt: string };
}

/** GET /auth/me (200): identidad minima, roles y permisos vigentes (revalidados en cada peticion). */
export interface AuthMeResponse {
  user: { id: string; accountDomain: 'school' | 'technical'; mustChangePassword: boolean };
  roles: string[];
  permissions: Array<{ permission: string; scope: 'all' | 'assigned_groups' | 'own' }>;
  session: { expiresAt: string; idleExpiresAt: string; mfaVerified: boolean };
  /**
   * required: algun rol vigente exige MFA; enforced: el servidor lo impone (false = diferido por decision del MVP, solo
   * desarrollo local); verified: la sesion tiene segundo factor verificado (nunca se simula).
   */
  mfa: { required: boolean; enforced: boolean; verified: boolean };
}

/** GET /auth/csrf (200): valor para la cabecera X-CSRF-Token en peticiones que cambian estado. */
export interface AuthCsrfResponse {
  csrfToken: string;
}

export * from './admin-users.js';
export * from './activation.js';
export * from './password-policy.js';
export * from './school-catalog.js';
export * from './students.js';
export * from './prefect-assignments.js';
