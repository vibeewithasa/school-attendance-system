/**
 * Rutas de alumnos, matriculas e historial de grupo (prefijo /school). Ver students.service.ts para la autorizacion.
 *  - Toda ruta exige sesion valida con la puerta de MFA (`adminGuard`): son datos de menores. Las mutaciones exigen ademas CSRF.
 *  - Entradas validadas con los contratos Zod compartidos (estrictos; los errores no repiten la entrada).
 *  - Sin DELETE: los alumnos se desactivan; las matriculas y grupos se cierran. Los alumnos NO son cuentas de acceso.
 *  - Respuestas con `Cache-Control: no-store`. Un recurso fuera de alcance responde igual que uno inexistente (404).
 */
import {
  assignGroupBody,
  createStudentBody,
  enrollBody,
  listStudentsQuery,
  transferBody,
  updateStudentBody,
  userIdSchema,
  withdrawBody,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type {
  StudentsContext,
  StudentsFailure,
  StudentsResult,
  StudentsService,
} from './students.service.js';

export interface StudentsRoutesOptions {
  service: StudentsService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<StudentsFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  HISTORICAL: 409,
  UNAVAILABLE: 503,
};

function context(request: FastifyRequest): StudentsContext {
  const a = request.auth!;
  return {
    actorId: a.user.id,
    grants: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function studentsRoutes(app: FastifyInstance, options: StudentsRoutesOptions): void {
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
    result: StudentsResult<T>,
    success = 200,
  ) =>
    result.ok
      ? reply.code(success).send(result.value)
      : reply
          .code(STATUS[result.code])
          .send(
            errorBody(
              result.reason ??
                (result.code === 'UNAVAILABLE' ? 'STUDENTS_UNAVAILABLE' : result.code),
              result.message,
              request.id,
            ),
          );

  // ------------------------------------------------------------------------------------------- alumnos
  app.get('/students', read, async (request, reply) => {
    const q = listStudentsQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.listStudents(context(request), q.data));
  });

  app.post('/students', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const body = createStudentBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.createStudent(context(request), body.data);
    if (result.ok) reply.header('Location', `/school/students/${result.value.id}`);
    return send(request, reply, result, 201);
  });

  app.get('/students/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.getStudent(context(request), p.data.id));
  });

  app.patch('/students/:id', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = updateStudentBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    return send(
      request,
      reply,
      await service.updateStudent(context(request), p.data.id, body.data),
    );
  });

  app.post('/students/:id/deactivate', write, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.deactivateStudent(context(request), p.data.id));
  });

  app.post('/students/:id/reactivate', write, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.reactivateStudent(context(request), p.data.id));
  });

  // ------------------------------------------------------------------------------------------- matriculas
  app.get('/students/:id/enrollments', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.listEnrollments(context(request), p.data.id));
  });

  app.post('/students/:id/enrollments', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = enrollBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    const result = await service.enroll(context(request), p.data.id, body.data);
    if (result.ok) reply.header('Location', `/school/enrollments/${result.value.id}`);
    return send(request, reply, result, 201);
  });

  app.get('/enrollments/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.getEnrollment(context(request), p.data.id));
  });

  app.post('/enrollments/:id/withdraw', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = withdrawBody.safeParse(request.body ?? {});
    if (!p.success || !body.success) return invalid(request, reply);
    return send(request, reply, await service.withdraw(context(request), p.data.id, body.data));
  });

  // ------------------------------------------------------------------------------------------- lista de grupo (Android)
  groupRosterRoute(app, {
    service,
    config: rate,
    preHandler: guards.adminGuard(options.mfaDeferredAllowed),
  });

  // ------------------------------------------------------------------------------------------- grupos
  app.post(
    '/enrollments/:id/group-assignments',
    { ...write, bodyLimit: 2048 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      const body = assignGroupBody.safeParse(request.body);
      if (!p.success || !body.success) return invalid(request, reply);
      return send(
        request,
        reply,
        await service.assignGroup(context(request), p.data.id, body.data),
        201,
      );
    },
  );

  app.post('/enrollments/:id/transfer', { ...write, bodyLimit: 2048 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = transferBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    return send(request, reply, await service.transfer(context(request), p.data.id, body.data));
  });
}

/**
 * `GET /groups/:id/roster`: padron minimo de un grupo AUTORIZADO para quien consulta (404 si no lo es). Se registra en el canal web
 * (cookie) y en el movil (token DPoP) con el MISMO handler y el MISMO servicio; el alcance `assigned_groups` lo aplica el servicio
 * dentro de la consulta, y la identidad sale siempre de `request.auth`.
 */
export function groupRosterRoute(
  app: FastifyInstance,
  options: {
    service: StudentsService;
    config: Record<string, unknown>;
    preHandler: RouteShorthandOptions['preHandler'];
  },
): void {
  const idParams = z.object({ id: userIdSchema }).strict();
  app.get(
    '/groups/:id/roster',
    { config: options.config, preHandler: options.preHandler },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success || Object.keys((request.query as object) ?? {}).length > 0)
        return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
      const result = await options.service.getGroupRoster(context(request), p.data.id);
      return result.ok
        ? reply.code(200).send(result.value)
        : reply
            .code(STATUS[result.code])
            .send(errorBody(result.reason ?? result.code, result.message, request.id));
    },
  );
}
