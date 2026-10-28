/**
 * Asistencia diaria: UNA lista por grupo y fecha escolar (logica de dominio, sin HTTP). Ver docs/architecture/diseno-asistencia-diaria.md.
 *
 * Autorizacion (denegar por defecto; el alcance se aplica EN LA CONSULTA y se vuelve a comprobar, con bloqueo, al escribir):
 *  - attendance:capture -> abrir la lista del dia, guardar el borrador y finalizar. Solo `assigned_groups` (prefectura).
 *  - attendance:read    -> listar y consultar listas, su historial y los grupos del dia. `assigned_groups` (prefectura) o `all` (Direccion).
 *  - attendance:correct -> reservado: la correccion formal de listas finalizadas NO esta implementada (decision institucional).
 *  Un recurso fuera de alcance y uno inexistente son INDISTINGUIBLES (404). Sin ningun permiso: 403 + auditoria `authz.denied`.
 *
 * Reglas del MVP (provisionales, ver el documento de diseno):
 *  - La captura ordinaria es SOLO para el dia escolar de HOY (America/Mazatlan, calculado por el servidor), de lunes a viernes. Ninguna
 *    fecha enviada por el cliente se acepta: a lo sumo se contrasta con la del servidor. Una lista que cruza la medianoche NO se
 *    guarda ni se finaliza el dia siguiente (DAY_NOT_CURRENT): no se acepta en silencio una captura de un dia anterior.
 *  - Abrir es "obtener o crear": nunca hay dos listas; la segunda persona recibe la misma. El padron (los alumnos del grupo ese dia)
 *    queda CONGELADO al abrir; cambios posteriores del padron se informan (`discrepancies`) pero no alteran la lista.
 *  - Estados: present / absent; pending (sin marcar) solo en borrador. No se finaliza con pendientes ni sin alumnos.
 *  - Concurrencia: control optimista por `revision` de la lista + bloqueo de la fila de la lista; guardados idempotentes por `requestId`.
 *  - Una lista finalizada es historia inmutable. No hay DELETE. No se implementan justificantes, retardos de puerta ni offline.
 * La auditoria registra IDs y conteos, nunca nombres de menores.
 */
import { createHash } from 'node:crypto';
import {
  SCHOOL_TIME_ZONE,
  type AttendanceDayDetail,
  type AttendanceDayDto,
  type AttendanceDayList,
  type AttendanceEventList,
  type AttendanceMark,
  type AttendanceRecordStatus,
  type AttendanceTodayResponse,
  type FinalizeAttendanceDayBody,
  type FinalizeAttendanceDayResponse,
  type GroupRefDto,
  type ListAttendanceDaysQuery,
  type ListAttendanceEventsQuery,
  type OpenAttendanceDayBody,
  type OpenAttendanceDayResponse,
  type SaveAttendanceMarksBody,
  type SaveAttendanceMarksResponse,
} from '@eta15/shared-contracts';
import {
  allowsGroup,
  resolveAccess,
  type Access,
  type Grant,
  type GroupAssignments,
} from '../access-control/authorize.js';
import { recordAudit } from '../audit/audit-log.js';
import type { SessionStore, SqlClient } from '../auth/session-service.js';

export type AttendanceFailure =
  'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'UNAVAILABLE';
export type AttendanceResult<T> =
  { ok: true; value: T } | { ok: false; code: AttendanceFailure; message: string; reason?: string };
const fail = (code: AttendanceFailure, message: string, reason?: string) => ({
  ok: false as const,
  code,
  message,
  ...(reason ? { reason } : {}),
});
const notFound = () => fail('NOT_FOUND', 'No se encontró la lista de asistencia');

/** Quien llama: el actor sale de la sesion revalidada; los permisos con su alcance, de la base de datos. */
export interface AttendanceContext {
  actorId: string;
  grants: readonly Grant[];
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** Solo el canal movil de LECTURA: se anota en la auditoria para saber desde que dispositivo se consulto (nunca decide permisos). */
  channel?: 'mobile';
  deviceId?: string | null;
}

/**
 * Opciones de las LECTURAS. `snapshot`: una sola foto consistente de la base (ver `beginSnapshot`); ACTIVA por omision. Solo `false`
 * la desactiva (pruebas que reproducen la carrera original; ningun codigo de produccion lo usa).
 */
export interface AttendanceReadOptions {
  snapshot?: boolean;
}

export interface AttendanceServiceOptions {
  store: SessionStore;
  /** Puerto de asignaciones vigentes (alcance `assigned_groups`), ligado a la transaccion de cada consulta. */
  assignments: (tx: SqlClient) => GroupAssignments;
  /** Re-comprueba y BLOQUEA el acceso de la persona al grupo (ver `lockGroupAccess`). */
  lockGroupAccess: (
    tx: SqlClient,
    userId: string,
    groupId: string,
    date: string,
  ) => Promise<boolean>;
  /** "Hoy" (YYYY-MM-DD, hora de la escuela). Por defecto lo calcula la base. Inyectable en pruebas. */
  today?: () => string;
}

interface DayRow {
  id: string;
  group_id: string;
  school_year_id: string;
  year_name: string;
  year_starts_on: string;
  year_ends_on: string;
  grade: number;
  code: string;
  shift: 'matutino' | 'vespertino' | null;
  is_active: boolean;
  attendance_date: string;
  status: 'draft' | 'finalized';
  revision: number;
  created_by: string;
  finalized_by: string | null;
  finalized_at: Date | null;
  created_at: Date;
  total: number;
  present: number;
  absent: number;
  pending: number;
}

const DAY_SELECT = `
  SELECT d.id, d.group_id, d.school_year_id, y.name AS year_name, y.starts_on::text AS year_starts_on, y.ends_on::text AS year_ends_on,
         g.grade, g.code, g.shift, g.is_active, d.attendance_date::text AS attendance_date, d.status, d.revision,
         d.created_by, d.finalized_by, d.finalized_at, d.created_at, c.total, c.present, c.absent, c.pending
    FROM attendance_days d
    JOIN groups g ON g.id = d.group_id
    JOIN school_years y ON y.id = d.school_year_id
   CROSS JOIN LATERAL (
     SELECT count(*)::int AS total,
            (count(*) FILTER (WHERE r.status = 'present'))::int AS present,
            (count(*) FILTER (WHERE r.status = 'absent'))::int AS absent,
            (count(*) FILTER (WHERE r.status IS NULL))::int AS pending
       FROM attendance_records r WHERE r.attendance_day_id = d.id) c`;

/** Dia de la semana (0 = domingo ... 6 = sabado) de una fecha de calendario; independiente de la zona horaria del servidor. */
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const isSchoolWeekday = (iso: string) => {
  const d = weekday(iso);
  return d >= 1 && d <= 5;
};

const groupRef = (r: DayRow): GroupRefDto => ({
  id: r.group_id,
  schoolYearId: r.school_year_id,
  schoolYearName: r.year_name,
  grade: r.grade,
  code: r.code,
  shift: r.shift,
});

/** SHA-256 del contenido de un guardado (alumno -> estado, ordenado): un reintento identico produce el mismo valor. */
export function marksHash(
  marks: ReadonlyArray<{ studentId: string; status: AttendanceMark }>,
): string {
  const canonical = [...marks]
    .sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0))
    .map((m) => `${m.studentId}:${m.status}`)
    .join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createAttendanceService(options: AttendanceServiceOptions) {
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
    ctx: AttendanceContext,
    type: string,
    details: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ) =>
    recordAudit(
      tx,
      { actorId: ctx.actorId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
      {
        type,
        outcome,
        details: ctx.channel
          ? { ...details, channel: ctx.channel, deviceId: ctx.deviceId ?? null }
          : details,
      },
    );

  /**
   * Lecturas consistentes: el detalle de una lista se arma con varias consultas (cabecera y conteos, renglones, comparacion del
   * padron). En READ COMMITTED un guardado o una finalizacion que se confirme ENTRE ellas produciria una respuesta con conteos de
   * una revision y renglones de otra. REPEATABLE READ fija UNA foto para toda la transaccion (solo lecturas y la auditoria, que no
   * choca con nadie: no hay reintentos por 40001). Debe ser la PRIMERA sentencia de la transaccion. Vale para TODA lectura (portal
   * y canal movil): la carrera original del portal se reprodujo con una prueba determinista contra PostgreSQL real.
   */
  const beginSnapshot = async (tx: SqlClient, options?: AttendanceReadOptions): Promise<void> => {
    if (options?.snapshot !== false)
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  };

  async function denied(ctx: AttendanceContext, action: string): Promise<void> {
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

  const accessFor = (
    tx: SqlClient,
    ctx: AttendanceContext,
    permission: string,
    today: string,
  ): Promise<Access> =>
    resolveAccess(ctx.grants, permission, ctx.actorId, today, options.assignments(tx));

  const unavailable = () =>
    fail(
      'UNAVAILABLE',
      'La asistencia aún no está habilitada en la base de datos',
      'ATTENDANCE_UNAVAILABLE',
    );

  /** Errores de la base -> respuestas controladas. Nunca se devuelve el mensaje SQL. */
  function mapError(error: unknown): AttendanceResult<never> {
    const e = error as { code?: string; constraint?: string; message?: string };
    switch (e.code) {
      case '23514':
        switch (e.constraint) {
          case 'att_days_group_active':
            return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
          case 'att_days_within_year':
            return fail('CONFLICT', 'La fecha no cae dentro del ciclo escolar', 'OUT_OF_YEAR');
          case 'att_days_weekday':
            return fail('CONFLICT', 'No se toma lista en sábado ni domingo', 'NOT_SCHOOL_DAY');
          case 'att_days_not_future':
            return fail('VALIDATION', 'No se abren listas de fechas futuras', 'DATE_NOT_TODAY');
          case 'att_days_no_pending':
            return fail('CONFLICT', 'Faltan alumnos por marcar', 'PENDING_RECORDS');
          case 'att_days_not_empty':
            return fail('CONFLICT', 'El grupo no tiene alumnos en esa fecha', 'EMPTY_ROSTER');
          case 'att_records_in_group':
          case 'att_records_enrollment_current':
            return fail(
              'CONFLICT',
              'El padrón del grupo cambió mientras se abría la lista; intente de nuevo',
              'ROSTER_CHANGED',
            );
          default:
            return fail('VALIDATION', 'Los datos no cumplen las reglas de asistencia', 'INVALID');
        }
      case '23505':
        return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente', 'CONCURRENT');
      case '23503':
      case '22P02':
      case '22007':
      case '22008':
      case '23502':
        return fail('VALIDATION', 'Los datos no cumplen las reglas de asistencia', 'INVALID');
      case '40001':
      case '40P01':
        return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente', 'CONCURRENT');
      case '42501':
        return /permission denied/i.test(e.message ?? '')
          ? unavailable()
          : fail('CONFLICT', 'Una lista finalizada no se modifica', 'DAY_FINALIZED');
      case '42P01':
        return unavailable();
      // La base dejo de responder (conexion cortada, apagado, demasiadas conexiones): NO se aplico nada de esta transaccion y el
      // cliente puede reintentar la MISMA operacion (el `requestId` la hace idempotente). 503 la distingue de un conflicto definitivo.
      case '57P01':
      case '57P02':
      case '57P03':
      case '53300':
        return fail(
          'UNAVAILABLE',
          'La base de datos no está disponible; reintente',
          'DATABASE_UNAVAILABLE',
        );
      default:
        // Errores de conexion sin codigo SQLSTATE (la base corto la conexion en medio de la transaccion).
        if (
          /^08/.test(e.code ?? '') ||
          ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT'].includes(e.code ?? '') ||
          (!e.code &&
            /connection terminated|connection.*(closed|ended)|connection error/i.test(
              e.message ?? '',
            ))
        )
          return fail(
            'UNAVAILABLE',
            'La base de datos no está disponible; reintente',
            'DATABASE_UNAVAILABLE',
          );
        throw error;
    }
  }
  const guard = <T>(run: () => Promise<AttendanceResult<T>>): Promise<AttendanceResult<T>> =>
    run().catch((e: unknown) => mapError(e) as AttendanceResult<T>);

  const toDayDto = (r: DayRow, admin: boolean): AttendanceDayDto => ({
    id: r.id,
    group: groupRef(r),
    attendanceDate: r.attendance_date,
    status: r.status,
    revision: r.revision,
    counts: { total: r.total, present: r.present, absent: r.absent, pending: r.pending },
    createdAt: r.created_at.toISOString(),
    finalizedAt: r.finalized_at ? r.finalized_at.toISOString() : null,
    createdBy: admin ? r.created_by : null,
    finalizedBy: admin ? r.finalized_by : null,
  });

  const loadDayRow = async (tx: SqlClient, id: string): Promise<DayRow | null> =>
    (await tx.query<DayRow>(`${DAY_SELECT} WHERE d.id = $1`, [id])).rows[0] ?? null;

  /** Bloquea la lista (la serializa frente a guardados, finalizaciones y bajas de renglones simultaneos). */
  const lockDay = async (tx: SqlClient, id: string): Promise<boolean> =>
    (await tx.query(`SELECT d.id FROM attendance_days d WHERE d.id = $1 FOR UPDATE`, [id])).rows
      .length > 0;

  /** ¿Puede esta persona CAPTURAR en este grupo ahora? (permiso + alcance + lista de hoy en borrador + grupo activo). */
  async function canCaptureNow(
    tx: SqlClient,
    ctx: AttendanceContext,
    day: DayRow,
    today: string,
  ): Promise<boolean> {
    if (day.status !== 'draft' || day.attendance_date !== today || !day.is_active) return false;
    if (!ctx.grants.some((g) => g.permission === 'attendance:capture')) return false;
    const capture = await accessFor(tx, ctx, 'attendance:capture', today);
    return allowsGroup(capture, day.group_id);
  }

  /** Detalle con renglones y comparacion informativa del padron congelado frente al actual. */
  async function buildDetail(
    tx: SqlClient,
    ctx: AttendanceContext,
    day: DayRow,
    today: string,
    admin: boolean,
  ): Promise<AttendanceDayDetail> {
    const records = await tx.query<{
      student_id: string;
      given_names: string;
      family_name: string;
      status: 'present' | 'absent' | null;
      marked_at: Date | null;
    }>(
      `SELECT s.id AS student_id, s.given_names, s.family_name, r.status, r.marked_at
         FROM attendance_records r
         JOIN enrollments e ON e.id = r.enrollment_id
         JOIN students s ON s.id = e.student_id
        WHERE r.attendance_day_id = $1
        ORDER BY s.family_name, s.given_names, s.id`,
      [day.id],
    );
    // Padron actual del grupo en la fecha de la lista (misma regla que al abrirla) frente al congelado.
    const diff = await tx.query<{ added: number; removed: number }>(
      `SELECT
         (SELECT count(*)::int FROM student_group_assignments a
            JOIN enrollments e ON e.id = a.enrollment_id
            JOIN students s ON s.id = e.student_id
           WHERE a.group_id = $2 AND a.school_year_id = $3 AND a.starts_on <= $4::date AND (a.ends_on IS NULL OR a.ends_on >= $4::date)
             AND e.starts_on <= $4::date AND (e.ends_on IS NULL OR e.ends_on >= $4::date) AND s.is_active
             AND NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.attendance_day_id = $1 AND r.enrollment_id = e.id)) AS added,
         (SELECT count(*)::int FROM attendance_records r
           WHERE r.attendance_day_id = $1
             AND NOT EXISTS (SELECT 1 FROM student_group_assignments a
                               JOIN enrollments e ON e.id = a.enrollment_id
                               JOIN students s ON s.id = e.student_id
                              WHERE e.id = r.enrollment_id AND a.group_id = $2 AND a.starts_on <= $4::date
                                AND (a.ends_on IS NULL OR a.ends_on >= $4::date)
                                AND e.starts_on <= $4::date AND (e.ends_on IS NULL OR e.ends_on >= $4::date) AND s.is_active)) AS removed`,
      [day.id, day.group_id, day.school_year_id, day.attendance_date],
    );
    const editable = await canCaptureNow(tx, ctx, day, today);
    return {
      ...toDayDto(day, admin),
      schoolToday: today,
      editable,
      records: records.rows.map((r) => ({
        studentId: r.student_id,
        givenNames: r.given_names,
        familyName: r.family_name,
        status: (r.status ?? 'pending') as AttendanceRecordStatus,
        markedAt: r.marked_at ? r.marked_at.toISOString() : null,
      })),
      discrepancies: {
        addedToRoster: diff.rows[0]?.added ?? 0,
        removedFromRoster: diff.rows[0]?.removed ?? 0,
      },
    };
  }

  /** Comprobaciones comunes de las operaciones de ESCRITURA sobre una lista existente. Devuelve la fila bloqueada o un fallo. */
  async function lockForWrite(
    tx: SqlClient,
    ctx: AttendanceContext,
    dayId: string,
    today: string,
    access: Access,
  ): Promise<{ day: DayRow } | { failure: AttendanceResult<never> }> {
    if (!(await lockDay(tx, dayId))) return { failure: notFound() };
    const day = await loadDayRow(tx, dayId);
    if (!day || !allowsGroup(access, day.group_id)) return { failure: notFound() };
    // Re-comprobacion CON bloqueo del acceso: una revocacion simultanea espera o ya se vio aqui.
    if (!(await options.lockGroupAccess(tx, ctx.actorId, day.group_id, today)))
      return { failure: notFound() };
    return { day };
  }

  return {
    /** Los grupos de hoy de quien consulta, con el estado de su lista. Direccion (`all`): todos los grupos activos del ciclo. */
    async today(
      ctx: AttendanceContext,
      readOptions?: AttendanceReadOptions,
    ): Promise<AttendanceResult<AttendanceTodayResponse>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          await beginSnapshot(tx, readOptions);
          const today = await todayOf(tx);
          const read = await accessFor(tx, ctx, 'attendance:read', today);
          if (read.kind === 'denied') return 'forbidden' as const;
          const params: unknown[] = [today];
          let scope = '';
          if (read.kind === 'groups') {
            if (read.groupIds.size === 0) {
              return {
                schoolToday: today,
                isSchoolDay: isSchoolWeekday(today),
                generatedAt: new Date().toISOString(),
                groups: [],
              };
            }
            params.push([...read.groupIds].sort());
            scope = `AND g.id = ANY($2::uuid[])`;
          } else if (read.kind !== 'all') {
            return 'forbidden' as const;
          }
          const capture = ctx.grants.some((g) => g.permission === 'attendance:capture')
            ? await accessFor(tx, ctx, 'attendance:capture', today)
            : ({ kind: 'denied' } as Access);
          const rows = await tx.query<DayRow & { has_day: boolean }>(
            `SELECT g.id AS group_id, g.school_year_id, y.name AS year_name, y.starts_on::text AS year_starts_on,
                    y.ends_on::text AS year_ends_on, g.grade, g.code, g.shift, g.is_active,
                    (d.id IS NOT NULL) AS has_day, d.id, d.attendance_date::text AS attendance_date, d.status, d.revision,
                    d.created_by, d.finalized_by, d.finalized_at, d.created_at,
                    coalesce(c.total, 0) AS total, coalesce(c.present, 0) AS present, coalesce(c.absent, 0) AS absent,
                    coalesce(c.pending, 0) AS pending
               FROM groups g
               JOIN school_years y ON y.id = g.school_year_id
               LEFT JOIN attendance_days d ON d.group_id = g.id AND d.attendance_date = $1::date
               LEFT JOIN LATERAL (
                 SELECT count(*)::int AS total,
                        (count(*) FILTER (WHERE r.status = 'present'))::int AS present,
                        (count(*) FILTER (WHERE r.status = 'absent'))::int AS absent,
                        (count(*) FILTER (WHERE r.status IS NULL))::int AS pending
                   FROM attendance_records r WHERE r.attendance_day_id = d.id) c ON true
              WHERE g.is_active AND y.starts_on <= $1::date AND y.ends_on >= $1::date ${scope}
              ORDER BY g.grade, g.code, g.id`,
            params,
          );
          return {
            schoolToday: today,
            isSchoolDay: isSchoolWeekday(today),
            generatedAt: new Date().toISOString(),
            groups: rows.rows.map((r) => ({
              group: groupRef(r),
              canCapture: allowsGroup(capture, r.group_id),
              day: r.has_day ? toDayDto(r, read.kind === 'all') : null,
            })),
          };
        });
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.today');
          return fail('FORBIDDEN', 'No tiene permiso para consultar la asistencia');
        }
        return { ok: true as const, value: out };
      });
    },

    /** Obtener o crear la lista de HOY del grupo (idempotente): la misma lista para toda persona autorizada. */
    async open(
      ctx: AttendanceContext,
      body: OpenAttendanceDayBody,
    ): Promise<AttendanceResult<OpenAttendanceDayResponse>> {
      return guard(async () => {
        const out = await store.transaction(
          async (tx): Promise<AttendanceResult<OpenAttendanceDayResponse> | 'forbidden'> => {
            const today = await todayOf(tx);
            const access = await accessFor(tx, ctx, 'attendance:capture', today);
            if (access.kind === 'denied') return 'forbidden';
            // Fuera de alcance == inexistente (404), ANTES de cualquier otra validacion que revele algo del grupo.
            if (!allowsGroup(access, body.groupId)) return notFound();
            const group = (
              await tx.query<{
                is_active: boolean;
                school_year_id: string;
                starts_on: string;
                ends_on: string;
              }>(
                `SELECT g.is_active, g.school_year_id, y.starts_on::text AS starts_on, y.ends_on::text AS ends_on
                   FROM groups g JOIN school_years y ON y.id = g.school_year_id WHERE g.id = $1`,
                [body.groupId],
              )
            ).rows[0];
            if (!group) return notFound();
            // El cliente no decide el dia: si manda uno, debe ser el de hoy segun el servidor.
            if (body.attendanceDate && body.attendanceDate !== today)
              return fail(
                'VALIDATION',
                'La fecha de la lista debe ser el día escolar de hoy',
                'DATE_NOT_TODAY',
              );
            const existing = async () =>
              (
                await tx.query<{ id: string }>(
                  `SELECT id FROM attendance_days WHERE group_id = $1 AND attendance_date = $2::date`,
                  [body.groupId, today],
                )
              ).rows[0];
            const found = await existing();
            if (found) {
              if (!(await options.lockGroupAccess(tx, ctx.actorId, body.groupId, today)))
                return notFound();
              const day = (await loadDayRow(tx, found.id))!;
              return {
                ok: true as const,
                value: { day: await buildDetail(tx, ctx, day, today, false), created: false },
              };
            }
            if (!isSchoolWeekday(today))
              return fail('CONFLICT', 'No se toma lista en sábado ni domingo', 'NOT_SCHOOL_DAY');
            if (!group.is_active)
              return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
            if (today < group.starts_on || today > group.ends_on)
              return fail(
                'CONFLICT',
                'Hoy no está dentro del ciclo escolar del grupo',
                'OUT_OF_YEAR',
              );
            if (!(await options.lockGroupAccess(tx, ctx.actorId, body.groupId, today)))
              return notFound();
            // Padron del dia: alumnos activos con matricula y asignacion de grupo vigentes HOY en este grupo. Se bloquean
            // (FOR SHARE) para que una baja o un traslado simultaneo espere a que termine la apertura (y viceversa).
            const roster = await tx.query<{ enrollment_id: string; assignment_id: string }>(
              `SELECT e.id AS enrollment_id, a.id AS assignment_id
                 FROM student_group_assignments a
                 JOIN enrollments e ON e.id = a.enrollment_id
                 JOIN students s ON s.id = e.student_id
                WHERE a.group_id = $1 AND a.school_year_id = $2 AND a.starts_on <= $3::date
                  AND (a.ends_on IS NULL OR a.ends_on >= $3::date)
                  AND e.starts_on <= $3::date AND (e.ends_on IS NULL OR e.ends_on >= $3::date) AND s.is_active
                ORDER BY e.id
                FOR SHARE OF a, e`,
              [body.groupId, group.school_year_id, today],
            );
            if (roster.rows.length === 0)
              return fail(
                'CONFLICT',
                'El grupo no tiene alumnos inscritos hoy: no se abre una lista vacía',
                'EMPTY_ROSTER',
              );
            const ins = await tx.query<{ id: string }>(
              `INSERT INTO attendance_days (school_year_id, group_id, attendance_date, created_by)
               VALUES ($1, $2, $3::date, $4)
               ON CONFLICT ON CONSTRAINT att_days_group_date_key DO NOTHING
               RETURNING id`,
              [group.school_year_id, body.groupId, today, ctx.actorId],
            );
            let created = false;
            let dayId: string;
            if (ins.rows[0]) {
              created = true;
              dayId = ins.rows[0].id;
              await tx.query(
                `INSERT INTO attendance_records (attendance_day_id, school_year_id, enrollment_id, group_assignment_id)
                 SELECT $1::uuid, $2::uuid, v.enrollment_id, v.assignment_id
                   FROM unnest($3::uuid[], $4::uuid[]) AS v(enrollment_id, assignment_id)`,
                [
                  dayId,
                  group.school_year_id,
                  roster.rows.map((r) => r.enrollment_id),
                  roster.rows.map((r) => r.assignment_id),
                ],
              );
              await tx.query(
                `INSERT INTO attendance_events (attendance_day_id, event_type, actor_id, revision_after)
                 VALUES ($1, 'day_opened', $2, 1)`,
                [dayId, ctx.actorId],
              );
              await audit(tx, ctx, 'attendance.day_opened', {
                dayId,
                groupId: body.groupId,
                attendanceDate: today,
                students: roster.rows.length,
              });
            } else {
              // Otra persona la abrio al mismo tiempo (esperamos su COMMIT): es la MISMA lista.
              dayId = (await existing())!.id;
            }
            const day = (await loadDayRow(tx, dayId))!;
            return {
              ok: true as const,
              value: { day: await buildDetail(tx, ctx, day, today, false), created },
            };
          },
        );
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.open');
          return fail('FORBIDDEN', 'No tiene permiso para capturar asistencia');
        }
        return out;
      });
    },

    async list(
      ctx: AttendanceContext,
      query: ListAttendanceDaysQuery,
      readOptions?: AttendanceReadOptions,
    ): Promise<AttendanceResult<AttendanceDayList>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          await beginSnapshot(tx, readOptions);
          const today = await todayOf(tx);
          const access = await accessFor(tx, ctx, 'attendance:read', today);
          if (access.kind === 'denied' || access.kind === 'own') return 'forbidden' as const;
          const empty = { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
          const params: unknown[] = [];
          const cond: string[] = ['TRUE'];
          if (access.kind === 'groups') {
            if (access.groupIds.size === 0) return empty;
            params.push([...access.groupIds].sort());
            cond.push(`d.group_id = ANY($${params.length}::uuid[])`);
          }
          if (query.groupId) {
            params.push(query.groupId);
            cond.push(`d.group_id = $${params.length}`);
          }
          if (query.from) {
            params.push(query.from);
            cond.push(`d.attendance_date >= $${params.length}::date`);
          }
          if (query.to) {
            params.push(query.to);
            cond.push(`d.attendance_date <= $${params.length}::date`);
          }
          if (query.status) {
            params.push(query.status);
            cond.push(`d.status = $${params.length}`);
          }
          const where = `WHERE ${cond.join(' AND ')}`;
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM attendance_days d ${where}`,
            params,
          );
          params.push(query.pageSize, (query.page - 1) * query.pageSize);
          const rows = await tx.query<DayRow>(
            `${DAY_SELECT} ${where} ORDER BY d.attendance_date DESC, g.grade, g.code, d.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return {
            items: rows.rows.map((r) => toDayDto(r, access.kind === 'all')),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          };
        });
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.list');
          return fail('FORBIDDEN', 'No tiene permiso para consultar la asistencia');
        }
        return { ok: true as const, value: out };
      });
    },

    async get(
      ctx: AttendanceContext,
      id: string,
      readOptions?: AttendanceReadOptions,
    ): Promise<AttendanceResult<AttendanceDayDetail>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          await beginSnapshot(tx, readOptions);
          const today = await todayOf(tx);
          const access = await accessFor(tx, ctx, 'attendance:read', today);
          if (access.kind === 'denied' || access.kind === 'own') return 'forbidden' as const;
          const day = await loadDayRow(tx, id);
          if (!day || !allowsGroup(access, day.group_id)) return 'missing' as const;
          await audit(tx, ctx, 'attendance.day_viewed', { dayId: day.id, groupId: day.group_id });
          return buildDetail(tx, ctx, day, today, access.kind === 'all');
        });
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.get');
          return fail('FORBIDDEN', 'No tiene permiso para consultar la asistencia');
        }
        if (out === 'missing') return notFound();
        return { ok: true as const, value: out };
      });
    },

    /** Guardar cambios del borrador. Idempotente por `requestId`; control optimista por `expectedRevision`. */
    async saveMarks(
      ctx: AttendanceContext,
      dayId: string,
      body: SaveAttendanceMarksBody,
    ): Promise<AttendanceResult<SaveAttendanceMarksResponse>> {
      return guard(async () => {
        const out = await store.transaction(
          async (tx): Promise<AttendanceResult<SaveAttendanceMarksResponse> | 'forbidden'> => {
            const today = await todayOf(tx);
            const access = await accessFor(tx, ctx, 'attendance:capture', today);
            if (access.kind === 'denied') return 'forbidden';
            const locked = await lockForWrite(tx, ctx, dayId, today, access);
            if ('failure' in locked) return locked.failure;
            const { day } = locked;
            const hash = marksHash(body.marks);
            // Reintento: si ese guardado ya se aplico, se devuelve el estado vigente sin repetir nada (aunque la
            // revision haya avanzado o la lista ya este finalizada); con otro contenido, es un error de uso.
            // El recibo es durable: un guardado con cambios deja un evento por renglon cambiado y uno SIN cambios deja un evento de
            // confirmacion (old = new, ver mas abajo); ambos llevan `request_id` y `payload_hash`. El recibo es de QUIEN lo envio:
            // el mismo `requestId` de otra cuenta no se reconoce (no se filtra que existe) y se rechaza como uso incorrecto.
            const prior = await tx.query<{ payload_hash: string; actor_id: string }>(
              `SELECT payload_hash, actor_id FROM attendance_events
                WHERE attendance_day_id = $1 AND request_id = $2 AND event_type = 'mark_changed' LIMIT 1`,
              [dayId, body.requestId],
            );
            if (prior.rows[0]) {
              if (prior.rows[0].payload_hash !== hash || prior.rows[0].actor_id !== ctx.actorId)
                return fail(
                  'CONFLICT',
                  'Ese identificador de guardado ya se usó con otro contenido',
                  'IDEMPOTENCY_MISMATCH',
                );
              await audit(tx, ctx, 'attendance.marks_replayed', {
                dayId,
                groupId: day.group_id,
                requestId: body.requestId,
                revision: day.revision,
              });
              return {
                ok: true as const,
                value: {
                  day: await buildDetail(tx, ctx, day, today, false),
                  changed: 0,
                  replayed: true,
                },
              };
            }
            if (day.status === 'finalized')
              return fail('CONFLICT', 'La lista ya fue finalizada', 'DAY_FINALIZED');
            if (day.attendance_date !== today)
              return fail(
                'CONFLICT',
                'La fecha escolar cambió: esta lista ya no se puede modificar',
                'DAY_NOT_CURRENT',
              );
            // Serializa con la desactivacion simultanea del grupo.
            const g = (
              await tx.query<{ is_active: boolean }>(
                `SELECT is_active FROM groups WHERE id = $1 FOR SHARE`,
                [day.group_id],
              )
            ).rows[0];
            if (!g?.is_active) return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
            if (body.expectedRevision !== day.revision) {
              await audit(
                tx,
                ctx,
                'attendance.save_conflict',
                {
                  dayId,
                  groupId: day.group_id,
                  expectedRevision: body.expectedRevision,
                  currentRevision: day.revision,
                },
                'failure',
              );
              return fail(
                'CONFLICT',
                'Otra persona modificó la lista; recarga para ver los cambios',
                'REVISION_CONFLICT',
              );
            }
            // Solo alumnos del padron congelado de ESTA lista (un id ajeno no pertenece a ella).
            const recs = await tx.query<{ id: string; student_id: string; status: string | null }>(
              `SELECT r.id, e.student_id, r.status
                 FROM attendance_records r JOIN enrollments e ON e.id = r.enrollment_id
                WHERE r.attendance_day_id = $1 AND e.student_id = ANY($2::uuid[])
                ORDER BY r.id
                FOR UPDATE OF r`,
              [dayId, body.marks.map((m) => m.studentId)],
            );
            const byStudent = new Map(recs.rows.map((r) => [r.student_id, r]));
            if (body.marks.some((m) => !byStudent.has(m.studentId)))
              return fail(
                'VALIDATION',
                'Algún alumno no pertenece a esta lista',
                'STUDENT_NOT_IN_LIST',
              );
            const changes = body.marks
              .map((m) => ({ rec: byStudent.get(m.studentId)!, status: m.status }))
              .filter((c) => c.rec.status !== c.status);
            if (changes.length === 0) {
              // Guardado SIN cambios: no hay marcas que cambiar ni `revision` que subir, pero la operacion se acepto y debe poder
              // reconocerse al reintentarla. Recibo durable con el esquema actual (sin migracion): UN evento `mark_changed` de
              // CONFIRMACION sobre el primer alumno (orden canonico por id) con `old_status = new_status` y `revision_after` igual a la
              // revision vigente. No es un cambio de asistencia: el historial lo distingue por old = new.
              const first = [...body.marks].sort((a, b) =>
                a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0,
              )[0]!;
              const rec = byStudent.get(first.studentId)!;
              await tx.query(
                `INSERT INTO attendance_events (attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash,
                                                old_status, new_status, revision_after)
                 VALUES ($1, $2, 'mark_changed', $3, $4, $5, $6, $6, $7)`,
                [dayId, rec.id, ctx.actorId, body.requestId, hash, rec.status, day.revision],
              );
              await audit(tx, ctx, 'attendance.marks_unchanged', {
                dayId,
                groupId: day.group_id,
                requestId: body.requestId,
                revision: day.revision,
              });
              return {
                ok: true as const,
                value: {
                  day: await buildDetail(tx, ctx, day, today, false),
                  changed: 0,
                  replayed: false,
                },
              };
            }
            await tx.query(
              `UPDATE attendance_records r SET status = v.status, marked_by = $3
                 FROM unnest($1::uuid[], $2::text[]) AS v(id, status)
                WHERE r.id = v.id`,
              [changes.map((c) => c.rec.id), changes.map((c) => c.status), ctx.actorId],
            );
            const bumped = await tx.query<{ revision: number }>(
              `UPDATE attendance_days SET revision = revision + 1 WHERE id = $1 RETURNING revision`,
              [dayId],
            );
            const revision = bumped.rows[0]!.revision;
            await tx.query(
              `INSERT INTO attendance_events (attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash,
                                              old_status, new_status, revision_after)
               SELECT $1::uuid, v.record_id, 'mark_changed', $2::uuid, $3::uuid, $4::text, nullif(v.old_status, ''), v.new_status, $5::int
                 FROM unnest($6::uuid[], $7::text[], $8::text[]) AS v(record_id, old_status, new_status)`,
              [
                dayId,
                ctx.actorId,
                body.requestId,
                hash,
                revision,
                changes.map((c) => c.rec.id),
                changes.map((c) => c.rec.status ?? ''),
                changes.map((c) => c.status),
              ],
            );
            await audit(tx, ctx, 'attendance.marks_saved', {
              dayId,
              groupId: day.group_id,
              requestId: body.requestId,
              changed: changes.length,
              revision,
            });
            const fresh = (await loadDayRow(tx, dayId))!;
            return {
              ok: true as const,
              value: {
                day: await buildDetail(tx, ctx, fresh, today, false),
                changed: changes.length,
                replayed: false,
              },
            };
          },
        );
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.save');
          return fail('FORBIDDEN', 'No tiene permiso para capturar asistencia');
        }
        return out;
      });
    },

    /** Finalizar: atomico y seguro ante carreras. Repetirlo (o competir) devuelve el mismo resultado sin escribir de nuevo. */
    async finalize(
      ctx: AttendanceContext,
      dayId: string,
      body: FinalizeAttendanceDayBody,
    ): Promise<AttendanceResult<FinalizeAttendanceDayResponse>> {
      return guard(async () => {
        const out = await store.transaction(
          async (tx): Promise<AttendanceResult<FinalizeAttendanceDayResponse> | 'forbidden'> => {
            const today = await todayOf(tx);
            const access = await accessFor(tx, ctx, 'attendance:capture', today);
            if (access.kind === 'denied') return 'forbidden';
            const locked = await lockForWrite(tx, ctx, dayId, today, access);
            if ('failure' in locked) return locked.failure;
            const { day } = locked;
            if (day.status === 'finalized')
              return {
                ok: true as const,
                value: {
                  day: await buildDetail(tx, ctx, day, today, false),
                  alreadyFinalized: true,
                },
              };
            if (day.attendance_date !== today)
              return fail(
                'CONFLICT',
                'La fecha escolar cambió: esta lista ya no se puede finalizar',
                'DAY_NOT_CURRENT',
              );
            const g = (
              await tx.query<{ is_active: boolean }>(
                `SELECT is_active FROM groups WHERE id = $1 FOR SHARE`,
                [day.group_id],
              )
            ).rows[0];
            if (!g?.is_active) return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
            if (body.expectedRevision !== day.revision) {
              await audit(
                tx,
                ctx,
                'attendance.finalize_conflict',
                {
                  dayId,
                  groupId: day.group_id,
                  expectedRevision: body.expectedRevision,
                  currentRevision: day.revision,
                },
                'failure',
              );
              return fail(
                'CONFLICT',
                'Otra persona modificó la lista; recarga para ver los cambios',
                'REVISION_CONFLICT',
              );
            }
            if (day.total === 0)
              return fail('CONFLICT', 'La lista no tiene alumnos', 'EMPTY_ROSTER');
            if (day.pending > 0)
              return fail(
                'CONFLICT',
                day.pending === 1
                  ? 'Falta 1 alumno por marcar'
                  : `Faltan ${day.pending} alumnos por marcar`,
                'PENDING_RECORDS',
              );
            const upd = await tx.query<{ revision: number }>(
              `UPDATE attendance_days SET status = 'finalized', finalized_by = $2, revision = revision + 1
                WHERE id = $1 RETURNING revision`,
              [dayId, ctx.actorId],
            );
            const revision = upd.rows[0]!.revision;
            await tx.query(
              `INSERT INTO attendance_events (attendance_day_id, event_type, actor_id, revision_after)
               VALUES ($1, 'day_finalized', $2, $3)`,
              [dayId, ctx.actorId, revision],
            );
            await audit(tx, ctx, 'attendance.day_finalized', {
              dayId,
              groupId: day.group_id,
              attendanceDate: day.attendance_date,
              present: day.present,
              absent: day.absent,
              revision,
            });
            const fresh = (await loadDayRow(tx, dayId))!;
            return {
              ok: true as const,
              value: {
                day: await buildDetail(tx, ctx, fresh, today, false),
                alreadyFinalized: false,
              },
            };
          },
        );
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.finalize');
          return fail('FORBIDDEN', 'No tiene permiso para capturar asistencia');
        }
        return out;
      });
    },

    /** Historial de una lista: IDs y estados, nunca nombres. El actor solo se revela a quien supervisa (`all`). */
    async events(
      ctx: AttendanceContext,
      dayId: string,
      query: ListAttendanceEventsQuery,
    ): Promise<AttendanceResult<AttendanceEventList>> {
      return guard(async () => {
        const out = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const access = await accessFor(tx, ctx, 'attendance:read', today);
          if (access.kind === 'denied' || access.kind === 'own') return 'forbidden' as const;
          const day = await loadDayRow(tx, dayId);
          if (!day || !allowsGroup(access, day.group_id)) return 'missing' as const;
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM attendance_events WHERE attendance_day_id = $1`,
            [dayId],
          );
          const rows = await tx.query<{
            id: string;
            event_type: 'day_opened' | 'mark_changed' | 'day_finalized';
            student_id: string | null;
            old_status: 'present' | 'absent' | null;
            new_status: 'present' | 'absent' | null;
            revision_after: number;
            occurred_at: Date;
            actor_id: string;
          }>(
            `SELECT ev.id, ev.event_type, e.student_id, ev.old_status, ev.new_status, ev.revision_after, ev.occurred_at, ev.actor_id
               FROM attendance_events ev
               LEFT JOIN attendance_records r ON r.id = ev.record_id
               LEFT JOIN enrollments e ON e.id = r.enrollment_id
              WHERE ev.attendance_day_id = $1
              ORDER BY ev.occurred_at, ev.id
              LIMIT $2 OFFSET $3`,
            [dayId, query.pageSize, (query.page - 1) * query.pageSize],
          );
          return {
            items: rows.rows.map((r) => ({
              id: r.id,
              eventType: r.event_type,
              studentId: r.student_id,
              oldStatus:
                r.event_type === 'mark_changed'
                  ? ((r.old_status ?? 'pending') as AttendanceRecordStatus)
                  : null,
              newStatus: r.new_status,
              revisionAfter: r.revision_after,
              occurredAt: r.occurred_at.toISOString(),
              actorId: access.kind === 'all' ? r.actor_id : null,
            })),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          };
        });
        if (out === 'forbidden') {
          await denied(ctx, 'attendance.events');
          return fail('FORBIDDEN', 'No tiene permiso para consultar la asistencia');
        }
        if (out === 'missing') return notFound();
        return { ok: true as const, value: out };
      });
    },
  };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
