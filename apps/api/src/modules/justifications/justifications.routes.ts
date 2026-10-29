/**
 * Rutas del registro de RECEPCION de justificantes (prefijo /school/justifications). Ver justifications.service.ts para la
 * autorizacion y las reglas, y docs/architecture/justificantes-recepcion.md.
 *  - Toda ruta exige sesion valida con la puerta de MFA (`adminGuard`); la creacion exige ademas CSRF y Origin.
 *  - Entradas validadas con los contratos Zod compartidos (estrictos; los errores no repiten la entrada).
 *  - El actor sale de la sesion; la hora y el folio los fija el servidor/base. No existen rutas para aprobar, rechazar, editar ni
 *    eliminar: la recepcion es un hecho administrativo inmutable.
 *  - Respuestas con `Cache-Control: no-store` (contienen datos de menores).
 */
import {
  createJustificationReceiptBody,
  listJustificationReceiptsQuery,
  searchJustificationStudentsQuery,
  userIdSchema,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type {
  JustificationContext,
  JustificationFailure,
  JustificationResult,
  JustificationService,
} from './justifications.service.js';

export interface JustificationRoutesOptions {
  service: JustificationService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<JustificationFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  UNAVAILABLE: 503,
};

function context(request: FastifyRequest): JustificationContext {
  const a = request.auth!;
  return {
    actorId: a.user.id,
    grants: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function justificationRoutes(
  app: FastifyInstance,
  options: JustificationRoutesOptions,
): void {
  const { service, guards } = options;
  const rate = { rateLimit: { max: options.floodLimit, timeWindow: '1 minute' } };
  const read = { config: rate, preHandler: guards.adminGuard(options.mfaDeferredAllowed) };
  const write = {
    config: rate,
    preHandler: [guards.adminGuard(options.mfaDeferredAllowed), guards.csrfGuard],
  };
  const idParams = z.object({ id: userIdSchema }).strict();

  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
  const send = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    result: JustificationResult<T>,
    success = 200,
  ) =>
    result.ok
      ? reply.code(success).send(result.value)
      : reply
          .code(STATUS[result.code])
          .send(errorBody(result.reason ?? result.code, result.message, request.id));

  // Sin cache en ningun nivel: los registros contienen nombres de menores.
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  // Buscar al alumno (datos minimos) para elegir a quien se refiere el justificante.
  app.get('/justifications/students', read, async (request, reply) => {
    const q = searchJustificationStudentsQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.searchStudents(context(request), q.data));
  });

  // Registrar la recepcion: 201 si la creo esta peticion; 200 si el reintento ya estaba registrado (el mismo registro).
  app.post('/justifications/receipts', { ...write, bodyLimit: 1024 }, async (request, reply) => {
    const body = createJustificationReceiptBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.create(context(request), body.data);
    if (result.ok) {
      reply.header('Location', `/school/justifications/receipts/${result.value.receipt.id}`);
      return send(request, reply, result, result.value.replayed ? 200 : 201);
    }
    return send(request, reply, result);
  });

  app.get('/justifications/receipts', read, async (request, reply) => {
    const q = listJustificationReceiptsQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.list(context(request), q.data));
  });

  app.get('/justifications/receipts/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success || Object.keys((request.query as object) ?? {}).length > 0)
      return invalid(request, reply);
    return send(request, reply, await service.get(context(request), p.data.id));
  });
}
