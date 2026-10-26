/**
 * Cableado HTTP del modulo de autenticacion: cabeceras de seguridad, cookies, guarda de origen (CSRF), limite de
 * peticiones y rutas /auth/*. Las dependencias (almacen SQL, servicio de contrasenas, reloj) se inyectan.
 */
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { ApiErrorBody } from '@eta15/shared-contracts';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { createAttemptLimiter } from './attempt-limiter.js';
import { createAuthService } from './auth-service.js';
import { authRoutes } from './auth.routes.js';
import { checkRequestOrigin, isUnsafeMethod, parseAllowedOrigins } from './csrf.js';
import { createPasswordService, type PasswordService } from './password.js';
import { createSessionService, type SessionService, type SessionStore } from './session-service.js';

export interface AuthModuleOptions {
  store: SessionStore;
  passwords?: PasswordService;
  clock?: () => Date;
  /** Valores por defecto: ver `DEFAULT_AUTH_LIMITS`. Sobrescribibles en pruebas. */
  limits?: Partial<AuthLimits>;
}

export interface AuthLimits {
  /** Ventana de los contadores de fallos (ms). */
  windowMs: number;
  /** Fallos por IP (una IP compartida, p. ej. la red de la escuela, necesita margen amplio). */
  ipFailures: number;
  /** Fallos por pareja IP + correo: frena la adivinacion dirigida desde una misma maquina. */
  pairFailures: number;
  /** Fallos por correo desde cualquier IP: alto, para que un tercero no bloquee la cuenta de otra persona con facilidad. */
  identityFailures: number;
  /** Peticiones por minuto y por IP (inundacion) en login y en el resto de /auth. */
  floodLogin: number;
  floodOther: number;
  now?: () => number;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = {
  windowMs: 15 * 60_000,
  ipFailures: 50,
  pairFailures: 5,
  identityFailures: 30,
  floodLogin: 120,
  floodOther: 600,
};

/** Seguridad HTTP comun: helmet, cookies y rechazo de peticiones que cambian estado desde origenes no permitidos. */
export async function registerHttpSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet);
  await app.register(cookie); // sin firma: el valor de la cookie es un token aleatorio opaco

  const allowed = parseAllowedOrigins(env.CORS_ORIGIN);
  app.addHook('onRequest', async (request, reply) => {
    if (!isUnsafeMethod(request.method)) return;
    const verdict = checkRequestOrigin(request.headers, allowed);
    if (verdict === 'ok') return;
    request.log.warn({ verdict }, 'peticion rechazada por origen');
    const body: ApiErrorBody = {
      error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no permitido', requestId: request.id },
    };
    return reply.code(403).send(body);
  });
}

export async function registerAuth(
  app: FastifyInstance,
  env: Env,
  options: AuthModuleOptions,
): Promise<{ sessions: SessionService }> {
  const limits = { ...DEFAULT_AUTH_LIMITS, ...options.limits };
  const passwords = options.passwords ?? createPasswordService();
  const sessions = createSessionService({
    store: options.store,
    clock: options.clock,
    mfaEnforcement: env.AUTH_MFA_ENFORCEMENT,
  });
  if (env.AUTH_MFA_ENFORCEMENT === 'deferred') {
    // Aviso visible en cada arranque: es una excepcion de desarrollo local, no una configuracion de despliegue.
    app.log.warn(
      { mfa: 'deferred' },
      'MFA DIFERIDO (AUTH_MFA_ENFORCEMENT=deferred): direccion y admin_tecnico entran solo con contrasena. Solo desarrollo local; no usar con datos reales.',
    );
  }
  const auth = createAuthService({
    store: options.store,
    sessions,
    passwords,
    onIntegrityProblem: (code) =>
      app.log.error({ code }, 'hash de contrasena almacenado no valido'),
  });
  const limiter = (max: number) =>
    createAttemptLimiter({ max, windowMs: limits.windowMs, now: limits.now });

  // keyGenerator por IP de la conexion (no se confia en X-Forwarded-For: trustProxy esta desactivado).
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () =>
      new AppError(429, 'RATE_LIMITED', 'Demasiados intentos. Intente más tarde.'),
  });

  await app.register(
    async (scope) => {
      authRoutes(scope, {
        auth,
        sessions,
        production: env.NODE_ENV === 'production',
        limiters: {
          ip: limiter(limits.ipFailures),
          pair: limiter(limits.pairFailures),
          identity: limiter(limits.identityFailures),
        },
        floodLimit: { login: limits.floodLogin, other: limits.floodOther },
      });
    },
    { prefix: '/auth' },
  );
  return { sessions };
}
