/**
 * Asignaciones de grupos a prefectura (logica de dominio, sin HTTP). Ver docs/architecture/modelo-asignaciones-prefectura.md.
 *
 * Autorizacion (denegar por defecto):
 *  - prefect_assignments:manage -> prefectas elegibles, crear, cerrar y revocar asignaciones (alcance `all`; solo Direccion).
 *  - prefect_assignments:read   -> `all` (Direccion): historial completo; `own` (prefectura): SUS asignaciones y SUS grupos de hoy.
 *  El actor SIEMPRE sale de la sesion revalidada: ningun parametro del cliente decide "mis grupos".
 *
 * Alcance `assigned_groups` (puerto GroupAssignments): los grupos que dan acceso HOY a una persona son los de asignaciones
 *  - no revocadas y vigentes en la fecha (inicio <= hoy <= fin, o sin fin), dentro del ciclo,
 *  - de un grupo ACTIVO,
 *  - de una cuenta escolar ACTIVA y no bloqueada que conserve el rol `prefectura` vigente, concedido ANTES de la asignacion
 *    (si el rol se revoco y se volvio a conceder, las asignaciones anteriores no reviven: hay que asignar de nuevo).
 *  Se evalua en cada peticion, dentro de la transaccion de la consulta; no se confia en que la asignacion fue valida al crearse.
 *  Si la base aun no habilita la tabla (0009/0004), el puerto devuelve el conjunto vacio (cero filas), nunca "sin filtro".
 *
 * Tres hechos distintos: cierre PROGRAMADO (`ends_on`), REVOCACION inmediata (`revoked_at`, no se reabre) e HISTORIAL (nada se borra).
 * Fechas: dias de calendario en America/Mazatlan; periodos inclusivos. Sin retroactividad: una asignacion no empieza antes de hoy.
 * La auditoria registra IDs y la longitud del motivo, nunca el texto del motivo ni datos de menores.
 */
import {
  SCHOOL_TIME_ZONE,
  type ClosePrefectAssignmentBody,
  type CreatePrefectAssignmentBody,
  type GroupRefDto,
  type ListPrefectAssignmentsQuery,
  type ListPrefectCandidatesQuery,
  type MyGroupsResponse,
  type PrefectAssignmentDto,
  type PrefectAssignmentList,
  type PrefectAssignmentStatus,
  type PrefectCandidateDto,
  type RevokePrefectAssignmentBody,
} from '@eta15/shared-contracts';
import { resolveAccess, type Grant, type GroupAssignments } from '../access-control/authorize.js';
import { recordAudit } from '../audit/audit-log.js';
import type { SessionStore, SqlClient } from '../auth/session-service.js';

export type PrefectFailure = 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'UNAVAILABLE';
export type PrefectResult<T> =
  { ok: true; value: T } | { ok: false; code: PrefectFailure; message: string; reason?: string };
const fail = (code: PrefectFailure, message: string, reason?: string) => ({
  ok: false as const,
  code,
  message,
  ...(reason ? { reason } : {}),
});

export interface PrefectContext {
  actorId: string;
  grants: readonly Grant[];
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Condicion SQL "esta asignacion da acceso hoy" ($1 = hoy). Alias: a (asignacion), u (cuenta), g (grupo), y (ciclo). */
const GRANTS_ACCESS_SQL = `
  a.revoked_at IS NULL AND a.starts_on <= $1::date AND (a.ends_on IS NULL OR a.ends_on >= $1::date)
  AND $1::date <= y.ends_on AND g.is_active
  AND u.status = 'active' AND u.account_domain = 'school' AND (u.locked_until IS NULL OR u.locked_until <= now())
  AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = a.user_id AND ur.revoked_at IS NULL AND r.key = 'prefectura' AND ur.granted_at <= a.created_at)`;

const FROM_SQL = `
  FROM prefect_group_assignments a
  JOIN users u ON u.id = a.user_id
  JOIN groups g ON g.id = a.group_id
  JOIN school_years y ON y.id = a.school_year_id`;

/** Estado administrativo ($1 = hoy). */
const STATUS_SQL = `(CASE
  WHEN a.revoked_at IS NOT NULL THEN 'revoked'
  WHEN a.ends_on IS NOT NULL AND a.ends_on < $1::date THEN 'closed'
  WHEN y.ends_on < $1::date THEN 'completed'
  WHEN a.starts_on > $1::date THEN 'upcoming'
  ELSE 'active' END)`;

/**
 * Puerto GroupAssignments ligado a una transaccion: los grupos con acceso a `userId` en `date`. Ante una base sin la tabla o sin
 * privilegios devuelve vacio (deniega) usando un SAVEPOINT para no abortar la transaccion de la consulta que lo llama.
 */
export function pgGroupAssignments(tx: SqlClient): GroupAssignments {
  return {
    async groupIdsFor(userId, date) {
      await tx.query('SAVEPOINT group_assignments');
      try {
        const r = await tx.query<{ group_id: string }>(
          `SELECT DISTINCT a.group_id ${FROM_SQL} WHERE a.user_id = $2 AND (${GRANTS_ACCESS_SQL})`,
          [date, userId],
        );
        await tx.query('RELEASE SAVEPOINT group_assignments');
        return r.rows.map((x) => x.group_id);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '42P01' && code !== '42501') throw error;
        await tx.query('ROLLBACK TO SAVEPOINT group_assignments');
        return [];
      }
    },
  };
}

interface Row {
  id: string;
  user_id: string;
  display_name: string;
  group_id: string;
  school_year_id: string;
  year_name: string;
  grade: number;
  code: string;
  shift: 'matutino' | 'vespertino' | null;
  starts_on: string;
  ends_on: string | null;
  status: PrefectAssignmentStatus;
  grants_access: boolean;
  created_at: Date;
  created_by: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason: string | null;
}

const SELECT_ROW = `
  SELECT a.id, a.user_id, u.display_name, a.group_id, a.school_year_id, y.name AS year_name, g.grade, g.code, g.shift,
         a.starts_on::text AS starts_on, a.ends_on::text AS ends_on, ${STATUS_SQL} AS status,
         (${GRANTS_ACCESS_SQL}) AS grants_access,
         a.created_at, a.created_by, a.revoked_at, a.revoked_by, a.revocation_reason
  ${FROM_SQL}`;

const groupRef = (r: Row): GroupRefDto => ({
  id: r.group_id,
  schoolYearId: r.school_year_id,
  schoolYearName: r.year_name,
  grade: r.grade,
  code: r.code,
  shift: r.shift,
});

export interface PrefectAssignmentsServiceOptions {
  store: SessionStore;
  /** "Hoy" (YYYY-MM-DD, hora de la escuela). Por defecto lo calcula la base. Inyectable en pruebas. */
  today?: () => string;
}

export function createPrefectAssignmentsService(options: PrefectAssignmentsServiceOptions) {
  const { store } = options;
  const noGroups: GroupAssignments = { groupIdsFor: async () => [] };

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
    ctx: PrefectContext,
    type: string,
    details: Record<string, unknown>,
  ) =>
    recordAudit(
      tx,
      { actorId: ctx.actorId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
      { type, outcome: 'success', details },
    );

  async function denied(ctx: PrefectContext, action: string): Promise<void> {
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

  const canManage = (ctx: PrefectContext) =>
    ctx.grants.some((g) => g.permission === 'prefect_assignments:manage' && g.scope === 'all');
  const readAccess = (ctx: PrefectContext, today: string) =>
    resolveAccess(ctx.grants, 'prefect_assignments:read', ctx.actorId, today, noGroups);

  const unavailable = () =>
    fail(
      'UNAVAILABLE',
      'Las asignaciones de prefectura aún no están habilitadas en la base de datos',
      'PREFECT_ASSIGNMENTS_UNAVAILABLE',
    );

  function mapError(error: unknown): PrefectResult<never> {
    const e = error as { code?: string; constraint?: string; message?: string };
    switch (e.code) {
      case '23P01':
        return fail(
          'CONFLICT',
          'La prefecta ya tiene ese grupo asignado en un periodo que se traslapa',
          'OVERLAPS_EXISTING',
        );
      case '23503':
        return fail('VALIDATION', 'La cuenta o el grupo no existen', 'UNKNOWN_REFERENCE');
      case '23514':
        switch (e.constraint) {
          case 'pga_user_active':
          case 'pga_user_role':
            return fail(
              'CONFLICT',
              'Solo una cuenta activa con el rol de prefectura puede recibir grupos',
              'USER_NOT_ELIGIBLE',
            );
          case 'pga_group_active':
            return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
          case 'pga_no_backdate':
            return fail('VALIDATION', 'La asignación no puede empezar antes de hoy', 'PAST_START');
          case 'pga_end_not_retroactive':
            return fail(
              'VALIDATION',
              'El cierre no puede ser anterior a hoy ni al inicio',
              'PAST_END',
            );
          case 'pga_within_year':
            return fail(
              'VALIDATION',
              'Las fechas deben caer dentro del ciclo escolar',
              'OUT_OF_YEAR',
            );
          case 'pga_already_ended':
            return fail(
              'CONFLICT',
              'La asignación ya terminó: no hay acceso que revocar',
              'ALREADY_ENDED',
            );
          case 'pga_dates_ordered':
            return fail(
              'VALIDATION',
              'La fecha de fin no puede ser anterior a la de inicio',
              'DATES_ORDER',
            );
          default:
            return fail('VALIDATION', 'Los datos no cumplen las reglas de asignaciones', 'INVALID');
        }
      case '22007':
      case '22008':
      case '22P02':
      case '23502':
        return fail('VALIDATION', 'Los datos no cumplen las reglas de asignaciones', 'INVALID');
      case '40001':
      case '40P01':
        return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente', 'CONCURRENT');
      case '42501':
        return /permission denied/i.test(e.message ?? '')
          ? unavailable()
          : fail(
              'CONFLICT',
              'Esa asignación es historia y no se modifica de ese modo',
              'IMMUTABLE',
            );
      case '42P01':
        return unavailable();
      default:
        throw error;
    }
  }
  const guard = <T>(run: () => Promise<PrefectResult<T>>): Promise<PrefectResult<T>> =>
    run().catch((e: unknown) => mapError(e) as PrefectResult<T>);

  /** La prefecta (`own`) no ve quien asigno ni el motivo de una revocacion: son datos administrativos. */
  function toDto(r: Row, admin: boolean): PrefectAssignmentDto {
    return {
      id: r.id,
      user: { id: r.user_id, displayName: r.display_name },
      group: groupRef(r),
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      status: r.status,
      grantsAccess: r.grants_access,
      createdAt: r.created_at.toISOString(),
      createdBy: admin ? r.created_by : null,
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
      revokedBy: admin ? r.revoked_by : null,
      revocationReason: admin ? r.revocation_reason : null,
    };
  }

  async function loadOne(tx: SqlClient, id: string, today: string, userId?: string, lock = false) {
    const params: unknown[] = [today, id];
    let where = 'a.id = $2';
    if (userId) {
      params.push(userId);
      where += ` AND a.user_id = $${params.length}`;
    }
    const r = await tx.query<Row>(
      `${SELECT_ROW} WHERE ${where}${lock ? ' FOR UPDATE OF a' : ''}`,
      params,
    );
    return r.rows[0] ?? null;
  }

  return {
    /** Prefectas elegibles: cuentas escolares activas con el rol `prefectura` vigente. */
    async listCandidates(
      ctx: PrefectContext,
      query: ListPrefectCandidatesQuery,
    ): Promise<PrefectResult<PrefectCandidateDto[]>> {
      if (!canManage(ctx)) {
        await denied(ctx, 'prefect_assignments.candidates');
        return fail('FORBIDDEN', 'No tiene permiso para administrar asignaciones de prefectura');
      }
      return guard(() =>
        store.transaction(async (tx) => {
          const params: unknown[] = [];
          let like = '';
          if (query.q) {
            params.push(`%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
            like = `AND (u.display_name ILIKE $1 OR u.email ILIKE $1)`;
          }
          const r = await tx.query<{ id: string; display_name: string; email: string }>(
            `SELECT u.id, u.display_name, u.email FROM users u
              WHERE u.status = 'active' AND u.account_domain = 'school' ${like}
                AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                             WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND r.key = 'prefectura')
              ORDER BY u.display_name, u.id LIMIT 100`,
            params,
          );
          return {
            ok: true as const,
            value: r.rows.map((x) => ({ id: x.id, displayName: x.display_name, email: x.email })),
          };
        }),
      );
    },

    async list(
      ctx: PrefectContext,
      query: ListPrefectAssignmentsQuery,
    ): Promise<PrefectResult<PrefectAssignmentList>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const access = await readAccess(ctx, today);
          if (access.kind === 'denied') return 'forbidden' as const;
          const params: unknown[] = [today];
          const cond: string[] = ['$1::date IS NOT NULL'];
          // `own`: SOLO las suyas; el userId del cliente no puede ampliar el alcance.
          const owner = access.kind === 'all' ? query.userId : ctx.actorId;
          if (access.kind !== 'all' && query.userId && query.userId !== ctx.actorId)
            return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
          if (owner) {
            params.push(owner);
            cond.push(`a.user_id = $${params.length}`);
          }
          if (query.schoolYearId) {
            params.push(query.schoolYearId);
            cond.push(`a.school_year_id = $${params.length}`);
          }
          if (query.groupId) {
            params.push(query.groupId);
            cond.push(`a.group_id = $${params.length}`);
          }
          if (query.status) {
            params.push(query.status);
            cond.push(`${STATUS_SQL} = $${params.length}`);
          }
          const where = `WHERE ${cond.join(' AND ')}`;
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n ${FROM_SQL} ${where}`,
            params,
          );
          params.push(query.pageSize, (query.page - 1) * query.pageSize);
          const rows = await tx.query<Row>(
            `${SELECT_ROW} ${where} ORDER BY a.starts_on DESC, a.created_at DESC, a.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            items: rows.rows.map((r) => toDto(r, access.kind === 'all')),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          };
        });
        if (out === 'forbidden') {
          await denied(ctx, 'prefect_assignments.list');
          return fail('FORBIDDEN', 'No tiene permiso para consultar asignaciones de prefectura');
        }
        return { ok: true as const, value: out };
      });
    },

    async get(ctx: PrefectContext, id: string): Promise<PrefectResult<PrefectAssignmentDto>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const access = await readAccess(ctx, today);
          if (access.kind === 'denied') return 'forbidden' as const;
          const row = await loadOne(tx, id, today, access.kind === 'all' ? undefined : ctx.actorId);
          return row ? toDto(row, access.kind === 'all') : ('missing' as const);
        });
        if (out === 'forbidden') {
          await denied(ctx, 'prefect_assignments.get');
          return fail('FORBIDDEN', 'No tiene permiso para consultar asignaciones de prefectura');
        }
        if (out === 'missing') return fail('NOT_FOUND', 'Asignación no encontrada');
        return { ok: true as const, value: out };
      });
    },

    async create(
      ctx: PrefectContext,
      body: CreatePrefectAssignmentBody,
    ): Promise<PrefectResult<PrefectAssignmentDto>> {
      if (!canManage(ctx)) {
        await denied(ctx, 'prefect_assignments.create');
        return fail('FORBIDDEN', 'No tiene permiso para administrar asignaciones de prefectura');
      }
      return guard(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          // El ciclo sale del grupo (FK compuesta): el cliente no lo elige.
          const group = (
            await tx.query<{ school_year_id: string }>(
              `SELECT school_year_id FROM groups WHERE id = $1`,
              [body.groupId],
            )
          ).rows[0];
          if (!group) return fail('VALIDATION', 'El grupo no existe', 'UNKNOWN_REFERENCE');
          const user = (
            await tx.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [body.userId])
          ).rows[0];
          if (!user) return fail('VALIDATION', 'La cuenta no existe', 'UNKNOWN_REFERENCE');
          const startsOn = body.startsOn ?? today;
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO prefect_group_assignments (user_id, school_year_id, group_id, starts_on, ends_on, created_by)
             VALUES ($1, $2, $3, $4::date, $5::date, $6) RETURNING id`,
            [
              body.userId,
              group.school_year_id,
              body.groupId,
              startsOn,
              body.endsOn ?? null,
              ctx.actorId,
            ],
          );
          const id = ins.rows[0]!.id;
          await audit(tx, ctx, 'prefect_assignment.created', {
            assignmentId: id,
            userId: body.userId,
            groupId: body.groupId,
            schoolYearId: group.school_year_id,
            startsOn,
            endsOn: body.endsOn ?? null,
          });
          return { ok: true as const, value: toDto((await loadOne(tx, id, today))!, true) };
        }),
      );
    },

    /** Cierre programado: el acceso termina al acabar `endsOn` (por defecto hoy). No extiende ni reabre. */
    async close(
      ctx: PrefectContext,
      id: string,
      body: ClosePrefectAssignmentBody,
    ): Promise<PrefectResult<PrefectAssignmentDto>> {
      if (!canManage(ctx)) {
        await denied(ctx, 'prefect_assignments.close');
        return fail('FORBIDDEN', 'No tiene permiso para administrar asignaciones de prefectura');
      }
      return guard(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const cur = await loadOne(tx, id, today, undefined, true);
          if (!cur) return fail('NOT_FOUND', 'Asignación no encontrada');
          if (cur.revoked_at)
            return fail('CONFLICT', 'La asignación está revocada: es historia', 'ALREADY_REVOKED');
          const endsOn = body.endsOn ?? today;
          if (cur.ends_on !== null && endsOn > cur.ends_on)
            return fail(
              'CONFLICT',
              'Un cierre no se extiende; crea otra asignación',
              'CANNOT_EXTEND',
            );
          if (cur.ends_on !== null && endsOn === cur.ends_on)
            return { ok: true as const, value: toDto(cur, true) }; // idempotente
          await tx.query(`UPDATE prefect_group_assignments SET ends_on = $2::date WHERE id = $1`, [
            id,
            endsOn,
          ]);
          await audit(tx, ctx, 'prefect_assignment.closed', {
            assignmentId: id,
            userId: cur.user_id,
            groupId: cur.group_id,
            endsOn,
            previousEndsOn: cur.ends_on,
          });
          return { ok: true as const, value: toDto((await loadOne(tx, id, today))!, true) };
        }),
      );
    },

    /** Revocacion inmediata: el acceso se retira en este instante; la fila queda como historia y no se reabre. */
    async revoke(
      ctx: PrefectContext,
      id: string,
      body: RevokePrefectAssignmentBody,
    ): Promise<PrefectResult<PrefectAssignmentDto>> {
      if (!canManage(ctx)) {
        await denied(ctx, 'prefect_assignments.revoke');
        return fail('FORBIDDEN', 'No tiene permiso para administrar asignaciones de prefectura');
      }
      return guard(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const cur = await loadOne(tx, id, today, undefined, true);
          if (!cur) return fail('NOT_FOUND', 'Asignación no encontrada');
          if (cur.revoked_at)
            return fail('CONFLICT', 'La asignación ya estaba revocada', 'ALREADY_REVOKED');
          await tx.query(
            `UPDATE prefect_group_assignments SET revoked_by = $2, revocation_reason = $3 WHERE id = $1`,
            [id, ctx.actorId, body.reason],
          );
          await audit(tx, ctx, 'prefect_assignment.revoked', {
            assignmentId: id,
            userId: cur.user_id,
            groupId: cur.group_id,
            reasonLength: body.reason.length,
          });
          return { ok: true as const, value: toDto((await loadOne(tx, id, today))!, true) };
        }),
      );
    },

    /** Mis grupos de hoy (para el cliente Android): solo asignaciones que dan acceso, de la persona autenticada. */
    async myGroups(ctx: PrefectContext): Promise<PrefectResult<MyGroupsResponse>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const access = await readAccess(ctx, today);
          if (access.kind === 'denied') return 'forbidden' as const;
          const rows = await tx.query<Row>(
            `${SELECT_ROW} WHERE a.user_id = $2 AND (${GRANTS_ACCESS_SQL})
             ORDER BY g.grade, g.code, a.id`,
            [today, ctx.actorId],
          );
          return {
            asOf: today,
            generatedAt: new Date().toISOString(),
            groups: rows.rows.map((r) => ({
              assignmentId: r.id,
              group: groupRef(r),
              startsOn: r.starts_on,
              endsOn: r.ends_on,
            })),
          };
        });
        if (out === 'forbidden') {
          await denied(ctx, 'prefect_assignments.my_groups');
          return fail('FORBIDDEN', 'No tiene permiso para consultar sus grupos');
        }
        return { ok: true as const, value: out };
      });
    },
  };
}

export type PrefectAssignmentsService = ReturnType<typeof createPrefectAssignmentsService>;
