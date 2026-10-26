/**
 * Guardas HTTP de autenticacion reutilizables por cualquier modulo: sesion valida (revalidada en la base en cada
 * peticion), CSRF ligado a la sesion y puerta de MFA para rutas administrativas.
 */
import type { ApiErrorBody } from '@eta15/shared-contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, isValidCsrfToken } from './csrf.js';
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

export const errorBody = (code: string, message: string, requestId: string): ApiErrorBody => ({
  error: { code, message, requestId },
});

export interface AuthGuardsOptions {
  sessions: SessionService;
  production: boolean;
}

export function createAuthGuards({ sessions, production }: AuthGuardsOptions) {
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

  /** Exige sesion valida. Las sesiones con cambio de contrasena pendiente solo llegan a rutas que lo permiten. */
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

  /**
   * Rutas administrativas privilegiadas: ademas de la sesion exigen que, si algun rol vigente requiere MFA, el segundo factor
   * este verificado. La unica excepcion es el modo diferido (AUTH_MFA_ENFORCEMENT=deferred), que la configuracion solo
   * admite fuera de produccion y en loopback; en produccion una sesion sin MFA verificado NUNCA llega al handler.
   */
  const adminGuard =
    (mfaDeferredAllowed: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const denied = await sessionGuard()(request, reply);
      if (denied || reply.sent) return denied;
      const mfa = request.auth!.mfa;
      if (mfa.required && !mfa.verified && !(mfaDeferredAllowed && !mfa.enforced)) {
        return reply
          .code(403)
          .send(
            errorBody('MFA_REQUIRED', 'Esta operación exige verificación en dos pasos', request.id),
          );
      }
    };

  return { cookieName, cookieAttrs, clearCookie, sessionGuard, csrfGuard, adminGuard };
}

export type AuthGuards = ReturnType<typeof createAuthGuards>;
