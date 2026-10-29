/**
 * Registro de RECEPCION de justificantes (Trabajo Social, MVP; logica de dominio, sin HTTP). Ver
 * docs/architecture/justificantes-recepcion.md.
 *
 * Lo que HACE: registra el hecho "se recibio un justificante del alumno X para el dia escolar D", con folio, quien y cuando.
 * Lo que NO hace (decision institucional D-10 pendiente): aprobar o rechazar, justificar faltas, tocar `attendance_*`, alterar
 * reportes, generar alertas, adjuntar documentos ni guardar motivos o diagnosticos. Este modulo no escribe ni lee asistencia.
 *
 * Autorizacion (denegar por defecto; solo alcance `all`, nunca `assigned_groups`: la prefectura NO accede aunque tenga la concesion
 * historica `justifications:read assigned_groups` de la semilla 0004):
 *  - justifications:create (trabajo_social)           -> registrar la recepcion y buscar al alumno.
 *  - justifications:read   (trabajo_social, direccion) -> consultar registros (y buscar al alumno).
 * Sin permiso: 403 + auditoria `authz.denied`. El actor sale de la sesion; `receivedAt` lo fija la base; el folio lo fija la base.
 *
 * Idempotencia: `requestId` (UUID del cliente) UNIQUE por persona. El mismo `requestId` con el mismo contenido devuelve el MISMO
 * registro (`replayed`, sin evento de auditoria nuevo); con otro contenido -> 409 + auditoria de uso incorrecto. No existe UNIQUE
 * alumno + fecha: pueden recibirse varios documentos del mismo dia.
 * La auditoria registra IDs, folio y fecha; nunca nombres de menores, tokens ni datos medicos (no se capturan).
 */
import { createHash } from 'node:crypto';
import {
  SCHOOL_TIME_ZONE,
  JUSTIFICATION_SEARCH_LIMIT,
  type CreateJustificationReceiptBody,
  type CreateJustificationReceiptResponse,
  type JustificationReceiptDto,
  type JustificationReceiptList,
  type JustificationStudentSearch,
  type ListJustificationReceiptsQuery,
  type SearchJustificationStudentsQuery,
  type Shift,
} from '@eta15/shared-contracts';
import type { Grant } from '../access-control/authorize.js';
import { recordAudit } from '../audit/audit-log.js';
import type { SessionStore, SqlClient } from '../auth/session-service.js';

export type JustificationFailure =
  'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'UNAVAILABLE';
export type JustificationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: JustificationFailure; message: string; reason?: string };
const fail = (code: JustificationFailure, message: string, reason?: string) => ({
  ok: false as const,
  code,
  message,
  ...(reason ? { reason } : {}),
});

/** Quien llama: el actor sale de la sesion revalidada; los permisos con su alcance, de la base de datos. */
export interface JustificationContext {
  actorId: string;
  grants: readonly Grant[];
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface JustificationServiceOptions {
  store: SessionStore;
  /** "Hoy" (YYYY-MM-DD, hora de la escuela). Por defecto lo calcula la base. Inyectable en pruebas. */
  today?: () => string;
}

/** Solo el alcance `all` cuenta: no existe "justificantes de mis grupos". */
const hasAll = (grants: readonly Grant[], permission: string) =>
  grants.some((g) => g.permission === permission && g.scope === 'all');

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** SHA-256 del contenido de un registro (alumno y fecha): un reintento identico produce el mismo valor. */
export function receiptHash(studentId: string, schoolDate: string): string {
  return createHash('sha256')
    .update(`${studentId.toLowerCase()}|${schoolDate}`, 'utf8')
    .digest('hex');
}

const isoWeekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = domingo

interface ReceiptRow {
  id: string;
  folio: string;
  status: 'received';
  student_id: string;
  given_names: string;
  family_name: string;
  school_date: string;
  received_at: Date;
  received_by: string;
  received_by_name: string;
}

const RECEIPT_SELECT = `
  SELECT r.id, r.folio, r.status, r.student_id, s.given_names, s.family_name, r.school_date::text AS school_date,
         r.received_at, r.received_by, u.display_name AS received_by_name
    FROM justification_receipts r
    JOIN students s ON s.id = r.student_id
    JOIN users u ON u.id = r.received_by`;

const toDto = (r: ReceiptRow): JustificationReceiptDto => ({
  id: r.id,
  folio: r.folio,
  status: r.status,
  student: { id: r.student_id, givenNames: r.given_names, familyName: r.family_name },
  schoolDate: r.school_date,
  receivedAt: new Date(r.received_at).toISOString(),
  receivedBy: { id: r.received_by, displayName: r.received_by_name },
});

export function createJustificationService(options: JustificationServiceOptions) {
  const { store } = options;

  const todayOf = async (tx: SqlClient): Promise<string> => {
    if (options.today) return options.today();
    const r = await tx.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`,
      [SCHOOL_TIME_ZONE],
    );
    return r.rows[0]!.d;
  };

  const audit = (
    tx: SqlClient,
    ctx: JustificationContext,
    type: string,
    details: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ) =>
    recordAudit(
      tx,
      { actorId: ctx.actorId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
      { type, outcome, details },
    );

  async function denied(ctx: JustificationContext, action: string): Promise<void> {
    await store
      .transaction((tx) =>
        recordAudit(
          tx,
          { actorId: ctx.actorId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
          {
            type: 'authz.denied',
            outcome: 'denied',
            details: { action, reason: 'missing_permission' },
          },
        ),
      )
      .catch(() => undefined);
  }

  /** Lecturas consistentes: una sola foto (REPEATABLE READ) para el conteo y la pagina. Debe ser la PRIMERA sentencia. */
  const beginSnapshot = (tx: SqlClient) =>
    tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

  const unavailable = () =>
    fail(
      'UNAVAILABLE',
      'El registro de justificantes aún no está habilitado en la base de datos',
      'JUSTIFICATIONS_UNAVAILABLE',
    );
  const dbDown = () =>
    fail('UNAVAILABLE', 'La base de datos no está disponible; reintente', 'DATABASE_UNAVAILABLE');

  /** Errores de la base -> respuestas controladas. Nunca se devuelve el mensaje SQL. */
  function mapError(error: unknown): JustificationResult<never> {
    const e = error as { code?: string; constraint?: string; message?: string };
    switch (e.code) {
      case '23514':
        switch (e.constraint) {
          case 'jr_enrolled_on_date':
            return fail(
              'VALIDATION',
              'El alumno no estaba inscrito en esa fecha',
              'NOT_ENROLLED_ON_DATE',
            );
          case 'jr_not_future':
            return fail(
              'VALIDATION',
              'No se registran justificantes de fechas futuras',
              'DATE_IN_FUTURE',
            );
          case 'jr_weekday':
            return fail(
              'VALIDATION',
              'La fecha escolar debe ser de lunes a viernes',
              'NOT_SCHOOL_DAY',
            );
          default:
            return fail('VALIDATION', 'Los datos no cumplen las reglas del registro', 'INVALID');
        }
      case '23503':
      case '22P02':
      case '22007':
      case '22008':
      case '23502':
        return fail('VALIDATION', 'Los datos no cumplen las reglas del registro', 'INVALID');
      case '40001':
      case '40P01':
        return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente', 'CONCURRENT');
      case '42501':
        return unavailable();
      case '42P01':
        return unavailable();
      case '57P01':
      case '57P02':
      case '57P03':
      case '53300':
        return dbDown();
      default:
        if (
          /^08/.test(e.code ?? '') ||
          ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT'].includes(e.code ?? '') ||
          (!e.code &&
            /connection terminated|connection.*(closed|ended)|connection error/i.test(
              e.message ?? '',
            ))
        )
          return dbDown();
        throw error;
    }
  }
  const guard = <T>(run: () => Promise<JustificationResult<T>>): Promise<JustificationResult<T>> =>
    run().catch((e: unknown) => mapError(e) as JustificationResult<T>);

  const loadByRequest = async (tx: SqlClient, actorId: string, requestId: string) =>
    (
      await tx.query<ReceiptRow & { payload_hash: string }>(
        `${RECEIPT_SELECT.replace('r.id,', 'r.payload_hash, r.id,')} WHERE r.received_by = $1 AND r.request_id = $2`,
        [actorId, requestId],
      )
    ).rows[0] ?? null;

  /** Decide un reintento: mismo contenido -> el mismo registro; otro contenido -> 409 auditado. */
  async function replayOrMismatch(
    tx: SqlClient,
    ctx: JustificationContext,
    existing: ReceiptRow & { payload_hash: string },
    hash: string,
    requestId: string,
  ): Promise<JustificationResult<CreateJustificationReceiptResponse>> {
    if (existing.payload_hash === hash)
      return { ok: true, value: { receipt: toDto(existing), replayed: true } };
    await audit(
      tx,
      ctx,
      'justification.idempotency_mismatch',
      { requestId, receiptId: existing.id, folio: existing.folio },
      'failure',
    );
    return fail(
      'CONFLICT',
      'Esa clave de envío ya se usó con otro alumno o fecha',
      'IDEMPOTENCY_MISMATCH',
    );
  }

  return {
    /** Registrar la recepcion de un justificante. Idempotente por `requestId`; el registro y su auditoria son UNA transaccion. */
    async create(
      ctx: JustificationContext,
      body: CreateJustificationReceiptBody,
    ): Promise<JustificationResult<CreateJustificationReceiptResponse>> {
      if (!hasAll(ctx.grants, 'justifications:create')) {
        await denied(ctx, 'justification.create');
        return fail('FORBIDDEN', 'No tiene permiso para registrar justificantes');
      }
      return guard(async () =>
        store.transaction(
          async (tx): Promise<JustificationResult<CreateJustificationReceiptResponse>> => {
            const hash = receiptHash(body.studentId, body.schoolDate);
            // Reintento: si ese envio ya se registro, se devuelve el mismo registro sin repetir nada (ni siquiera la validacion de
            // fechas: lo ya aceptado sigue siendo valido). La clave es de QUIEN la envio: la de otra cuenta no se reconoce.
            const prior = await loadByRequest(tx, ctx.actorId, body.requestId);
            if (prior) return replayOrMismatch(tx, ctx, prior, hash, body.requestId);

            const today = await todayOf(tx);
            const dow = isoWeekday(body.schoolDate);
            if (dow === 0 || dow === 6)
              return fail(
                'VALIDATION',
                'La fecha escolar debe ser de lunes a viernes',
                'NOT_SCHOOL_DAY',
              );
            if (body.schoolDate > today)
              return fail(
                'VALIDATION',
                'No se registran justificantes de fechas futuras',
                'DATE_IN_FUTURE',
              );
            const student = await tx.query(`SELECT 1 FROM students WHERE id = $1`, [
              body.studentId,
            ]);
            if (student.rows.length === 0)
              return fail('NOT_FOUND', 'No se encontró al alumno', 'STUDENT_NOT_FOUND');
            const enrollment = await tx.query<{ school_year_id: string }>(
              `SELECT e.school_year_id FROM enrollments e
                WHERE e.student_id = $1 AND e.starts_on <= $2::date AND (e.ends_on IS NULL OR e.ends_on >= $2::date)`,
              [body.studentId, body.schoolDate],
            );
            if (enrollment.rows.length === 0)
              return fail(
                'VALIDATION',
                'El alumno no estaba inscrito en esa fecha',
                'NOT_ENROLLED_ON_DATE',
              );
            const inserted = await tx.query<{ id: string }>(
              `INSERT INTO justification_receipts (student_id, school_year_id, school_date, received_by, request_id, payload_hash)
               VALUES ($1, $2, $3::date, $4, $5, $6)
               ON CONFLICT (received_by, request_id) DO NOTHING
               RETURNING id`,
              [
                body.studentId,
                enrollment.rows[0]!.school_year_id,
                body.schoolDate,
                ctx.actorId,
                body.requestId,
                hash,
              ],
            );
            if (inserted.rows.length === 0) {
              // Doble clic o envio simultaneo con la misma clave: el otro envio gano; se resuelve como un reintento.
              const winner = await loadByRequest(tx, ctx.actorId, body.requestId);
              if (!winner) return dbDown();
              return replayOrMismatch(tx, ctx, winner, hash, body.requestId);
            }
            const row = (
              await tx.query<ReceiptRow>(`${RECEIPT_SELECT} WHERE r.id = $1`, [
                inserted.rows[0]!.id,
              ])
            ).rows[0]!;
            await audit(tx, ctx, 'justification.receipt_registered', {
              receiptId: row.id,
              folio: row.folio,
              studentId: row.student_id,
              schoolDate: row.school_date,
              requestId: body.requestId,
            });
            return { ok: true, value: { receipt: toDto(row), replayed: false } };
          },
        ),
      );
    },

    /** Consulta paginada, mas reciente primero. Filtros: alumno y rango de fecha escolar. */
    async list(
      ctx: JustificationContext,
      query: ListJustificationReceiptsQuery,
    ): Promise<JustificationResult<JustificationReceiptList>> {
      if (!hasAll(ctx.grants, 'justifications:read')) {
        await denied(ctx, 'justification.list');
        return fail('FORBIDDEN', 'No tiene permiso para consultar justificantes');
      }
      return guard(async () => {
        const value = await store.transaction(async (tx) => {
          await beginSnapshot(tx);
          const params: unknown[] = [];
          const cond: string[] = ['TRUE'];
          if (query.studentId) {
            params.push(query.studentId);
            cond.push(`r.student_id = $${params.length}`);
          }
          if (query.from) {
            params.push(query.from);
            cond.push(`r.school_date >= $${params.length}::date`);
          }
          if (query.to) {
            params.push(query.to);
            cond.push(`r.school_date <= $${params.length}::date`);
          }
          const where = `WHERE ${cond.join(' AND ')}`;
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM justification_receipts r ${where}`,
            params,
          );
          params.push(query.pageSize, (query.page - 1) * query.pageSize);
          const rows = await tx.query<ReceiptRow>(
            `${RECEIPT_SELECT} ${where} ORDER BY r.received_at DESC, r.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            items: rows.rows.map(toDto),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          };
        });
        return { ok: true as const, value };
      });
    },

    /** Un registro. La consulta individual queda auditada (IDs y folio; nunca nombres). */
    async get(
      ctx: JustificationContext,
      id: string,
    ): Promise<JustificationResult<JustificationReceiptDto>> {
      if (!hasAll(ctx.grants, 'justifications:read')) {
        await denied(ctx, 'justification.get');
        return fail('FORBIDDEN', 'No tiene permiso para consultar justificantes');
      }
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          await beginSnapshot(tx);
          const row = (await tx.query<ReceiptRow>(`${RECEIPT_SELECT} WHERE r.id = $1`, [id]))
            .rows[0];
          if (!row) return null;
          await audit(tx, ctx, 'justification.receipt_viewed', {
            receiptId: row.id,
            folio: row.folio,
            studentId: row.student_id,
          });
          return toDto(row);
        });
        if (!out) return fail('NOT_FOUND', 'No se encontró el registro');
        return { ok: true as const, value: out };
      });
    },

    /**
     * Busqueda MINIMA de alumno por nombre para elegir a quien se refiere el justificante: id, nombre, codigo escolar y grupo actual
     * (solo distingue homonimos). Maximo `JUSTIFICATION_SEARCH_LIMIT` resultados; la auditoria anota solo el CONTEO, no lo escrito.
     */
    async searchStudents(
      ctx: JustificationContext,
      query: SearchJustificationStudentsQuery,
    ): Promise<JustificationResult<JustificationStudentSearch>> {
      if (
        !hasAll(ctx.grants, 'justifications:create') &&
        !hasAll(ctx.grants, 'justifications:read')
      ) {
        await denied(ctx, 'justification.search_students');
        return fail('FORBIDDEN', 'No tiene permiso para buscar alumnos');
      }
      return guard(async () => {
        const value = await store.transaction(async (tx) => {
          await beginSnapshot(tx);
          const like = `%${escapeLike(query.q)}%`;
          const rows = await tx.query<{
            id: string;
            given_names: string;
            family_name: string;
            school_code: string | null;
            group_id: string | null;
            school_year_id: string | null;
            year_name: string | null;
            grade: number | null;
            code: string | null;
            shift: Shift | null;
          }>(
            `SELECT s.id, s.given_names, s.family_name, s.school_code,
                    g.id AS group_id, g.school_year_id, y.name AS year_name, g.grade, g.code, g.shift
               FROM students s
               LEFT JOIN LATERAL (
                 SELECT a.group_id FROM student_group_assignments a JOIN enrollments e ON e.id = a.enrollment_id
                  WHERE e.student_id = s.id AND a.ends_on IS NULL ORDER BY a.starts_on DESC LIMIT 1) cg ON TRUE
               LEFT JOIN groups g ON g.id = cg.group_id
               LEFT JOIN school_years y ON y.id = g.school_year_id
              WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id)
                AND (s.family_name ILIKE $1 OR s.given_names ILIKE $1
                     OR (s.given_names || ' ' || s.family_name) ILIKE $1
                     OR (s.family_name || ' ' || s.given_names) ILIKE $1
                     OR s.school_code ILIKE $1)
              ORDER BY s.family_name, s.given_names, s.id
              LIMIT $2`,
            [like, JUSTIFICATION_SEARCH_LIMIT + 1],
          );
          const truncated = rows.rows.length > JUSTIFICATION_SEARCH_LIMIT;
          const shown = rows.rows.slice(0, JUSTIFICATION_SEARCH_LIMIT);
          await audit(tx, ctx, 'justification.students_searched', {
            resultCount: shown.length,
            truncated,
          });
          return {
            truncated,
            items: shown.map((r) => ({
              id: r.id,
              givenNames: r.given_names,
              familyName: r.family_name,
              schoolCode: r.school_code,
              currentGroup: r.group_id
                ? {
                    id: r.group_id,
                    schoolYearId: r.school_year_id!,
                    schoolYearName: r.year_name!,
                    grade: r.grade!,
                    code: r.code!,
                    shift: r.shift,
                  }
                : null,
            })),
          };
        });
        return { ok: true as const, value };
      });
    },
  };
}

export type JustificationService = ReturnType<typeof createJustificationService>;
