/**
 * Rutas de asistencia diaria (prefijo /school/attendance). Ver attendance.service.ts para la autorizacion y las reglas.
 *  - Toda ruta exige sesion valida con la puerta de MFA (`adminGuard`); las mutaciones exigen ademas CSRF y Origin.
 *  - Entradas validadas con los contratos Zod compartidos (estrictos; los errores no repiten la entrada).
 *  - El actor sale de la sesion; la fecha de la captura la decide el servidor; no existe DELETE ni ruta de correccion.
 *  - Respuestas con `Cache-Control: no-store` (contienen datos de menores).
 */
import {
  finalizeAttendanceDayBody,
  listAttendanceDaysQuery,
  listAttendanceEventsQuery,
  openAttendanceDayBody,
  saveAttendanceMarksBody,
  userIdSchema,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody, type AuthGuards } from '../auth/guards.js';
import type {
  AttendanceContext,
  AttendanceFailure,
  AttendanceResult,
  AttendanceService,
} from './attendance.service.js';

export interface AttendanceRoutesOptions {
  service: AttendanceService;
  guards: AuthGuards;
  mfaDeferredAllowed: boolean;
  floodLimit: number;
}

const STATUS: Record<AttendanceFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  UNAVAILABLE: 503,
};

function context(request: FastifyRequest): AttendanceContext {
  const a = request.auth!;
  return {
    actorId: a.user.id,
    grants: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export function attendanceRoutes(app: FastifyInstance, options: AttendanceRoutesOptions): void {
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
    result: AttendanceResult<T>,
    success = 200,
  ) =>
    result.ok
      ? reply.code(success).send(result.value)
      : reply
          .code(STATUS[result.code])
          .send(errorBody(result.reason ?? result.code, result.message, request.id));

  // Sin cache en ningun nivel: las listas contienen nombres de menores.
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  app.get('/attendance/today', read, async (request, reply) => {
    if (Object.keys((request.query as object) ?? {}).length > 0) return invalid(request, reply);
    return send(request, reply, await service.today(context(request)));
  });

  // Obtener o crear la lista de HOY del grupo: 201 si la creo esta peticion, 200 si ya existia (la misma lista).
  app.post('/attendance/days', { ...write, bodyLimit: 1024 }, async (request, reply) => {
    const body = openAttendanceDayBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.open(context(request), body.data);
    if (result.ok) {
      reply.header('Location', `/school/attendance/days/${result.value.day.id}`);
      return send(request, reply, result, result.value.created ? 201 : 200);
    }
    return send(request, reply, result);
  });

  app.get('/attendance/days', read, async (request, reply) => {
    const q = listAttendanceDaysQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    return send(request, reply, await service.list(context(request), q.data));
  });

  app.get('/attendance/days/:id', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return invalid(request, reply);
    return send(request, reply, await service.get(context(request), p.data.id));
  });

  app.post(
    '/attendance/days/:id/marks',
    { ...write, bodyLimit: 32_768 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      const body = saveAttendanceMarksBody.safeParse(request.body);
      if (!p.success || !body.success) return invalid(request, reply);
      return send(request, reply, await service.saveMarks(context(request), p.data.id, body.data));
    },
  );

  app.post(
    '/attendance/days/:id/finalize',
    { ...write, bodyLimit: 1024 },
    async (request, reply) => {
      const p = idParams.safeParse(request.params);
      const body = finalizeAttendanceDayBody.safeParse(request.body);
      if (!p.success || !body.success) return invalid(request, reply);
      return send(request, reply, await service.finalize(context(request), p.data.id, body.data));
    },
  );

  app.get('/attendance/days/:id/events', read, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const q = listAttendanceEventsQuery.safeParse(request.query);
    if (!p.success || !q.success) return invalid(request, reply);
    return send(request, reply, await service.events(context(request), p.data.id, q.data));
  });
}
