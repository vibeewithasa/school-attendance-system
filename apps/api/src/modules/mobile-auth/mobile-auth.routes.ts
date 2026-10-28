/**
 * Rutas del CANAL MOVIL (prefijo /mobile), sin cookies ni CSRF: ver mobile-guards.ts. Solo existen en el sandbox (`MobileAuthOptions`).
 *
 *   POST /enroll/requests                    anonima: el dispositivo envia su clave PUBLICA y recibe el codigo de emparejamiento
 *   GET  /enroll/requests/:id                estado de SU solicitud (prueba DPoP con la clave de la solicitud)
 *   POST /enroll/requests/:id/activate       registra el dispositivo tras la aprobacion (prueba DPoP + nonce)
 *   POST /auth/challenge                     nonce de un solo uso (prueba DPoP de una clave YA ligada a una solicitud o dispositivo)
 *   POST /auth/token                         abre la sesion movil (prueba DPoP + nonce; solo dispositivos activos)
 *   POST /auth/refresh                       renueva con rotacion (token de renovacion + prueba DPoP + nonce)
 *   POST /auth/logout                        cierra la sesion movil
 *   GET  /me                                 identidad movil minima
 * Las lecturas escolares (`/mobile/school/me/groups`, `/mobile/school/groups/:id/roster`) reutilizan los handlers web existentes
 * (ver auth.module.ts) y NO exponen ninguna ruta administrativa.
 */
import {
  mobileChallengeBody,
  mobileEnrollRequestBody,
  mobileRefreshBody,
  type MobileMeResponse,
  type MobileTokenResponse,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AttemptLimiter } from '../auth/attempt-limiter.js';
import { errorBody } from '../auth/guards.js';
import type { MobileGuards } from './mobile-guards.js';
import type {
  DeviceContext,
  MobileAuthConfig,
  MobileAuthService,
  MobileFailure,
  MobileResult,
  TokenSet,
} from './mobile-auth.service.js';

export interface MobileRoutesOptions {
  service: MobileAuthService;
  guards: MobileGuards;
  config: MobileAuthConfig;
  limiters: {
    /** Solicitudes de vinculacion por IP (cada llamada cuenta). */
    enrollIp: AttemptLimiter;
    /** Nonces pedidos por IP (cada llamada cuenta). */
    challengeIp: AttemptLimiter;
    /** Fallos en token/renovacion por IP. */
    tokenFailIp: AttemptLimiter;
    /** Fallos en token/renovacion por clave del dispositivo. */
    tokenFailKey: AttemptLimiter;
  };
  floodLimit: number;
}

export const HTTP_STATUS: Record<MobileFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

const idParams = z.object({ id: z.uuid() }).strict();

export function sendMobileResult<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  result: MobileResult<T>,
  success = 200,
  map: (value: T) => unknown = (v) => v,
) {
  if (result.ok) return reply.code(success).send(map(result.value));
  if (result.code === 'UNAUTHENTICATED')
    reply.header('WWW-Authenticate', 'DPoP error="invalid_token"');
  return reply
    .code(HTTP_STATUS[result.code])
    .send(errorBody(result.reason, result.message, request.id));
}

const tokenDto = (t: TokenSet): MobileTokenResponse => ({
  tokenType: 'DPoP',
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  accessExpiresAt: t.accessExpiresAt.toISOString(),
  idleExpiresAt: t.idleExpiresAt.toISOString(),
  sessionExpiresAt: t.sessionExpiresAt.toISOString(),
  deviceId: t.deviceId,
});

export function mobileRoutes(app: FastifyInstance, options: MobileRoutesOptions): void {
  const { service, guards, limiters } = options;
  const channel = (extra: Record<string, unknown> = {}) => ({
    mobileChannel: true,
    rateLimit: { max: options.floodLimit, timeWindow: '1 minute' },
    ...extra,
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  const ctx = (request: FastifyRequest): DeviceContext => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  });
  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
  const tooMany = (request: FastifyRequest, reply: FastifyReply, blockedMs: number) => {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(blockedMs / 1000))));
    return reply
      .code(429)
      .send(errorBody('RATE_LIMITED', 'Demasiados intentos. Intente más tarde.', request.id));
  };

  /** Limite de fallos de credenciales moviles: se comprueba ANTES del trabajo costoso y se cuenta con `onResponse`. */
  const failureThrottle = async (request: FastifyRequest, reply: FastifyReply) => {
    const blocked = limiters.tokenFailIp.blockedFor(`ip:${request.ip}`);
    if (blocked > 0) return tooMany(request, reply, blocked);
  };
  const countFailure = (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (reply.statusCode === 401 || reply.statusCode === 403) {
      limiters.tokenFailIp.fail(`ip:${request.ip}`);
      const key = request.deviceProof?.thumbprint;
      if (key) limiters.tokenFailKey.fail(`key:${key}`);
    }
    done();
  };

  // --------------------------------------------------------------------------------------------- enrolamiento

  app.post(
    '/enroll/requests',
    { bodyLimit: 2048, config: channel(), preHandler: [guards.channelGuard] },
    async (request, reply) => {
      const body = mobileEnrollRequestBody.safeParse(request.body);
      if (!body.success) return invalid(request, reply);
      const key = `ip:${request.ip}`;
      const blocked = limiters.enrollIp.blockedFor(key);
      if (blocked > 0) return tooMany(request, reply, blocked);
      limiters.enrollIp.fail(key); // cada solicitud cuenta contra la IP
      const result = await service.createRequest(
        { publicKey: body.data.publicKey, label: body.data.label },
        ctx(request),
      );
      return sendMobileResult(request, reply, result, 201, (v) => ({
        requestId: v.requestId,
        pairingCode: v.pairingCode,
        fingerprint: v.fingerprint,
        expiresAt: v.expiresAt.toISOString(),
      }));
    },
  );

  app.get(
    '/enroll/requests/:id',
    {
      config: channel(),
      preHandler: [
        guards.channelGuard,
        failureThrottle,
        guards.proofGuard({ requireNonce: false, scope: 'request' }),
      ],
      onResponse: [countFailure],
    },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return invalid(request, reply);
      return sendMobileResult(
        request,
        reply,
        await service.requestStatus(p.data.id, request.deviceProof!.thumbprint),
      );
    },
  );

  app.post(
    '/enroll/requests/:id/activate',
    {
      config: channel(),
      preHandler: [
        guards.channelGuard,
        failureThrottle,
        guards.proofGuard({ requireNonce: true, scope: 'request' }),
      ],
      onResponse: [countFailure],
    },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return invalid(request, reply);
      return sendMobileResult(
        request,
        reply,
        await service.activate(p.data.id, request.deviceProof!.thumbprint, ctx(request)),
        201,
      );
    },
  );

  // --------------------------------------------------------------------------------------------- sesiones

  app.post(
    '/auth/challenge',
    {
      bodyLimit: 512,
      config: channel(),
      preHandler: [
        guards.channelGuard,
        failureThrottle,
        guards.proofGuard({ requireNonce: false, scope: 'known_key' }),
      ],
      onResponse: [countFailure],
    },
    async (request, reply) => {
      const body = mobileChallengeBody.safeParse(request.body);
      // La huella del cuerpo debe ser la de la clave que FIRMO la prueba: nadie pide desafios para la clave de otro.
      if (!body.success || body.data.keyThumbprint !== request.deviceProof!.thumbprint)
        return invalid(request, reply);
      const key = `ip:${request.ip}`;
      const blocked = limiters.challengeIp.blockedFor(key);
      if (blocked > 0) return tooMany(request, reply, blocked);
      limiters.challengeIp.fail(key);
      let issued;
      try {
        issued = await service.issueNonce(request.deviceProof!.thumbprint);
      } catch {
        return reply
          .code(503)
          .send(
            errorBody(
              'MOBILE_AUTH_UNAVAILABLE',
              'La autenticación móvil no está disponible',
              request.id,
            ),
          );
      }
      if (!issued) return tooMany(request, reply, 5_000);
      return { nonce: issued.nonce, expiresAt: issued.expiresAt.toISOString() };
    },
  );

  app.post(
    '/auth/token',
    {
      config: channel(),
      preHandler: [
        guards.channelGuard,
        failureThrottle,
        guards.proofGuard({ requireNonce: true, scope: 'device' }),
      ],
      onResponse: [countFailure],
    },
    async (request, reply) => {
      const key = request.deviceProof!.thumbprint;
      const blocked = limiters.tokenFailKey.blockedFor(`key:${key}`);
      if (blocked > 0) return tooMany(request, reply, blocked);
      return sendMobileResult(
        request,
        reply,
        await service.issueSession(key, ctx(request)),
        200,
        tokenDto,
      );
    },
  );

  app.post(
    '/auth/refresh',
    {
      bodyLimit: 512,
      config: channel(),
      preHandler: [
        guards.channelGuard,
        failureThrottle,
        guards.proofGuard({ requireNonce: true, scope: 'device' }),
      ],
      onResponse: [countFailure],
    },
    async (request, reply) => {
      const body = mobileRefreshBody.safeParse(request.body);
      if (!body.success) return invalid(request, reply);
      const key = request.deviceProof!.thumbprint;
      const blocked = limiters.tokenFailKey.blockedFor(`key:${key}`);
      if (blocked > 0) return tooMany(request, reply, blocked);
      return sendMobileResult(
        request,
        reply,
        await service.refresh(body.data.refreshToken, key, ctx(request)),
        200,
        tokenDto,
      );
    },
  );

  app.post(
    '/auth/logout',
    { config: channel(), preHandler: [guards.channelGuard, guards.accessGuard] },
    async (request, reply) => {
      const id = request.mobile!;
      await service.logout(id.sessionId, id.userId, ctx(request));
      return reply.code(204).send();
    },
  );

  app.get(
    '/me',
    { config: channel(), preHandler: [guards.channelGuard, guards.accessGuard] },
    async (request): Promise<MobileMeResponse> => {
      const id = request.mobile!;
      return {
        deviceId: id.deviceId,
        roles: id.roles,
        permissions: id.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
        session: {
          accessExpiresAt: id.accessExpiresAt.toISOString(),
          idleExpiresAt: id.idleExpiresAt.toISOString(),
          sessionExpiresAt: id.sessionExpiresAt.toISOString(),
        },
      };
    },
  );
}
