/**
 * Rutas de activacion de cuentas.
 *  - PUBLICAS del titular (`/auth/activation/*`): solicitud, estado y finalizacion. Sin sesion: protegidas por la comprobacion
 *    global de Origin, limites de peticiones/intentos antes de cualquier trabajo costoso y respuestas que no enumeran cuentas.
 *  - ADMINISTRATIVAS de la autoridad (`/admin/activation-requests/*`): sesion con puerta de MFA, CSRF en toda mutacion.
 * El secreto de activacion solo llega al servidor en la finalizacion y nunca se registra; ninguna ruta abre una sesion.
 */
import {
  ACTIVATION_TTL_MINUTES,
  activationCompleteBodySchema,
  activationRequestBodySchema,
  activationStatusBodySchema,
  approveActivationBodySchema,
  userIdSchema,
} from '@eta15/shared-contracts';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../admin-users/admin-users.service.js';
import type { Actor } from '../access-control/grant-policy.js';
import type { AttemptLimiter } from '../auth/attempt-limiter.js';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type { ActivationService, ApproveFailure } from './activation.service.js';

export interface ActivationPublicOptions {
  service: ActivationService;
  limiters: {
    /** Solicitudes de activacion por IP (se cuenta cada llamada). */
    requestIp: AttemptLimiter;
    /** Solicitudes por correo normalizado desde cualquier IP: frena el reemplazo repetido de solicitudes ajenas. */
    requestAccount: AttemptLimiter;
    /** Finalizaciones FALLIDAS por IP. */
    completeFailIp: AttemptLimiter;
  };
  floodLimit: number;
}

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

export function activationPublicRoutes(
  app: FastifyInstance,
  options: ActivationPublicOptions,
): void {
  const { service, limiters } = options;
  const rate = { rateLimit: { max: options.floodLimit, timeWindow: '1 minute' } };

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  const tooMany = (request: FastifyRequest, reply: FastifyReply, blockedMs: number) => {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(blockedMs / 1000))));
    return reply
      .code(429)
      .send(errorBody('RATE_LIMITED', 'Demasiados intentos. Intente más tarde.', request.id));
  };
  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));

  app.post('/request', { bodyLimit: 2048, config: rate }, async (request, reply) => {
    const body = activationRequestBodySchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const keys = { ip: `ip:${request.ip}`, account: `acct:${sha256Hex(body.data.email)}` };
    const blocked = Math.max(
      limiters.requestIp.blockedFor(keys.ip),
      limiters.requestAccount.blockedFor(keys.account),
    );
    if (blocked > 0) return tooMany(request, reply, blocked);
    limiters.requestIp.fail(keys.ip);
    limiters.requestAccount.fail(keys.account);
    await service.request({
      email: body.data.email,
      secretHash: body.data.secretHash,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    // Misma respuesta exista o no la cuenta y se haya podido registrar o no la solicitud.
    return reply.code(202).send({ accepted: true, ttlMinutes: ACTIVATION_TTL_MINUTES });
  });

  app.post('/status', { bodyLimit: 1024, config: rate }, async (request, reply) => {
    const body = activationStatusBodySchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    return { state: await service.status(body.data.secretHash) };
  });

  app.post('/complete', { bodyLimit: 4096, config: rate }, async (request, reply) => {
    const body = activationCompleteBodySchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const key = `ip:${request.ip}`;
    const blocked = limiters.completeFailIp.blockedFor(key);
    if (blocked > 0) return tooMany(request, reply, blocked);

    const result = await service.complete({
      secret: body.data.secret,
      newPassword: body.data.newPassword,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    if (result.ok) {
      limiters.completeFailIp.reset(key);
      return reply.code(204).send(); // sin sesion: la persona inicia sesion con la contrasena que acaba de elegir
    }
    if (result.reason === 'policy') {
      return reply.code(400).send({
        error: {
          code: 'PASSWORD_POLICY',
          message: 'La contraseña no cumple la política',
          requestId: request.id,
          reasons: result.policy,
        },
      });
    }
    limiters.completeFailIp.fail(key);
    return reply
      .code(400)
      .send(errorBody('ACTIVATION_INVALID', 'La activación no es válida o ya venció', request.id));
  });
}

// ------------------------------------------------------------------------------------------------ autoridad

export interface ActivationAdminOptions {
  service: ActivationService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<ApproveFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EXPIRED: 409,
  CODE_MISMATCH: 400,
};

function actorContext(request: FastifyRequest): ActorContext {
  const a = request.auth!;
  const actor: Actor = {
    id: a.user.id,
    status: 'active',
    permissions: new Set(a.grants.map((g) => g.permission)),
    roleKeys: new Set(a.roles),
  };
  return {
    actor,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function activationAdminRoutes(app: FastifyInstance, options: ActivationAdminOptions): void {
  const { service, guards } = options;
  const rate = { rateLimit: { max: options.floodLimit, timeWindow: '1 minute' } };
  const read = { config: rate, preHandler: guards.adminGuard(options.mfaDeferredAllowed) };
  const write = {
    config: rate,
    preHandler: [guards.adminGuard(options.mfaDeferredAllowed), guards.csrfGuard],
  };
  const idParams = z.object({ id: userIdSchema }).strict();

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  const send = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    result: { ok: true; value: T } | { ok: false; code: ApproveFailure; message: string },
  ) =>
    result.ok
      ? reply.code(200).send(result.value)
      : reply.code(STATUS[result.code]).send(errorBody(result.code, result.message, request.id));

  app.get('/activation-requests', read, async (request, reply) => {
    const result = await service.list(actorContext(request));
    return result.ok ? { items: result.value } : send(request, reply, result);
  });

  app.post(
    '/activation-requests/:id/approve',
    { ...write, bodyLimit: 1024 },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = approveActivationBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
      }
      return send(
        request,
        reply,
        await service.approve(actorContext(request), params.data.id, body.data),
      );
    },
  );

  app.post('/activation-requests/:id/cancel', write, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
    }
    return send(request, reply, await service.cancel(actorContext(request), params.data.id));
  });
}
