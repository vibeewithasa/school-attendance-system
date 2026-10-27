/**
 * Rutas del catalogo escolar: /catalog/school-years y /catalog/groups.
 *  - Lectura: sesion valida y `catalog:read` (alcance `all`) revalidados en cada peticion.
 *  - Escritura: sesion con puerta de MFA (`adminGuard`), CSRF y `catalog:manage_school` (alcance `all`). Un usuario autenticado
 *    cualquiera NO administra el catalogo.
 *  - Entradas validadas con los contratos Zod compartidos (estrictos; los errores no repiten la entrada).
 *  - Sin DELETE: los ciclos y grupos se desactivan, nunca se borran.
 */
import {
  createGroupBody,
  createSchoolYearBody,
  listGroupsQuery,
  listSchoolYearsQuery,
  updateGroupBody,
  updateSchoolYearBody,
  userIdSchema,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../access-control/grant-policy.js';
import type { ActorContext } from '../admin-users/admin-users.service.js';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type {
  CatalogFailure,
  CatalogResult,
  SchoolCatalogService,
} from './school-catalog.service.js';

export interface SchoolCatalogRoutesOptions {
  service: SchoolCatalogService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<CatalogFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  HISTORICAL: 409,
  WRITE_UNAVAILABLE: 503,
};
const CODE: Partial<Record<CatalogFailure, string>> = {
  WRITE_UNAVAILABLE: 'CATALOG_WRITE_UNAVAILABLE',
};

/** Solo cuentan los permisos con alcance `all`: un permiso del catalogo con otro alcance no autoriza. */
function actorContext(request: FastifyRequest): ActorContext {
  const a = request.auth!;
  const actor: Actor = {
    id: a.user.id,
    status: 'active',
    permissions: new Set(a.grants.filter((g) => g.scope === 'all').map((g) => g.permission)),
    roleKeys: new Set(a.roles),
  };
  return {
    actor,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function schoolCatalogRoutes(
  app: FastifyInstance,
  options: SchoolCatalogRoutesOptions,
): void {
  const { service, guards } = options;
  const rate = { rateLimit: { max: options.floodLimit, timeWindow: '1 minute' } };
  const read = { config: rate, preHandler: guards.sessionGuard() };
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
    result: CatalogResult<T>,
    success = 200,
  ) =>
    result.ok
      ? reply.code(success).send(result.value)
      : reply
          .code(STATUS[result.code])
          .send(errorBody(CODE[result.code] ?? result.code, result.message, request.id));

  // ------------------------------------------------------------------------------------------- ciclos
  app.get('/school-years', read, async (request, reply) => {
    const q = listSchoolYearsQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.listSchoolYears(actorContext(request), q.data));
  });

  app.get('/school-years/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.getSchoolYear(actorContext(request), p.data.id));
  });

  app.post('/school-years', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const body = createSchoolYearBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.createSchoolYear(actorContext(request), body.data);
    if (result.ok) reply.header('Location', `/catalog/school-years/${result.value.id}`);
    return send(request, reply, result, 201);
  });

  app.patch('/school-years/:id', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = updateSchoolYearBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    return send(
      request,
      reply,
      await service.updateSchoolYear(actorContext(request), p.data.id, body.data),
    );
  });

  app.post('/school-years/:id/activate', write, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.activateSchoolYear(actorContext(request), p.data.id));
  });

  app.post('/school-years/:id/deactivate', write, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(
      request,
      reply,
      await service.deactivateSchoolYear(actorContext(request), p.data.id),
    );
  });

  // ------------------------------------------------------------------------------------------- grupos
  app.get('/groups', read, async (request, reply) => {
    const q = listGroupsQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.listGroups(actorContext(request), q.data));
  });

  app.get('/groups/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.getGroup(actorContext(request), p.data.id));
  });

  app.post('/groups', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const body = createGroupBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.createGroup(actorContext(request), body.data);
    if (result.ok) reply.header('Location', `/catalog/groups/${result.value.id}`);
    return send(request, reply, result, 201);
  });

  app.patch('/groups/:id', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = updateGroupBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    return send(
      request,
      reply,
      await service.updateGroup(actorContext(request), p.data.id, body.data),
    );
  });
}
