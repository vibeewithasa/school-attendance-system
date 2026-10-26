/**
 * Endpoints HTTP de autenticacion: POST /auth/login, POST /auth/logout, GET /auth/me, GET /auth/csrf.
 * Solo traduce HTTP <-> servicios (auth-service, session-service, password); la logica vive en ellos.
 *
 * Cookie de sesion: HttpOnly, SameSite=Strict, Path=/, sin Domain, Expires = caducidad absoluta de la sesion.
 * En produccion se llama `__Host-eta15_session` y es Secure (exigido por el prefijo __Host-); en desarrollo
 * `eta15_session` sin Secure (http). El token jamas aparece en JSON, URL ni logs.
 */
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiErrorBody,
  AuthCsrfResponse,
  AuthLoginResponse,
  AuthMeResponse,
} from '@eta15/shared-contracts';
import { createHash } from 'node:crypto';
import type { AttemptLimiter } from './attempt-limiter.js';
import type { AuthService } from './auth-service.js';
import { CSRF_HEADER, csrfTokenFor, isValidCsrfToken } from './csrf.js';
import { normalizeEmail } from './email.js';
import type { SessionService, VerifiedSession } from './session-service.js';

export const DEV_COOKIE_NAME = 'eta15_session';
export const PROD_COOKIE_NAME = '__Host-eta15_session';

export interface AuthContext extends VerifiedSession {
  /** Token de sesion en claro: solo para derivar CSRF y revocar; nunca se registra ni se devuelve. */
  token: string;
}
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthRoutesOptions {
  auth: AuthService;
  sessions: SessionService;
  production: boolean;
  limiters: { ip: AttemptLimiter; pair: AttemptLimiter; identity: AttemptLimiter };
  /** Tope de peticiones por minuto y por IP (inundacion), en login y en el resto de /auth. */
  floodLimit: { login: number; other: number };
}

const loginBody = z
  .object({
    email: z.string().min(3).max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();

const errorBody = (code: string, message: string, requestId: string): ApiErrorBody => ({
  error: { code, message, requestId },
});

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

export function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { auth, sessions, production, limiters } = options;
  const cookieName = production ? PROD_COOKIE_NAME : DEV_COOKIE_NAME;
  const cookieAttrs = {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    path: '/',
  } as const;

  const clearCookie = (reply: FastifyReply) => reply.clearCookie(cookieName, cookieAttrs);
  const unauthenticated = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(401).send(errorBody('UNAUTHENTICATED', 'Sesión no válida', request.id));

  /** Exige sesion valida (revalidada en la base). Las sesiones con cambio de contrasena pendiente solo llegan a rutas que lo permiten. */
  const sessionGuard =
    (opts: { allowPasswordChange?: boolean } = {}) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.cookies[cookieName];
      if (!token) return unauthenticated(request, reply);
      const result = await sessions.verify(token);
      if (!result.ok) {
        clearCookie(reply);
        return unauthenticated(request, reply);
      }
      if (result.user.mustChangePassword && !opts.allowPasswordChange) {
        return reply
          .code(403)
          .send(errorBody('PASSWORD_CHANGE_REQUIRED', 'Debe cambiar su contraseña', request.id));
      }
      request.auth = { ...result, token };
    };

  const csrfGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth || !isValidCsrfToken(request.auth.token, request.headers[CSRF_HEADER])) {
      return reply.code(403).send(errorBody('CSRF_INVALID', 'Solicitud no autorizada', request.id));
    }
  };

  const noStore = (
    _request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: (e: null, p: unknown) => void,
  ) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  };
  app.addHook('onSend', noStore);

  app.post(
    '/login',
    {
      bodyLimit: 4096,
      config: { rateLimit: { max: options.floodLimit.login, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        // Sin detalles: el mensaje de Zod podria contener fragmentos de la entrada.
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', 'Datos de acceso no válidos', request.id));
      }
      const email = normalizeEmail(parsed.data.email);
      const identity = sha256Hex(email);
      const keys = {
        ip: `ip:${request.ip}`,
        pair: `pair:${request.ip}|${identity}`,
        identity: `id:${identity}`,
      };

      // Los limites se evaluan ANTES del calculo costoso de Argon2id y se aplican igual exista o no la cuenta.
      const blockedMs = Math.max(
        limiters.ip.blockedFor(keys.ip),
        limiters.pair.blockedFor(keys.pair),
        limiters.identity.blockedFor(keys.identity),
      );
      if (blockedMs > 0) {
        reply.header('Retry-After', String(Math.max(1, Math.ceil(blockedMs / 1000))));
        return reply
          .code(429)
          .send(errorBody('RATE_LIMITED', 'Demasiados intentos. Intente más tarde.', request.id));
      }

      const result = await auth.authenticate({
        email,
        password: parsed.data.password,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        clientType: 'web',
      });

      if (!result.ok) {
        if (result.reason === 'mfa_required') {
          // La contrasena fue correcta: no cuenta como fallo, pero NO se abre ninguna sesion.
          return reply
            .code(403)
            .send(
              errorBody(
                'MFA_REQUIRED',
                'Su rol exige verificación en dos pasos, que aún no está disponible. No se inició sesión.',
                request.id,
              ),
            );
        }
        limiters.ip.fail(keys.ip);
        limiters.pair.fail(keys.pair);
        limiters.identity.fail(keys.identity);
        return reply
          .code(401)
          .send(errorBody('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos', request.id));
      }

      limiters.pair.reset(keys.pair);
      // Una cookie anterior valida deja de servir (no se acumulan sesiones huerfanas del mismo navegador).
      const previous = request.cookies[cookieName];
      if (previous) await sessions.revokeByToken(previous, 'logout').catch(() => false);

      reply.setCookie(cookieName, result.token, {
        ...cookieAttrs,
        expires: result.session.expiresAt,
      });
      const body: AuthLoginResponse = {
        mustChangePassword: result.mustChangePassword,
        session: {
          expiresAt: result.session.expiresAt.toISOString(),
          idleExpiresAt: result.session.idleExpiresAt.toISOString(),
        },
      };
      return reply.code(200).send(body);
    },
  );

  app.post(
    '/logout',
    {
      config: { rateLimit: { max: options.floodLimit.other, timeWindow: '1 minute' } },
      preHandler: [sessionGuard({ allowPasswordChange: true }), csrfGuard],
    },
    async (request, reply) => {
      await sessions.revokeByToken(request.auth!.token, 'logout');
      clearCookie(reply);
      return reply.code(204).send();
    },
  );

  app.get(
    '/me',
    {
      config: { rateLimit: { max: options.floodLimit.other, timeWindow: '1 minute' } },
      preHandler: sessionGuard({ allowPasswordChange: true }),
    },
    async (request) => {
      const a = request.auth!;
      const body: AuthMeResponse = {
        user: a.user,
        roles: a.roles,
        permissions: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
        session: {
          expiresAt: a.session.expiresAt.toISOString(),
          idleExpiresAt: a.session.idleExpiresAt.toISOString(),
          mfaVerified: a.session.mfaVerifiedAt !== null,
        },
      };
      return body;
    },
  );

  app.get(
    '/csrf',
    {
      config: { rateLimit: { max: options.floodLimit.other, timeWindow: '1 minute' } },
      preHandler: sessionGuard({ allowPasswordChange: true }),
    },
    async (request) => {
      const body: AuthCsrfResponse = { csrfToken: csrfTokenFor(request.auth!.token) };
      return body;
    },
  );
}
