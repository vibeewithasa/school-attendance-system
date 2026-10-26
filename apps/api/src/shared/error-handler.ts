import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '@eta15/shared-contracts';
import { AppError } from './errors.js';

/** Manejo centralizado: nunca filtra detalles internos en errores 5xx. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: { code: 'NOT_FOUND', message: 'Recurso no encontrado', requestId: request.id },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    const isApp = error instanceof AppError;
    const statusCode = isApp ? error.statusCode : (error.statusCode ?? 500);

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'error no controlado');
    } else {
      request.log.warn({ err: error }, 'solicitud rechazada');
    }

    const body: ApiErrorBody = {
      error: {
        code: isApp ? error.code : statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: statusCode >= 500 ? 'Error interno del servidor' : error.message,
        requestId: request.id,
      },
    };
    return reply.status(statusCode).send(body);
  });
}
