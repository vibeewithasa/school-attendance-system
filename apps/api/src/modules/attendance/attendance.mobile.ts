/**
 * LECTURA de la asistencia por el canal MOVIL (prototipo de sandbox; ADR 0005 y ADR 0006, ambos PROPUESTOS, no aceptados).
 *
 * Solo existen rutas GET y reutilizan el MISMO servicio que el portal (`attendance.service.ts`): ninguna regla de alcance, fecha o
 * revision se duplica aqui. Este archivo solo (1) registra las rutas con los guardas MOVILES (DPoP + sesion de dispositivo; nunca
 * cookie, CSRF ni `adminGuard`), (2) pasa el contexto del dispositivo a la auditoria y (3) PROYECTA la respuesta a los campos minimos
 * de `@eta15/shared-contracts` (sin nombres de alumnos, sin quien abrio o finalizo, sin `editable`).
 *
 * Las rutas GET solo se registran con la configuracion explicita `mobile.attendanceRead` (apagada por omision; solo sandbox).
 *
 * ESCRITURA (fase 2, ADR 0006 propuesto): con `mobile.attendanceWrite` (apagada por omision; exige la lectura; solo sandbox) existen
 * EXACTAMENTE dos operaciones POST: abrir la lista del dia (`POST /days`) y guardar marcas (`POST /days/:id/marks`). Reutilizan
 * `service.open` y `service.saveMarks`: la fecha la decide el servidor, la autorizacion se revalida con bloqueo, el padron esta
 * congelado, `expectedRevision` detecta conflictos y `requestId` + huella hacen idempotente cada reintento. NO existen finalizar,
 * borrar, corregir ni historial; el token movil solo lleva `attendance:capture` (alcance `assigned_groups`) con el interruptor
 * de escritura encendido. Con `attendanceWrite` apagado no se registra ninguna ruta POST y el token no lleva ese permiso.
 *
 * Fecha: "hoy" lo decide el servidor (America/Mazatlan, en el servicio). Las lecturas usan una FOTO consistente (REPEATABLE READ)
 * para que conteos, renglones y revision de una misma respuesta pertenezcan al mismo instante.
 */
import { createHash } from 'node:crypto';
import {
  listAttendanceDaysQuery,
  mobileOpenAttendanceDayBody,
  saveAttendanceMarksBody,
  userIdSchema,
  type AttendanceDayDetail,
  type AttendanceDayDto,
  type AttendanceDayList,
  type AttendanceTodayResponse,
  type MobileAttendanceDayDetail,
  type MobileAttendanceDayDto,
  type MobileAttendanceDayList,
  type MobileAttendanceOpenResponse,
  type MobileAttendanceSaveResponse,
  type MobileAttendanceTodayResponse,
  type OpenAttendanceDayResponse,
  type SaveAttendanceMarksResponse,
} from '@eta15/shared-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { errorBody } from '../auth/guards.js';
import type {
  AttendanceContext,
  AttendanceFailure,
  AttendanceResult,
  AttendanceService,
} from './attendance.service.js';

const STATUS: Record<AttendanceFailure, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  UNAVAILABLE: 503,
};

/**
 * Huella v1 del padron congelado de una lista: `v1:` + SHA-256 hexadecimal (minuscula) de los identificadores de alumno en
 * minuscula, ordenados ascendentemente como cadenas (orden de unidades de codigo, estable) y unidos con "\n" (sin "\n" final).
 * Una lista sin alumnos produce la huella de la cadena vacia. Depende SOLO del conjunto de alumnos: ni del orden de entrada, ni de
 * los estados, ni de los nombres.
 */
export function rosterDigestV1(studentIds: readonly string[]): string {
  const canonical = studentIds
    .map((id) => id.toLowerCase())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('\n');
  return `v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

const dayDto = (d: AttendanceDayDto): MobileAttendanceDayDto => ({
  id: d.id,
  groupId: d.group.id,
  schoolYearId: d.group.schoolYearId,
  attendanceDate: d.attendanceDate,
  status: d.status,
  revision: d.revision,
  counts: {
    total: d.counts.total,
    present: d.counts.present,
    absent: d.counts.absent,
    pending: d.counts.pending,
  },
  finalizedAt: d.finalizedAt,
});

export const projectToday = (
  r: AttendanceTodayResponse,
  serverTime: Date,
): MobileAttendanceTodayResponse => ({
  schoolToday: r.schoolToday,
  isSchoolDay: r.isSchoolDay,
  serverTime: serverTime.toISOString(),
  groups: r.groups.map((g) => ({
    groupId: g.group.id,
    schoolYearId: g.group.schoolYearId,
    day: g.day ? dayDto(g.day) : null,
  })),
});

export const projectDetail = (
  r: AttendanceDayDetail,
  serverTime: Date,
): MobileAttendanceDayDetail => ({
  schoolToday: r.schoolToday,
  serverTime: serverTime.toISOString(),
  day: dayDto(r),
  rosterDigest: rosterDigestV1(r.records.map((x) => x.studentId)),
  records: r.records.map((x) => ({
    studentId: x.studentId,
    status: x.status,
    markedAt: x.markedAt,
  })),
  discrepancies: {
    addedToRoster: r.discrepancies.addedToRoster,
    removedFromRoster: r.discrepancies.removedFromRoster,
  },
});

export const projectList = (r: AttendanceDayList): MobileAttendanceDayList => ({
  items: r.items.map(dayDto),
  page: r.page,
  pageSize: r.pageSize,
  total: r.total,
});

export const projectOpen = (
  r: OpenAttendanceDayResponse,
  serverTime: Date,
): MobileAttendanceOpenResponse => ({ day: projectDetail(r.day, serverTime), created: r.created });

export const projectSave = (
  r: SaveAttendanceMarksResponse,
  serverTime: Date,
): MobileAttendanceSaveResponse => ({
  day: projectDetail(r.day, serverTime),
  changed: r.changed,
  replayed: r.replayed,
});

export interface MobileAttendanceRoutesOptions {
  service: AttendanceService;
  /** Registra las DOS escrituras (abrir y guardar marcas). Apagado por omision: sin el, no existe ninguna ruta POST. */
  write?: boolean;
  /** `config` de ruta (canal movil y limite de tasa) y guardas moviles; los define quien registra (auth.module). */
  config: Record<string, unknown>;
  preHandler: RouteShorthandOptions['preHandler'];
  /** Reloj del servidor de aplicaciones para `serverTime` (inyectable en pruebas). */
  now?: () => Date;
}

/** Contexto de la peticion MOVIL: el actor y los permisos salen del token verificado (nunca del cliente); la IP se guarda gruesa. */
function mobileContext(
  request: FastifyRequest,
  coarseIp: (ip: string | null | undefined) => string | null,
): AttendanceContext {
  const a = request.auth!;
  return {
    actorId: a.user.id,
    grants: a.grants.map((g) => ({ permission: g.permission, scope: g.scope })),
    ip: coarseIp(request.ip),
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
    channel: 'mobile',
    deviceId: request.mobile?.deviceId ?? null,
  };
}

export function mobileAttendanceRoutes(
  app: FastifyInstance,
  options: MobileAttendanceRoutesOptions,
  coarseIp: (ip: string | null | undefined) => string | null,
): void {
  const { service } = options;
  const now = options.now ?? (() => new Date());
  const route = { config: options.config, preHandler: options.preHandler };
  const idParams = z.object({ id: userIdSchema }).strict();

  const invalid = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody('VALIDATION_ERROR', 'Datos no válidos', request.id));
  const send = <T, U>(
    request: FastifyRequest,
    reply: FastifyReply,
    result: AttendanceResult<T>,
    project: (value: T) => U,
    success = 200,
  ) =>
    result.ok
      ? reply.code(success).send(project(result.value))
      : reply
          .code(STATUS[result.code])
          .send(errorBody(result.reason ?? result.code, result.message, request.id));

  // Grupos asignados HOY y estado de la lista de hoy de cada uno.
  app.get('/today', route, async (request, reply) => {
    if (Object.keys((request.query as object) ?? {}).length > 0) return invalid(request, reply);
    const result = await service.today(mobileContext(request, coarseIp), { snapshot: true });
    return send(request, reply, result, (v) => projectToday(v, now()));
  });

  // Listas por grupo y rango de fechas (resumen; sin renglones). El alcance (grupos asignados) lo aplica el servicio en la consulta.
  app.get('/days', route, async (request, reply) => {
    const q = listAttendanceDaysQuery.safeParse(request.query);
    if (!q.success) return invalid(request, reply);
    const result = await service.list(mobileContext(request, coarseIp), q.data, { snapshot: true });
    return send(request, reply, result, projectList);
  });

  // Una lista: cabecera, padron congelado (solo ids) y marcas. Fuera de alcance == inexistente (404).
  app.get('/days/:id', route, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success || Object.keys((request.query as object) ?? {}).length > 0)
      return invalid(request, reply);
    const result = await service.get(mobileContext(request, coarseIp), p.data.id, {
      snapshot: true,
    });
    return send(request, reply, result, (v) => projectDetail(v, now()));
  });

  if (!options.write) return;

  // ------------------------------------------------------------------------------------------------ ESCRITURA (sandbox)
  // Abrir (u obtener) la lista de HOY del grupo. `attendanceDate` es OBLIGATORIA en el canal movil: el servidor la CONTRASTA con
  // su "hoy" (otra fecha => 400 DATE_NOT_TODAY, sin crear nada), asi un dispositivo con el reloj mal nunca crea ni etiqueta la lista
  // de otro dia. 201 si esta peticion la creo; 200 si ya existia (la misma lista para todas las personas con acceso).
  app.post('/days', { ...route, bodyLimit: 1024 }, async (request, reply) => {
    const body = mobileOpenAttendanceDayBody.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    const result = await service.open(mobileContext(request, coarseIp), body.data);
    return send(
      request,
      reply,
      result,
      (v) => projectOpen(v, now()),
      result.ok && result.value.created ? 201 : 200,
    );
  });

  // Guardar marcas del borrador. `expectedRevision` = la revision que el cliente vio; `requestId` identifica la OPERACION (estable en
  // los reintentos, distinto del `jti` de DPoP, que cambia en cada peticion). Mismo requestId con otro contenido o de otra cuenta =>
  // 409 IDEMPOTENCY_MISMATCH. Una repeticion ya aplicada responde 200 con `replayed: true`.
  app.post('/days/:id/marks', { ...route, bodyLimit: 32_768 }, async (request, reply) => {
    const p = idParams.safeParse(request.params);
    const body = saveAttendanceMarksBody.safeParse(request.body);
    if (!p.success || !body.success) return invalid(request, reply);
    const result = await service.saveMarks(mobileContext(request, coarseIp), p.data.id, body.data);
    return send(request, reply, result, (v) => projectSave(v, now()));
  });
}
