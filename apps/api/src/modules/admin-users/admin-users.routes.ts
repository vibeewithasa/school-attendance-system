/**
 * Rutas /admin/users y /admin/roles. Solo traducen HTTP <-> servicio:
 *  - sesion valida con la puerta de MFA administrativa (`adminGuard`): en produccion una sesion sin MFA verificado no llega aqui;
 *  - CSRF obligatorio en toda mutacion (ademas de la comprobacion global de Origin);
 *  - el actor sale SOLO de la sesion (`request.auth`); los cuerpos no pueden nombrar un actor;
 *  - entradas validadas con los contratos Zod compartidos; los errores de validacion no repiten la entrada;
 *  - respuestas sin `Cache-Control` cacheable ni datos sensibles (ver `toAdminUser`).
 */
import {
  assignRoleBodySchema,
  createUserBodySchema,
  listUsersQuerySchema,
  roleKeySchema,
  userIdSchema,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../access-control/grant-policy.js';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type {
  ActorContext,
  AdminFailure,
  AdminResult,
  AdminUsersService,
} from './admin-users.service.js';

export interface AdminRoutesOptions {
  service: AdminUsersService;
  guards: AuthGuards;
  /** `true` solo si la configuracion admite MFA diferido (nunca en produccion). */
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<AdminFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LAST_AUTHORITY: 409,
  VALIDATION: 400,
};

/** El contexto del actor se deriva de la sesion revalidada en ESTA peticion. */
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

export function adminUsersRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  const { service, guards } = options;
  const rate = { rateLimit: { max: options.floodLimit, timeWindow: '1 minute' } };
  const read = { config: rate, preHandler: guards.adminGuard(options.mfaDeferredAllowed) };
  const write = {
    config: rate,
    preHandler: [guards.adminGuard(options.mfaDeferredAllowed), guards.csrfGuard],
  };

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
  const send = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    result: AdminResult<T>,
    success: number = 200,
  ) => {
    if (result.ok) return reply.code(success).send(result.value);
    return reply.code(STATUS[result.code]).send(errorBody(result.code, result.message, request.id));
  };

  const idParams = z.object({ id: userIdSchema }).strict();
  const roleParams = z.object({ id: userIdSchema, roleKey: roleKeySchema }).strict();

  app.get('/users', read, async (request, reply) => {
    const query = listUsersQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(request, reply);
    return send(request, reply, await service.list(actorContext(request), query.data));
  });

  app.get('/users/:id', read, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(request, reply);
    return send(request, reply, await service.get(actorContext(request), params.data.id));
  });

  app.post('/users', { ...write, bodyLimit: 4096 }, async (request, reply) => {
    const body = createUserBodySchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.create(actorContext(request), body.data);
    if (result.ok) reply.header('Location', `/admin/users/${result.value.id}`);
    return send(request, reply, result, 201);
  });

  app.post('/users/:id/disable', write, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(request, reply);
    return send(request, reply, await service.disable(actorContext(request), params.data.id));
  });

  app.get('/roles', read, async (request, reply) =>
    send(request, reply, await service.listRoles(actorContext(request))),
  );

  app.post('/users/:id/roles', { ...write, bodyLimit: 1024 }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = assignRoleBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(request, reply);
    return send(
      request,
      reply,
      await service.assignRole(actorContext(request), params.data.id, body.data.roleKey),
      201,
    );
  });

  app.delete('/users/:id/roles/:roleKey', write, async (request, reply) => {
    const params = roleParams.safeParse(request.params);
    if (!params.success) return invalid(request, reply);
    return send(
      request,
      reply,
      await service.revokeRole(actorContext(request), params.data.id, params.data.roleKey),
    );
  });
}
