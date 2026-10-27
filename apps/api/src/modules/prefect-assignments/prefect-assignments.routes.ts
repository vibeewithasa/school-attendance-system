/**
 * Rutas de asignaciones de grupos a prefectura (prefijo /school). Ver prefect-assignments.service.ts para la autorizacion.
 *  - Toda ruta exige sesion valida con la puerta de MFA (`adminGuard`); las mutaciones exigen ademas CSRF y Origin.
 *  - Entradas validadas con los contratos Zod compartidos (estrictos; los errores no repiten la entrada).
 *  - Sin DELETE: las asignaciones se cierran (fecha) o se revocan (inmediato); el historial se conserva.
 *  - El actor sale de la sesion; `/me/groups` jamas recibe un identificador de persona.
 */
import {
  closePrefectAssignmentBody,
  createPrefectAssignmentBody,
  listPrefectAssignmentsQuery,
  listPrefectCandidatesQuery,
  revokePrefectAssignmentBody,
  userIdSchema,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type {
  PrefectAssignmentsService,
  PrefectContext,
  PrefectFailure,
  PrefectResult,
} from './prefect-assignments.service.js';

export interface PrefectAssignmentsRoutesOptions {
  service: PrefectAssignmentsService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<PrefectFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  UNAVAILABLE: 503,
};

function context(request: FastifyRequest): PrefectContext {
  const a = request.auth!;
  return {
    actorId: a.user.id,
    grants: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function prefectAssignmentsRoutes(
  app: FastifyInstance,
  options: PrefectAssignmentsRoutesOptions,
): void {
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

  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
  const send = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    result: PrefectResult<T>,
    success = 200,
  ) =>
    result.ok
      ? reply.code(success).send(result.value)
      : reply
          .code(STATUS[result.code])
          .send(errorBody(result.reason ?? result.code, result.message, request.id));

  app.get('/prefect-candidates', read, async (request, reply) => {
    const q = listPrefectCandidatesQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.listCandidates(context(request), q.data));
  });

  app.get('/prefect-assignments', read, async (request, reply) => {
    const q = listPrefectAssignmentsQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.list(context(request), q.data));
  });

  app.post('/prefect-assignments', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const body = createPrefectAssignmentBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.create(context(request), body.data);
    if (result.ok) reply.header('Location', `/school/prefect-assignments/${result.value.id}`);
    return send(request, reply, result, 201);
  });

  app.get('/prefect-assignments/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.get(context(request), p.data.id));
  });

  app.post(
    '/prefect-assignments/:id/close',
    { ...write, bodyLimit: 2048 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      const body = closePrefectAssignmentBody.safeParse(request.body ?? {});
      if (!p.success || !body.success) return invalid(request, reply);
      return send(request, reply, await service.close(context(request), p.data.id, body.data));
    },
  );

  app.post(
    '/prefect-assignments/:id/revoke',
    { ...write, bodyLimit: 2048 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      const body = revokePrefectAssignmentBody.safeParse(request.body);
      if (!p.success || !body.success) return invalid(request, reply);
      return send(request, reply, await service.revoke(context(request), p.data.id, body.data));
    },
  );

  // Contrato minimo para el cliente Android: solo los grupos de HOY de quien consulta (el servidor filtra siempre antes).
  app.get('/me/groups', read, async (request, reply) => {
    if (Object.keys((request.query as object) ?? {}).length > 0) return invalid(request, reply);
    return send(request, reply, await service.myGroups(context(request)));
  });
}
