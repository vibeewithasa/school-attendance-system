/**
 * Rutas WEB (prefijo /mobile-devices) para vincular y administrar dispositivos moviles. Canal del NAVEGADOR: cookie de sesion + CSRF
 * + Origin como en el resto del portal; las operaciones de autoridad ademas pasan la puerta de MFA (`adminGuard`).
 *
 *   POST /claims                                     la persona titular liga la solicitud del dispositivo a SU cuenta (codigo)
 *   GET  /mine                                       solicitudes y dispositivos de la propia persona
 *   POST /mine/requests/:id/cancel                   cancela su solicitud
 *   POST /mine/devices/:id/revoke                    revoca SU dispositivo
 *   GET  /                                           autoridad: solicitudes por aprobar y dispositivos
 *   POST /requests/:id/approve | /reject             autoridad: aprueba (confirmando la huella) o rechaza
 *   POST /devices/:id/revoke                         autoridad: revoca cualquier dispositivo
 * El actor sale siempre de la sesion; ninguna ruta acepta un `userId`.
 */
import {
  approveMobileDeviceBody,
  claimMobileDeviceBody,
  revokeMobileDeviceBody,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AttemptLimiter } from '../auth/attempt-limiter.js';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type { MobileAuthService, WebContext } from './mobile-auth.service.js';
import { sendMobileResult } from './mobile-auth.routes.js';

export interface MobileDevicesRoutesOptions {
  service: MobileAuthService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  /** Intentos fallidos de reclamo por cuenta (ademas del tope por solicitud en la base). */
  claimLimiter: AttemptLimiter;
  floodLimit: number;
}

const idParams = z.object({ id: z.uuid() }).strict();

function context(request: FastifyRequest): WebContext {
  const a = request.auth!;
  return {
    actorId: a.user.id,
    grants: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function mobileDevicesRoutes(
  app: FastifyInstance,
  options: MobileDevicesRoutesOptions,
): void {
  const { service, guards, claimLimiter } = options;
  const rate = { rateLimit: { max: options.floodLimit, timeWindow: '1 minute' } };
  // La persona titular (prefectura) no requiere MFA: sesion normal. La autoridad usa la puerta administrativa completa.
  const self = { config: rate, preHandler: guards.sessionGuard() };
  const selfWrite = { config: rate, preHandler: [guards.sessionGuard(), guards.csrfGuard] };
  const authority = { config: rate, preHandler: guards.adminGuard(options.mfaDeferredAllowed) };
  const authorityWrite = {
    config: rate,
    preHandler: [guards.adminGuard(options.mfaDeferredAllowed), guards.csrfGuard],
  };

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));

  app.post('/claims', { ...selfWrite, bodyLimit: 512 }, async (request, reply) => {
    const body = claimMobileDeviceBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const key = `user:${request.auth!.user.id}`;
    const blocked = claimLimiter.blockedFor(key);
    if (blocked > 0) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil(blocked / 1000))));
      return reply
        .code(429)
        .send(errorBody('RATE_LIMITED', 'Demasiados intentos. Intente más tarde.', request.id));
    }
    const result = await service.claim(context(request), body.data);
    if (!result.ok && result.reason === 'CLAIM_INVALID') claimLimiter.fail(key);
    if (result.ok) claimLimiter.reset(key);
    return sendMobileResult(request, reply, result, 200);
  });

  app.get('/mine', self, async (request, reply) =>
    sendMobileResult(request, reply, await service.listMine(context(request))),
  );

  app.post(
    '/mine/requests/:id/cancel',
    { ...selfWrite, bodyLimit: 256 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return invalid(request, reply);
      return sendMobileResult(
        request,
        reply,
        await service.closeRequest(context(request), p.data.id, 'cancel'),
      );
    },
  );

  app.post('/mine/devices/:id/revoke', { ...selfWrite, bodyLimit: 256 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    // La persona titular solo revoca SUS dispositivos: el motivo lo fija el servidor.
    return sendMobileResult(
      request,
      reply,
      await service.revokeDevice(context(request), p.data.id, 'titular', 'titular'),
    );
  });

  app.get('/', authority, async (request, reply) =>
    sendMobileResult(request, reply, await service.listForAuthority(context(request))),
  );

  app.post(
    '/requests/:id/approve',
    { ...authorityWrite, bodyLimit: 256 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      const body = approveMobileDeviceBody.safeParse(request.body);
      if (!p.success || !body.success) return invalid(request, reply);
      return sendMobileResult(
        request,
        reply,
        await service.approve(context(request), p.data.id, body.data),
      );
    },
  );

  app.post(
    '/requests/:id/reject',
    { ...authorityWrite, bodyLimit: 256 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return invalid(request, reply);
      return sendMobileResult(
        request,
        reply,
        await service.closeRequest(context(request), p.data.id, 'reject'),
      );
    },
  );

  app.post('/devices/:id/revoke', { ...authorityWrite, bodyLimit: 256 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = revokeMobileDeviceBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    return sendMobileResult(
      request,
      reply,
      await service.revokeDevice(context(request), p.data.id, body.data.reason, 'authority'),
    );
  });
}
