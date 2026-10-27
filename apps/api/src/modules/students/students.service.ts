/**
 * Alumnos, matriculas por ciclo e historial de grupo (logica de dominio, sin HTTP). Ver docs/architecture/modelo-alumnos-matriculas.md.
 *
 * Autorizacion (denegar por defecto; el alcance se aplica EN LA CONSULTA, nunca despues):
 *  - students:read_basic  -> listar/consultar alumnos (nombre, codigo, estado, grupo vigente). Alcance `all`, o `assigned_groups`
 *                            (hoy sin asignaciones reales de prefectura: el conjunto vacio significa CERO filas).
 *  - students:read        -> expediente: historial de matriculas y de grupos, y sellos de tiempo. Cada campo se proyecta con
 *                            `projectFields` segun el permiso y, ademas, el alumno debe estar dentro del alcance de `students:read`.
 *  - students:manage      -> alta, correccion, desactivacion y reactivacion de alumnos (alcance `all`).
 *  - enrollments:manage   -> inscribir, baja, asignar grupo y trasladar (alcance `all`).
 *  Un recurso fuera de alcance y uno inexistente son INDISTINGUIBLES (404). Sin ningun permiso: 403 + auditoria `authz.denied`.
 *
 * Fechas: dias de calendario en America/Mazatlan; periodos INCLUSIVOS (`ends_on` es el ultimo dia). Un traslado con fecha
 * efectiva E cierra la asignacion anterior en E-1 y abre la nueva en E; como no hay horas, dos grupos no coinciden el mismo dia
 * (traslado el mismo dia del inicio de la asignacion vigente => SAME_DAY). Los ciclos terminados son historial inmutable.
 * La auditoria registra IDs y nombres de campos, nunca nombres de menores ni el texto de las busquedas.
 */
import {
  SCHOOL_TIME_ZONE,
  type AssignGroupBody,
  type CreateStudentBody,
  type EnrollBody,
  type EnrollmentDto,
  type EnrollmentStatus,
  type GroupAssignmentDto,
  type GroupRefDto,
  type ListStudentsQuery,
  type StudentDto,
  type StudentList,
  type TransferBody,
  type UpdateStudentBody,
  type WithdrawBody,
} from '@eta15/shared-contracts';
import {
  resolveAccess,
  type Access,
  type Grant,
  type GroupAssignments,
} from '../access-control/authorize.js';
import {
  projectFields,
  type FieldSpec,
  type Principal,
} from '../access-control/resource-authorization.js';
import { recordAudit } from '../audit/audit-log.js';
import type { SessionStore, SqlClient } from '../auth/session-service.js';

export type StudentsFailure =
  'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'HISTORICAL' | 'UNAVAILABLE';
export type StudentsResult<T> =
  { ok: true; value: T } | { ok: false; code: StudentsFailure; message: string; reason?: string };
const fail = (code: StudentsFailure, message: string, reason?: string) => ({
  ok: false as const,
  code,
  message,
  ...(reason ? { reason } : {}),
});

/** Quien llama: el actor sale de la sesion revalidada; los permisos con su alcance, de la base de datos. */
export interface StudentsContext {
  actorId: string;
  grants: readonly Grant[];
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Asignaciones vigentes de grupos a usuarios (prefectura). Aun no existen: ver `noGroupAssignments`. */
export const noGroupAssignments: GroupAssignments = { groupIdsFor: async () => [] };

const FIELD_SPEC: FieldSpec = {
  id: 'students:read_basic',
  givenNames: 'students:read_basic',
  familyName: 'students:read_basic',
  schoolCode: 'students:read_basic',
  isActive: 'students:read_basic',
  currentGroup: 'students:read_basic',
  createdAt: 'students:read',
  updatedAt: 'students:read',
};

interface StudentRow {
  id: string;
  given_names: string;
  family_name: string;
  school_code: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  cg_id: string | null;
  cg_year_id: string | null;
  cg_year_name: string | null;
  cg_grade: number | null;
  cg_code: string | null;
  cg_shift: 'matutino' | 'vespertino' | null;
}
interface EnrollmentRow {
  id: string;
  student_id: string;
  school_year_id: string;
  school_year_name: string;
  year_starts_on: string;
  year_ends_on: string;
  starts_on: string;
  ends_on: string | null;
  created_at: Date;
}
interface AssignmentRow {
  id: string;
  enrollment_id: string;
  starts_on: string;
  ends_on: string | null;
  created_at: Date;
  group_id: string;
  school_year_id: string;
  school_year_name: string;
  grade: number;
  code: string;
  shift: 'matutino' | 'vespertino' | null;
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `cg_*`: grupo vigente en $1 (fecha de hoy) segun la asignacion vigente de una matricula vigente en esa fecha. */
const STUDENT_SELECT = (todayParam: string) => `
  SELECT s.id, s.given_names, s.family_name, s.school_code, s.is_active, s.created_at, s.updated_at,
         cg.group_id AS cg_id, cg.school_year_id AS cg_year_id, cg.year_name AS cg_year_name,
         cg.grade AS cg_grade, cg.code AS cg_code, cg.shift AS cg_shift
    FROM students s
    LEFT JOIN LATERAL (
      SELECT g.id AS group_id, g.school_year_id, y.name AS year_name, g.grade, g.code, g.shift
        FROM student_group_assignments a
        JOIN enrollments e ON e.id = a.enrollment_id
        JOIN groups g ON g.id = a.group_id
        JOIN school_years y ON y.id = g.school_year_id
       WHERE e.student_id = s.id AND a.starts_on <= ${todayParam}::date
         AND (a.ends_on IS NULL OR a.ends_on >= ${todayParam}::date) AND ${todayParam}::date <= y.ends_on
       ORDER BY a.starts_on DESC LIMIT 1
    ) cg ON true`;

const groupRef = (row: {
  id: string;
  schoolYearId: string;
  schoolYearName: string;
  grade: number;
  code: string;
  shift: 'matutino' | 'vespertino' | null;
}): GroupRefDto => row;

export interface StudentsServiceOptions {
  store: SessionStore;
  /** Asignaciones de grupos a usuarios (alcance `assigned_groups`). Por defecto ninguna. */
  assignments?: GroupAssignments;
  /** "Hoy" (YYYY-MM-DD, hora de la escuela). Por defecto lo calcula la base. Inyectable en pruebas. */
  today?: () => string;
}

export function createStudentsService(options: StudentsServiceOptions) {
  const { store } = options;
  const assignments = options.assignments ?? noGroupAssignments;

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
    ctx: StudentsContext,
    type: string,
    details: Record<string, unknown>,
  ) =>
    recordAudit(
      tx,
      { actorId: ctx.actorId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
      { type, outcome: 'success', details },
    );

  async function denied(ctx: StudentsContext, action: string): Promise<void> {
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

  /** Permiso de ESCRITURA: solo cuenta con alcance `all` (no existe "escribir solo mis grupos"). */
  const canManage = (ctx: StudentsContext, permission: string) =>
    ctx.grants.some((g) => g.permission === permission && g.scope === 'all');

  const accessFor = (ctx: StudentsContext, permission: string, today: string): Promise<Access> =>
    resolveAccess(ctx.grants, permission, ctx.actorId, today, assignments);

  /** Condicion SQL de alcance sobre `s` (alias de students). `null` = sin filtro; 'none' = cero filas. */
  function scopeWhere(
    access: Access,
    params: unknown[],
    todayParam: string,
  ): string | null | 'none' {
    if (access.kind === 'all') return null;
    if (access.kind === 'groups' && access.groupIds.size > 0) {
      params.push([...access.groupIds].sort());
      return `EXISTS (SELECT 1 FROM student_group_assignments sa JOIN enrollments se ON se.id = sa.enrollment_id
                       WHERE se.student_id = s.id AND sa.group_id = ANY($${params.length}::uuid[])
                         AND sa.starts_on <= ${todayParam}::date AND (sa.ends_on IS NULL OR sa.ends_on >= ${todayParam}::date))`;
    }
    return 'none'; // sin permiso, 'own' (no aplica a alumnos) o conjunto de grupos vacio: ninguna fila
  }

  /** La base de datos aun no tiene el modulo (0007) o no concede el acceso (0003): respuesta controlada. */
  function mapReadError(error: unknown): StudentsResult<never> {
    const e = error as { code?: string };
    if (e.code === '42P01' || e.code === '42501')
      return fail(
        'UNAVAILABLE',
        'El módulo de alumnos aún no está habilitado en la base de datos',
        'STUDENTS_UNAVAILABLE',
      );
    throw error;
  }

  function mapWriteError(error: unknown): StudentsResult<never> {
    const e = error as { code?: string; constraint?: string; message?: string };
    switch (e.code) {
      case '23505':
        return fail(
          'CONFLICT',
          e.constraint === 'students_school_code_key'
            ? 'Ya existe un alumno con ese código escolar'
            : e.constraint === 'enrollments_student_year_key'
              ? 'El alumno ya tiene matrícula en ese ciclo'
              : 'El alumno ya tiene un grupo vigente en esa matrícula',
          e.constraint === 'students_school_code_key' ? 'DUPLICATE_SCHOOL_CODE' : 'ALREADY_EXISTS',
        );
      case '23P01':
        return fail(
          'CONFLICT',
          'El periodo se traslapa con otra asignación de grupo de la matrícula',
          'PERIOD_OVERLAP',
        );
      case '23514':
        if (e.constraint === 'students_deactivate_open_enrollment')
          return fail(
            'CONFLICT',
            'El alumno tiene una matrícula sin baja: da de baja la matrícula antes de desactivarlo',
            'HAS_OPEN_ENROLLMENT',
          );
        return fail(
          e.constraint === 'enrollments_student_active' ? 'CONFLICT' : 'VALIDATION',
          e.constraint === 'enrollments_student_active'
            ? 'El alumno está inactivo: reactívalo antes de inscribirlo'
            : 'Los datos no cumplen las reglas de matrículas y grupos',
          e.constraint === 'enrollments_student_active' ? 'STUDENT_INACTIVE' : undefined,
        );
      case '22007':
      case '22008':
      case '22P02':
      case '23502':
      case '23503':
        return fail('VALIDATION', 'Los datos no cumplen las reglas de alumnos y matrículas');
      case '42501':
        return /permission denied/i.test(e.message ?? '')
          ? fail(
              'UNAVAILABLE',
              'La base de datos aún no habilita la escritura de alumnos para la API',
              'STUDENTS_UNAVAILABLE',
            )
          : fail(
              'CONFLICT',
              'La operación no está permitida sobre un registro histórico',
              'IMMUTABLE',
            );
      case '42P01':
        return fail(
          'UNAVAILABLE',
          'El módulo de alumnos aún no está habilitado en la base de datos',
          'STUDENTS_UNAVAILABLE',
        );
      case '40001':
      case '40P01':
        return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente', 'CONCURRENT');
      default:
        throw error;
    }
  }

  const guardWrite = <T>(run: () => Promise<StudentsResult<T>>): Promise<StudentsResult<T>> =>
    run().catch((e: unknown) => mapWriteError(e) as StudentsResult<T>);
  const guardRead = <T>(run: () => Promise<StudentsResult<T>>): Promise<StudentsResult<T>> =>
    run().catch((e: unknown) => mapReadError(e) as StudentsResult<T>);

  // ------------------------------------------------------------------------------------------------ proyeccion
  function toStudentDto(row: StudentRow, ctx: StudentsContext, expediente: boolean): StudentDto {
    const group: GroupRefDto | null = row.cg_id
      ? groupRef({
          id: row.cg_id,
          schoolYearId: row.cg_year_id!,
          schoolYearName: row.cg_year_name!,
          grade: row.cg_grade!,
          code: row.cg_code!,
          shift: row.cg_shift,
        })
      : null;
    const full = {
      id: row.id,
      givenNames: row.given_names,
      familyName: row.family_name,
      schoolCode: row.school_code,
      isActive: row.is_active,
      currentGroup: group,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
    // `students:read` solo cuenta si el alumno esta dentro de SU alcance (expediente); si no, se retira del principal.
    const principal: Principal = {
      userId: ctx.actorId,
      status: 'active',
      grants: ctx.grants.filter((g) => g.permission !== 'students:read' || expediente),
    };
    return projectFields(full, FIELD_SPEC, principal) as StudentDto;
  }

  /** ¿Puede ver el expediente (students:read) de ESTE alumno? Consulta con el mismo alcance, en la base. */
  async function canSeeExpediente(
    tx: SqlClient,
    ctx: StudentsContext,
    studentId: string,
    today: string,
  ): Promise<boolean> {
    const access = await accessFor(ctx, 'students:read', today);
    if (access.kind === 'all') return true;
    const params: unknown[] = [today, studentId];
    const where = scopeWhere(access, params, '$1');
    if (where === 'none' || where === null) return false;
    const r = await tx.query(`SELECT 1 FROM students s WHERE s.id = $2 AND ${where}`, params);
    return r.rows.length > 0;
  }

  async function loadVisibleStudent(
    tx: SqlClient,
    ctx: StudentsContext,
    id: string,
    today: string,
    access: Access,
    lock = false,
  ): Promise<StudentRow | null> {
    const params: unknown[] = [today, id];
    const where = scopeWhere(access, params, '$1');
    if (where === 'none') return null;
    const r = await tx.query<StudentRow>(
      `${STUDENT_SELECT('$1')} WHERE s.id = $2${where ? ` AND ${where}` : ''}${lock ? ' FOR UPDATE OF s' : ''}`,
      params,
    );
    return r.rows[0] ?? null;
  }

  async function loadEnrollments(
    tx: SqlClient,
    filter: { studentId?: string; enrollmentId?: string },
    today: string,
  ): Promise<EnrollmentDto[]> {
    const params: unknown[] = [];
    const cond: string[] = [];
    if (filter.studentId) {
      params.push(filter.studentId);
      cond.push(`e.student_id = $${params.length}`);
    }
    if (filter.enrollmentId) {
      params.push(filter.enrollmentId);
      cond.push(`e.id = $${params.length}`);
    }
    const rows = await tx.query<EnrollmentRow>(
      `SELECT e.id, e.student_id, e.school_year_id, y.name AS school_year_name, y.starts_on::text AS year_starts_on,
              y.ends_on::text AS year_ends_on, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on, e.created_at
         FROM enrollments e JOIN school_years y ON y.id = e.school_year_id
        WHERE ${cond.join(' AND ')} ORDER BY e.starts_on DESC, e.id`,
      params,
    );
    if (rows.rows.length === 0) return [];
    const ids = rows.rows.map((r) => r.id);
    const asg = await tx.query<AssignmentRow>(
      `SELECT a.id, a.enrollment_id, a.starts_on::text AS starts_on, a.ends_on::text AS ends_on, a.created_at,
              g.id AS group_id, g.school_year_id, y.name AS school_year_name, g.grade, g.code, g.shift
         FROM student_group_assignments a JOIN groups g ON g.id = a.group_id JOIN school_years y ON y.id = g.school_year_id
        WHERE a.enrollment_id = ANY($1::uuid[]) ORDER BY a.starts_on, a.id`,
      [ids],
    );
    return rows.rows.map((r) => {
      const status: EnrollmentStatus = r.ends_on
        ? 'withdrawn'
        : r.year_ends_on < today
          ? 'completed'
          : r.starts_on > today
            ? 'upcoming'
            : 'active';
      const list: GroupAssignmentDto[] = asg.rows
        .filter((a) => a.enrollment_id === r.id)
        .map((a) => ({
          id: a.id,
          enrollmentId: a.enrollment_id,
          group: groupRef({
            id: a.group_id,
            schoolYearId: a.school_year_id,
            schoolYearName: a.school_year_name,
            grade: a.grade,
            code: a.code,
            shift: a.shift,
          }),
          startsOn: a.starts_on,
          endsOn: a.ends_on,
          current:
            a.starts_on <= today &&
            (a.ends_on === null || a.ends_on >= today) &&
            today <= r.year_ends_on,
          createdAt: a.created_at.toISOString(),
        }));
      return {
        id: r.id,
        studentId: r.student_id,
        schoolYearId: r.school_year_id,
        schoolYearName: r.school_year_name,
        startsOn: r.starts_on,
        endsOn: r.ends_on,
        status,
        createdAt: r.created_at.toISOString(),
        assignments: list,
      };
    });
  }

  /** Matricula + ciclo, con bloqueo de fila, para operaciones que la modifican. El estudiante debe ser visible para la operacion. */
  async function lockEnrollment(tx: SqlClient, id: string) {
    const r = await tx.query<{
      id: string;
      student_id: string;
      school_year_id: string;
      starts_on: string;
      ends_on: string | null;
      year_ends_on: string;
    }>(
      `SELECT e.id, e.student_id, e.school_year_id, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on,
              y.ends_on::text AS year_ends_on
         FROM enrollments e JOIN school_years y ON y.id = e.school_year_id
        WHERE e.id = $1 FOR UPDATE OF e`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async function currentAssignment(tx: SqlClient, enrollmentId: string) {
    const r = await tx.query<{ id: string; group_id: string; starts_on: string }>(
      `SELECT id, group_id, starts_on::text AS starts_on FROM student_group_assignments
        WHERE enrollment_id = $1 AND ends_on IS NULL`,
      [enrollmentId],
    );
    return r.rows[0] ?? null;
  }

  async function loadGroupForYear(tx: SqlClient, groupId: string, schoolYearId: string) {
    const r = await tx.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM groups WHERE id = $1 AND school_year_id = $2`,
      [groupId, schoolYearId],
    );
    return r.rows[0] ?? null;
  }

  const notFound = () => fail('NOT_FOUND', 'No se encontró el alumno o la matrícula');
  const forbidden = () => fail('FORBIDDEN', 'No tiene permiso para esta operación');

  return {
    // ------------------------------------------------------------------------------------------------ alumnos
    async listStudents(
      ctx: StudentsContext,
      query: ListStudentsQuery,
    ): Promise<StudentsResult<StudentList>> {
      return guardRead(async () => {
        const result = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const access = await accessFor(ctx, 'students:read_basic', today);
          if (access.kind === 'denied') return 'forbidden' as const;
          const params: unknown[] = [today];
          // `$1` (hoy) siempre se referencia: PostgreSQL rechaza parametros sin tipo que no aparecen en la sentencia.
          const cond: string[] = ['$1::date IS NOT NULL'];
          const scope = scopeWhere(access, params, '$1');
          if (scope === 'none')
            return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
          if (scope) cond.push(scope);
          if (query.q) {
            params.push(`%${escapeLike(query.q)}%`);
            const p = `$${params.length}`;
            cond.push(
              `(s.family_name ILIKE ${p} OR s.given_names ILIKE ${p} OR (s.given_names || ' ' || s.family_name) ILIKE ${p}
                OR (s.family_name || ' ' || s.given_names) ILIKE ${p} OR s.school_code ILIKE ${p})`,
            );
          }
          if (query.isActive !== undefined) {
            params.push(query.isActive);
            cond.push(`s.is_active = $${params.length}`);
          }
          const asOf = query.asOf ?? today;
          if (query.schoolYearId) {
            params.push(query.schoolYearId, asOf);
            const [py, pd] = [`$${params.length - 1}`, `$${params.length}`];
            cond.push(`EXISTS (SELECT 1 FROM enrollments fe JOIN school_years fy ON fy.id = fe.school_year_id
                                WHERE fe.student_id = s.id AND fe.school_year_id = ${py}::uuid
                                  AND fe.starts_on <= LEAST(GREATEST(${pd}::date, fy.starts_on), fy.ends_on)
                                  AND (fe.ends_on IS NULL OR fe.ends_on >= LEAST(GREATEST(${pd}::date, fy.starts_on), fy.ends_on)))`);
          }
          if (query.groupId) {
            params.push(query.groupId, asOf);
            const [pg, pd] = [`$${params.length - 1}`, `$${params.length}`];
            cond.push(`EXISTS (SELECT 1 FROM student_group_assignments fa JOIN enrollments fe2 ON fe2.id = fa.enrollment_id
                                JOIN groups fg ON fg.id = fa.group_id JOIN school_years fy2 ON fy2.id = fg.school_year_id
                                WHERE fe2.student_id = s.id AND fa.group_id = ${pg}::uuid
                                  AND fa.starts_on <= LEAST(GREATEST(${pd}::date, fy2.starts_on), fy2.ends_on)
                                  AND (fa.ends_on IS NULL OR fa.ends_on >= LEAST(GREATEST(${pd}::date, fy2.starts_on), fy2.ends_on)))`);
          }
          const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM students s ${where}`,
            params,
          );
          params.push(query.pageSize, (query.page - 1) * query.pageSize);
          const rows = await tx.query<StudentRow>(
            `${STUDENT_SELECT('$1')} ${where} ORDER BY s.family_name, s.given_names, s.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          const exp = await accessFor(ctx, 'students:read', today);
          const expedienteAll = exp.kind === 'all';
          const items = rows.rows.map((r) => toStudentDto(r, ctx, expedienteAll));
          if (query.q)
            await audit(tx, ctx, 'student.searched', { total: total.rows[0]!.n, withQuery: true });
          return { items, page: query.page, pageSize: query.pageSize, total: total.rows[0]!.n };
        });
        if (result === 'forbidden') {
          await denied(ctx, 'students.list');
          return forbidden();
        }
        return { ok: true as const, value: result };
      });
    },

    async getStudent(ctx: StudentsContext, id: string): Promise<StudentsResult<StudentDto>> {
      return guardRead(async () => {
        const result = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const access = await accessFor(ctx, 'students:read_basic', today);
          if (access.kind === 'denied') return 'forbidden' as const;
          const row = await loadVisibleStudent(tx, ctx, id, today, access);
          if (!row) return 'missing' as const;
          const expediente = await canSeeExpediente(tx, ctx, id, today);
          if (expediente) await audit(tx, ctx, 'student.viewed', { studentId: id });
          return toStudentDto(row, ctx, expediente);
        });
        if (result === 'forbidden') {
          await denied(ctx, 'students.get');
          return forbidden();
        }
        if (result === 'missing') return notFound();
        return { ok: true as const, value: result };
      });
    },

    async createStudent(
      ctx: StudentsContext,
      body: CreateStudentBody,
    ): Promise<StudentsResult<StudentDto>> {
      if (!canManage(ctx, 'students:manage')) {
        await denied(ctx, 'students.create');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO students (given_names, family_name, school_code) VALUES ($1, $2, $3) RETURNING id`,
            [body.givenNames, body.familyName, body.schoolCode],
          );
          const id = ins.rows[0]!.id;
          await audit(tx, ctx, 'student.created', {
            studentId: id,
            withSchoolCode: body.schoolCode !== null,
          });
          const row = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2`, [today, id])
          ).rows[0]!;
          return { ok: true as const, value: toStudentDto(row, ctx, true) };
        }),
      );
    },

    async updateStudent(
      ctx: StudentsContext,
      id: string,
      body: UpdateStudentBody,
    ): Promise<StudentsResult<StudentDto>> {
      if (!canManage(ctx, 'students:manage')) {
        await denied(ctx, 'students.update');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const cur = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2 FOR UPDATE OF s`, [
              today,
              id,
            ])
          ).rows[0];
          if (!cur) return notFound();
          const next = {
            given_names: body.givenNames ?? cur.given_names,
            family_name: body.familyName ?? cur.family_name,
            school_code: body.schoolCode === undefined ? cur.school_code : body.schoolCode,
          };
          const changed: string[] = [];
          if (next.given_names !== cur.given_names) changed.push('givenNames');
          if (next.family_name !== cur.family_name) changed.push('familyName');
          if (next.school_code !== cur.school_code) changed.push('schoolCode');
          if (changed.length > 0) {
            await tx.query(
              `UPDATE students SET given_names = $2, family_name = $3, school_code = $4 WHERE id = $1`,
              [id, next.given_names, next.family_name, next.school_code],
            );
            await audit(tx, ctx, 'student.updated', { studentId: id, changed });
          }
          const row = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2`, [today, id])
          ).rows[0]!;
          return { ok: true as const, value: toStudentDto(row, ctx, true) };
        }),
      );
    },

    /** Desactiva (idempotente). Un alumno con matricula SIN baja en un ciclo no terminado debe darse de baja antes. */
    async deactivateStudent(ctx: StudentsContext, id: string): Promise<StudentsResult<StudentDto>> {
      if (!canManage(ctx, 'students:manage')) {
        await denied(ctx, 'students.deactivate');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const cur = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2 FOR UPDATE OF s`, [
              today,
              id,
            ])
          ).rows[0];
          if (!cur) return notFound();
          if (cur.is_active) {
            const open = await tx.query(
              `SELECT 1 FROM enrollments e JOIN school_years y ON y.id = e.school_year_id
                WHERE e.student_id = $1 AND e.ends_on IS NULL AND y.ends_on >= $2::date LIMIT 1`,
              [id, today],
            );
            if (open.rows.length > 0)
              return fail(
                'CONFLICT',
                'El alumno tiene una matrícula sin baja: da de baja la matrícula antes de desactivarlo',
                'HAS_OPEN_ENROLLMENT',
              );
            await tx.query(`UPDATE students SET is_active = false WHERE id = $1`, [id]);
            await audit(tx, ctx, 'student.deactivated', { studentId: id });
          }
          const row = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2`, [today, id])
          ).rows[0]!;
          return { ok: true as const, value: toStudentDto(row, ctx, true) };
        }),
      );
    },

    /** Reactivacion autorizada (students:manage, auditada). Idempotente. */
    async reactivateStudent(ctx: StudentsContext, id: string): Promise<StudentsResult<StudentDto>> {
      if (!canManage(ctx, 'students:manage')) {
        await denied(ctx, 'students.reactivate');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const cur = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2 FOR UPDATE OF s`, [
              today,
              id,
            ])
          ).rows[0];
          if (!cur) return notFound();
          if (!cur.is_active) {
            await tx.query(`UPDATE students SET is_active = true WHERE id = $1`, [id]);
            await audit(tx, ctx, 'student.reactivated', { studentId: id });
          }
          const row = (
            await tx.query<StudentRow>(`${STUDENT_SELECT('$1')} WHERE s.id = $2`, [today, id])
          ).rows[0]!;
          return { ok: true as const, value: toStudentDto(row, ctx, true) };
        }),
      );
    },

    // ------------------------------------------------------------------------------------------------ matriculas
    async listEnrollments(
      ctx: StudentsContext,
      studentId: string,
    ): Promise<StudentsResult<EnrollmentDto[]>> {
      return guardRead(async () => {
        const result = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const read = await accessFor(ctx, 'students:read', today);
          if (read.kind === 'denied') return 'forbidden' as const;
          // el alumno debe ser visible con ambos permisos (basico y expediente); fuera de alcance = inexistente
          const basic = await accessFor(ctx, 'students:read_basic', today);
          if (basic.kind === 'denied') return 'forbidden' as const;
          const visible = await loadVisibleStudent(tx, ctx, studentId, today, basic);
          if (!visible || !(await canSeeExpediente(tx, ctx, studentId, today)))
            return 'missing' as const;
          await audit(tx, ctx, 'student.viewed', { studentId, section: 'enrollments' });
          return loadEnrollments(tx, { studentId }, today);
        });
        if (result === 'forbidden') {
          await denied(ctx, 'enrollments.list');
          return forbidden();
        }
        if (result === 'missing') return notFound();
        return { ok: true as const, value: result };
      });
    },

    async getEnrollment(
      ctx: StudentsContext,
      enrollmentId: string,
    ): Promise<StudentsResult<EnrollmentDto>> {
      return guardRead(async () => {
        const result = await store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const read = await accessFor(ctx, 'students:read', today);
          const basic = await accessFor(ctx, 'students:read_basic', today);
          if (read.kind === 'denied' || basic.kind === 'denied') return 'forbidden' as const;
          const list = await loadEnrollments(tx, { enrollmentId }, today);
          const enrollment = list[0];
          if (!enrollment) return 'missing' as const;
          const visible = await loadVisibleStudent(tx, ctx, enrollment.studentId, today, basic);
          if (!visible || !(await canSeeExpediente(tx, ctx, enrollment.studentId, today)))
            return 'missing' as const;
          await audit(tx, ctx, 'student.viewed', {
            studentId: enrollment.studentId,
            section: 'enrollment',
          });
          return enrollment;
        });
        if (result === 'forbidden') {
          await denied(ctx, 'enrollments.get');
          return forbidden();
        }
        if (result === 'missing') return notFound();
        return { ok: true as const, value: result };
      });
    },

    /** Inscribe a un alumno ACTIVO en un ciclo no terminado (una matricula por alumno y ciclo). */
    async enroll(
      ctx: StudentsContext,
      studentId: string,
      body: EnrollBody,
    ): Promise<StudentsResult<EnrollmentDto>> {
      if (!canManage(ctx, 'enrollments:manage')) {
        await denied(ctx, 'enrollments.create');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const student = (
            await tx.query<{ id: string; is_active: boolean }>(
              `SELECT id, is_active FROM students WHERE id = $1 FOR SHARE`,
              [studentId],
            )
          ).rows[0];
          if (!student) return notFound();
          const year = (
            await tx.query<{ id: string; starts_on: string; ends_on: string }>(
              `SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on FROM school_years WHERE id = $1`,
              [body.schoolYearId],
            )
          ).rows[0];
          if (!year) return fail('VALIDATION', 'El ciclo escolar no existe', 'UNKNOWN_SCHOOL_YEAR');
          if (year.ends_on < today)
            return fail(
              'HISTORICAL',
              'El ciclo ya terminó: las matrículas históricas no se modifican',
              'HISTORICAL',
            );
          if (!student.is_active)
            return fail(
              'CONFLICT',
              'El alumno está inactivo: reactívalo antes de inscribirlo',
              'STUDENT_INACTIVE',
            );
          const startsOn =
            body.startsOn ??
            (today >= year.starts_on && today <= year.ends_on ? today : year.starts_on);
          if (startsOn < year.starts_on || startsOn > year.ends_on)
            return fail(
              'VALIDATION',
              'La fecha de inicio debe estar dentro del ciclo escolar',
              'OUT_OF_YEAR',
            );
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO enrollments (student_id, school_year_id, starts_on) VALUES ($1, $2, $3::date) RETURNING id`,
            [studentId, year.id, startsOn],
          );
          const id = ins.rows[0]!.id;
          await audit(tx, ctx, 'enrollment.created', {
            enrollmentId: id,
            studentId,
            schoolYearId: year.id,
            startsOn,
            backdated: startsOn < today,
          });
          const dto = (await loadEnrollments(tx, { enrollmentId: id }, today))[0]!;
          return { ok: true as const, value: dto };
        }),
      );
    },

    /** Baja: cierra la matricula y su grupo vigente en una transaccion. `endsOn` = ultimo dia inscrito. */
    async withdraw(
      ctx: StudentsContext,
      enrollmentId: string,
      body: WithdrawBody,
    ): Promise<StudentsResult<EnrollmentDto>> {
      if (!canManage(ctx, 'enrollments:manage')) {
        await denied(ctx, 'enrollments.withdraw');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const e = await lockEnrollment(tx, enrollmentId);
          if (!e) return notFound();
          if (e.year_ends_on < today)
            return fail(
              'HISTORICAL',
              'El ciclo ya terminó: las matrículas históricas no se modifican',
              'HISTORICAL',
            );
          if (e.ends_on) return fail('CONFLICT', 'La matrícula ya tiene baja', 'ALREADY_WITHDRAWN');
          const endsOn = body.endsOn ?? today;
          if (endsOn < e.starts_on || endsOn > e.year_ends_on)
            return fail(
              'VALIDATION',
              'La fecha de baja debe estar entre el inicio de la matrícula y el fin del ciclo',
              'OUT_OF_PERIOD',
            );
          const later = await tx.query(
            `SELECT 1 FROM student_group_assignments WHERE enrollment_id = $1 AND starts_on > $2::date LIMIT 1`,
            [enrollmentId, endsOn],
          );
          if (later.rows.length > 0)
            return fail(
              'VALIDATION',
              'Hay periodos de grupo posteriores a esa fecha de baja',
              'ASSIGNMENT_AFTER_END',
            );
          const open = await currentAssignment(tx, enrollmentId);
          if (open)
            await tx.query(
              `UPDATE student_group_assignments SET ends_on = $2::date WHERE id = $1`,
              [open.id, endsOn],
            );
          await tx.query(`UPDATE enrollments SET ends_on = $2::date WHERE id = $1`, [
            enrollmentId,
            endsOn,
          ]);
          await audit(tx, ctx, 'enrollment.withdrawn', {
            enrollmentId,
            studentId: e.student_id,
            endsOn,
            closedAssignmentId: open?.id ?? null,
          });
          return {
            ok: true as const,
            value: (await loadEnrollments(tx, { enrollmentId }, today))[0]!,
          };
        }),
      );
    },

    // ------------------------------------------------------------------------------------------------ grupos
    /** Primera asignacion de grupo de una matricula (despues, se usa el traslado). */
    async assignGroup(
      ctx: StudentsContext,
      enrollmentId: string,
      body: AssignGroupBody,
    ): Promise<StudentsResult<EnrollmentDto>> {
      if (!canManage(ctx, 'enrollments:manage')) {
        await denied(ctx, 'group_assignments.create');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const e = await lockEnrollment(tx, enrollmentId);
          if (!e) return notFound();
          if (e.year_ends_on < today)
            return fail(
              'HISTORICAL',
              'El ciclo ya terminó: el historial de grupos no se modifica',
              'HISTORICAL',
            );
          if (e.ends_on)
            return fail(
              'CONFLICT',
              'La matrícula tiene baja: ya no admite grupos',
              'ENROLLMENT_CLOSED',
            );
          const any = await tx.query(
            `SELECT 1 FROM student_group_assignments WHERE enrollment_id = $1 LIMIT 1`,
            [enrollmentId],
          );
          if (any.rows.length > 0)
            return fail(
              'CONFLICT',
              'La matrícula ya tiene grupo: usa el traslado de grupo',
              'ALREADY_ASSIGNED',
            );
          const group = await loadGroupForYear(tx, body.groupId, e.school_year_id);
          if (!group)
            return fail(
              'VALIDATION',
              'El grupo no existe en el ciclo de la matrícula',
              'GROUP_NOT_IN_YEAR',
            );
          if (!group.is_active) return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
          const startsOn = body.startsOn ?? e.starts_on;
          if (startsOn < e.starts_on || startsOn > (e.ends_on ?? e.year_ends_on))
            return fail(
              'VALIDATION',
              'La fecha debe estar dentro del periodo de la matrícula',
              'OUT_OF_PERIOD',
            );
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO student_group_assignments (enrollment_id, school_year_id, group_id, starts_on)
             VALUES ($1, $2, $3, $4::date) RETURNING id`,
            [enrollmentId, e.school_year_id, group.id, startsOn],
          );
          await audit(tx, ctx, 'group_assignment.created', {
            assignmentId: ins.rows[0]!.id,
            enrollmentId,
            studentId: e.student_id,
            groupId: group.id,
            startsOn,
            backdated: startsOn < today,
          });
          return {
            ok: true as const,
            value: (await loadEnrollments(tx, { enrollmentId }, today))[0]!,
          };
        }),
      );
    },

    /** Traslado: cierra la asignacion vigente en E-1 y abre la nueva en E, en una transaccion y bajo bloqueo de la matricula. */
    async transfer(
      ctx: StudentsContext,
      enrollmentId: string,
      body: TransferBody,
    ): Promise<StudentsResult<EnrollmentDto>> {
      if (!canManage(ctx, 'enrollments:manage')) {
        await denied(ctx, 'group_assignments.transfer');
        return forbidden();
      }
      return guardWrite(() =>
        store.transaction(async (tx) => {
          const today = await todayOf(tx);
          const e = await lockEnrollment(tx, enrollmentId);
          if (!e) return notFound();
          if (e.year_ends_on < today)
            return fail(
              'HISTORICAL',
              'El ciclo ya terminó: el historial de grupos no se modifica',
              'HISTORICAL',
            );
          if (e.ends_on)
            return fail(
              'CONFLICT',
              'La matrícula tiene baja: ya no admite traslados',
              'ENROLLMENT_CLOSED',
            );
          const cur = await currentAssignment(tx, enrollmentId);
          if (!cur)
            return fail(
              'CONFLICT',
              'La matrícula aún no tiene grupo: asigna uno primero',
              'NO_CURRENT_ASSIGNMENT',
            );
          const group = await loadGroupForYear(tx, body.groupId, e.school_year_id);
          if (!group)
            return fail(
              'VALIDATION',
              'El grupo no existe en el ciclo de la matrícula',
              'GROUP_NOT_IN_YEAR',
            );
          if (group.id === cur.group_id)
            return fail(
              'CONFLICT',
              'El alumno ya está en ese grupo: el traslado no tendría efecto',
              'SAME_GROUP',
            );
          if (!group.is_active) return fail('CONFLICT', 'El grupo está inactivo', 'GROUP_INACTIVE');
          const effectiveOn = body.effectiveOn ?? today;
          if (effectiveOn === cur.starts_on)
            return fail(
              'CONFLICT',
              'La asignación vigente empezó ese mismo día: el modelo trabaja con días y no admite dos grupos el mismo día',
              'SAME_DAY',
            );
          if (effectiveOn < cur.starts_on)
            return fail(
              'VALIDATION',
              'La fecha del traslado debe ser posterior al inicio de la asignación vigente',
              'BEFORE_CURRENT_START',
            );
          if (effectiveOn > e.year_ends_on)
            return fail(
              'VALIDATION',
              'La fecha del traslado cae después del fin del ciclo',
              'OUT_OF_PERIOD',
            );
          await tx.query(`UPDATE student_group_assignments SET ends_on = $2::date WHERE id = $1`, [
            cur.id,
            addDays(effectiveOn, -1),
          ]);
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO student_group_assignments (enrollment_id, school_year_id, group_id, starts_on)
             VALUES ($1, $2, $3, $4::date) RETURNING id`,
            [enrollmentId, e.school_year_id, group.id, effectiveOn],
          );
          await audit(tx, ctx, 'group_assignment.transferred', {
            enrollmentId,
            studentId: e.student_id,
            fromGroupId: cur.group_id,
            toGroupId: group.id,
            effectiveOn,
            previousAssignmentId: cur.id,
            assignmentId: ins.rows[0]!.id,
            backdated: effectiveOn < today,
          });
          return {
            ok: true as const,
            value: (await loadEnrollments(tx, { enrollmentId }, today))[0]!,
          };
        }),
      );
    },
  };
}

export type StudentsService = ReturnType<typeof createStudentsService>;
