/**
 * Catalogo escolar: ciclos y grupos (logica de dominio, sin HTTP).
 *
 *  - Lectura: permiso `catalog:read` con alcance `all`. Escritura: `catalog:manage_school` (dominio escolar; hoy solo `direccion`, migracion 0006).
 *    Denegar por defecto; toda denegacion se audita (`authz.denied`) y toda mutacion tambien (`school_year.*`, `group.*`).
 *  - Sin borrado: se desactiva (`is_active`). El ciclo y el grado de un grupo NO cambian (ni la API ni los privilegios lo permiten).
 *  - Historial: los ciclos terminados (y sus grupos) no se modifican; solo se puede dar de baja la marca de vigente.
 *  - Un solo ciclo vigente: activar uno desactiva el anterior en la misma transaccion, bajo un bloqueo consultivo, y solo puede
 *    activarse el ciclo que incluye la fecha de HOY (hora de la escuela, America/Mazatlan).
 *  - La base es la ultima defensa (unicidad, traslape, formato, hora de entrada). Sus errores se traducen a resultados controlados
 *    sin exponer SQL; si la base aun no concede los privilegios de escritura (propuesta 0002), las mutaciones responden
 *    WRITE_UNAVAILABLE y la API nunca amplia privilegios por su cuenta.
 */
import {
  SCHOOL_TIME_ZONE,
  SCHOOL_YEAR_MAX_DAYS,
  SCHOOL_YEAR_MIN_DAYS,
  schoolYearLengthDays,
  type CreateGroupBody,
  type CreateSchoolYearBody,
  type GroupDto,
  type GroupList,
  type ListGroupsQuery,
  type ListSchoolYearsQuery,
  type SchoolYearDto,
  type SchoolYearList,
  type UpdateGroupBody,
  type UpdateSchoolYearBody,
} from '@eta15/shared-contracts';
import type { ActorContext } from '../admin-users/admin-users.service.js';
import { recordAudit } from '../audit/audit-log.js';
import type { SessionStore, SqlClient } from '../auth/session-service.js';

export type CatalogFailure =
  'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'HISTORICAL' | 'WRITE_UNAVAILABLE';
export type CatalogResult<T> =
  { ok: true; value: T } | { ok: false; code: CatalogFailure; message: string };
const fail = (code: CatalogFailure, message: string) => ({ ok: false as const, code, message });

interface YearRow {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_active: boolean;
  group_count: number;
  created_at: Date;
  updated_at: Date;
}
interface GroupRow {
  id: string;
  school_year_id: string;
  school_year_name: string;
  year_ends_on: string;
  grade: number;
  code: string;
  shift: 'matutino' | 'vespertino' | null;
  expected_entry_time: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const YEAR_SELECT = `
  SELECT y.id, y.name, y.starts_on::text AS starts_on, y.ends_on::text AS ends_on, y.is_active,
         (SELECT count(*)::int FROM groups g WHERE g.school_year_id = y.id) AS group_count,
         y.created_at, y.updated_at
    FROM school_years y`;
const GROUP_SELECT = `
  SELECT g.id, g.school_year_id, y.name AS school_year_name, y.ends_on::text AS year_ends_on, g.grade, g.code, g.shift,
         g.expected_entry_time::text AS expected_entry_time, g.is_active, g.created_at, g.updated_at
    FROM groups g JOIN school_years y ON y.id = g.school_year_id`;

const periodOf = (startsOn: string, endsOn: string, today: string): SchoolYearDto['period'] =>
  endsOn < today ? 'past' : startsOn > today ? 'future' : 'current';

const yearDto = (row: YearRow, today: string): SchoolYearDto => ({
  id: row.id,
  name: row.name,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  isActive: row.is_active,
  period: periodOf(row.starts_on, row.ends_on, today),
  groupCount: row.group_count,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const groupDto = (row: GroupRow, today: string): GroupDto => ({
  id: row.id,
  schoolYearId: row.school_year_id,
  schoolYearName: row.school_year_name,
  grade: row.grade,
  code: row.code,
  shift: row.shift,
  expectedEntryTime: row.expected_entry_time ? row.expected_entry_time.slice(0, 5) : null,
  isActive: row.is_active,
  historical: row.year_ends_on < today,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface SchoolCatalogOptions {
  store: SessionStore;
  /** "Hoy" (YYYY-MM-DD, hora de la escuela). Por defecto lo calcula la base. Inyectable en pruebas. */
  today?: () => string;
}

export function createSchoolCatalogService(options: SchoolCatalogOptions) {
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
    ctx: ActorContext,
    type: string,
    details: Record<string, unknown>,
  ) =>
    recordAudit(
      tx,
      { actorId: ctx.actor.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
      { type, outcome: 'success', details },
    );

  async function denied(ctx: ActorContext, action: string): Promise<void> {
    await store
      .transaction((tx) =>
        recordAudit(
          tx,
          { actorId: ctx.actor.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
          {
            type: 'authz.denied',
            outcome: 'denied',
            details: { action, reason: 'missing_permission' },
          },
        ),
      )
      .catch(() => undefined);
  }

  /** Traduce errores de PostgreSQL a resultados de dominio sin exponer su texto. */
  function mapDbError(error: unknown): CatalogResult<never> {
    const e = error as { code?: string; constraint?: string; message?: string };
    switch (e.code) {
      case '23505':
        return fail(
          'CONFLICT',
          e.constraint === 'school_years_name_key'
            ? 'Ya existe un ciclo escolar con ese nombre'
            : e.constraint === 'school_years_single_active_idx'
              ? 'Ya existe otro ciclo vigente'
              : 'Ya existe un grupo con el mismo ciclo, grado, código y turno',
        );
      case '23P01':
        return fail('CONFLICT', 'Las fechas se traslapan con otro ciclo escolar');
      case '23514':
        if (
          e.constraint === 'school_years_enrollments_within' ||
          e.constraint === 'school_years_prefect_within' ||
          e.constraint === 'school_years_attendance_within'
        )
          return fail(
            'CONFLICT',
            'Hay matrículas, periodos de grupo, asignaciones de prefectura o listas de asistencia fuera de las nuevas fechas del ciclo; las fechas no pueden dejar fuera el historial',
          );
        return fail('VALIDATION', 'Los datos no cumplen las reglas del catálogo');
      case '22007':
      case '22008':
      case '22P02':
      case '23503':
      case '23502':
        return fail('VALIDATION', 'Los datos no cumplen las reglas del catálogo');
      case '42501':
        // Cambiar las fechas de un ciclo dispara un trigger (0007) que lee matriculas y periodos de grupo con los privilegios de la API.
        if (
          /enrollments|student_group_assignments|prefect_group_assignments|attendance_days/.test(
            e.message ?? '',
          )
        )
          return fail(
            'WRITE_UNAVAILABLE',
            'La base de datos aún no habilita a la API el acceso a matrículas, asignaciones de prefectura y asistencia (propuestas de privilegios 0003, 0004 y 0005): sin él no pueden cambiarse las fechas de un ciclo',
          );
        return fail(
          'WRITE_UNAVAILABLE',
          'La base de datos aún no habilita la escritura del catálogo para la API (requiere aplicar la propuesta de privilegios 0002 con autorización)',
        );
      case '40001':
      case '40P01':
        return fail('CONFLICT', 'Conflicto con otra operación simultánea; reintente');
      default:
        throw error;
    }
  }

  const needs = (ctx: ActorContext, permission: string) => ctx.actor.permissions.has(permission);

  async function loadYear(tx: SqlClient, id: string, lock = false) {
    const r = await tx.query<YearRow>(
      `${YEAR_SELECT} WHERE y.id = $1${lock ? ' FOR UPDATE OF y' : ''}`,
      [id],
    );
    return r.rows[0] ?? null;
  }
  async function loadGroup(tx: SqlClient, id: string, lock = false) {
    const r = await tx.query<GroupRow>(
      `${GROUP_SELECT} WHERE g.id = $1${lock ? ' FOR UPDATE OF g' : ''}`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  const lengthProblem = (startsOn: string, endsOn: string): string | null => {
    if (endsOn <= startsOn) return 'La fecha de fin debe ser posterior a la de inicio';
    const days = schoolYearLengthDays(startsOn, endsOn);
    return days < SCHOOL_YEAR_MIN_DAYS || days > SCHOOL_YEAR_MAX_DAYS
      ? `El ciclo debe durar entre ${SCHOOL_YEAR_MIN_DAYS} y ${SCHOOL_YEAR_MAX_DAYS} días`
      : null;
  };

  return {
    // ----------------------------------------------------------------------------------------------- ciclos
    async listSchoolYears(
      ctx: ActorContext,
      query: ListSchoolYearsQuery,
    ): Promise<CatalogResult<SchoolYearList>> {
      if (!needs(ctx, 'catalog:read')) {
        await denied(ctx, 'catalog.school_years.list');
        return fail('FORBIDDEN', 'No tiene permiso para consultar el catálogo escolar');
      }
      return store.transaction(async (tx) => {
        const today = await todayOf(tx);
        const where = `WHERE ($1::boolean IS NULL OR y.is_active = $1)`;
        const total = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM school_years y ${where}`,
          [query.isActive ?? null],
        );
        const rows = await tx.query<YearRow>(
          `${YEAR_SELECT} ${where} ORDER BY y.starts_on DESC, y.id LIMIT $2 OFFSET $3`,
          [query.isActive ?? null, query.pageSize, (query.page - 1) * query.pageSize],
        );
        return {
          ok: true as const,
          value: {
            items: rows.rows.map((r) => yearDto(r, today)),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          },
        };
      });
    },

    async getSchoolYear(ctx: ActorContext, id: string): Promise<CatalogResult<SchoolYearDto>> {
      if (!needs(ctx, 'catalog:read')) {
        await denied(ctx, 'catalog.school_years.get');
        return fail('FORBIDDEN', 'No tiene permiso para consultar el catálogo escolar');
      }
      return store.transaction(async (tx) => {
        const row = await loadYear(tx, id);
        if (!row) return fail('NOT_FOUND', 'Ciclo escolar no encontrado');
        return { ok: true as const, value: yearDto(row, await todayOf(tx)) };
      });
    },

    async createSchoolYear(
      ctx: ActorContext,
      body: CreateSchoolYearBody,
    ): Promise<CatalogResult<SchoolYearDto>> {
      if (!needs(ctx, 'catalog:manage_school')) {
        await denied(ctx, 'catalog.school_years.create');
        return fail('FORBIDDEN', 'No tiene permiso para administrar el catálogo escolar');
      }
      try {
        return await store.transaction(async (tx) => {
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO school_years (name, starts_on, ends_on) VALUES ($1, $2::date, $3::date) RETURNING id`,
            [body.name, body.startsOn, body.endsOn],
          );
          const id = inserted.rows[0]!.id;
          await audit(tx, ctx, 'school_year.created', {
            id,
            name: body.name,
            startsOn: body.startsOn,
            endsOn: body.endsOn,
          });
          return {
            ok: true as const,
            value: yearDto((await loadYear(tx, id))!, await todayOf(tx)),
          };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },

    async updateSchoolYear(
      ctx: ActorContext,
      id: string,
      body: UpdateSchoolYearBody,
    ): Promise<CatalogResult<SchoolYearDto>> {
      if (!needs(ctx, 'catalog:manage_school')) {
        await denied(ctx, 'catalog.school_years.update');
        return fail('FORBIDDEN', 'No tiene permiso para administrar el catálogo escolar');
      }
      try {
        return await store.transaction(async (tx) => {
          const row = await loadYear(tx, id, true);
          if (!row) return fail('NOT_FOUND', 'Ciclo escolar no encontrado');
          const today = await todayOf(tx);
          if (row.ends_on < today) {
            return fail('HISTORICAL', 'El ciclo ya terminó: es historial y no se modifica');
          }
          const next = {
            name: body.name ?? row.name,
            startsOn: body.startsOn ?? row.starts_on,
            endsOn: body.endsOn ?? row.ends_on,
          };
          const changed =
            next.name !== row.name ||
            next.startsOn !== row.starts_on ||
            next.endsOn !== row.ends_on;
          if (!changed) return { ok: true as const, value: yearDto(row, today) };
          const problem = lengthProblem(next.startsOn, next.endsOn);
          if (problem) return fail('VALIDATION', problem);
          if (row.is_active && (next.startsOn > today || next.endsOn < today)) {
            return fail('VALIDATION', 'El ciclo vigente debe incluir la fecha de hoy');
          }
          await tx.query(
            `UPDATE school_years SET name = $2, starts_on = $3::date, ends_on = $4::date WHERE id = $1`,
            [id, next.name, next.startsOn, next.endsOn],
          );
          await audit(tx, ctx, 'school_year.updated', {
            id,
            before: { name: row.name, startsOn: row.starts_on, endsOn: row.ends_on },
            after: next,
          });
          return { ok: true as const, value: yearDto((await loadYear(tx, id))!, today) };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },

    /** Activa el ciclo que incluye hoy y desactiva el vigente anterior (una sola vigencia, sin huecos intermedios). */
    async activateSchoolYear(ctx: ActorContext, id: string): Promise<CatalogResult<SchoolYearDto>> {
      if (!needs(ctx, 'catalog:manage_school')) {
        await denied(ctx, 'catalog.school_years.activate');
        return fail('FORBIDDEN', 'No tiene permiso para administrar el catálogo escolar');
      }
      try {
        return await store.transaction(async (tx) => {
          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtextextended('eta15.school_year.active', 0))`,
          );
          const row = await loadYear(tx, id, true);
          if (!row) return fail('NOT_FOUND', 'Ciclo escolar no encontrado');
          const today = await todayOf(tx);
          if (row.is_active) return { ok: true as const, value: yearDto(row, today) };
          if (today < row.starts_on || today > row.ends_on) {
            return fail(
              'VALIDATION',
              'Solo puede activarse el ciclo que incluye la fecha de hoy (puede crear ciclos futuros y activarlos cuando empiecen)',
            );
          }
          const previous = await tx.query<{ id: string }>(
            `UPDATE school_years SET is_active = false WHERE is_active AND id <> $1 RETURNING id`,
            [id],
          );
          await tx.query(`UPDATE school_years SET is_active = true WHERE id = $1`, [id]);
          await audit(tx, ctx, 'school_year.activated', {
            id,
            name: row.name,
            previousId: previous.rows[0]?.id ?? null,
          });
          return { ok: true as const, value: yearDto((await loadYear(tx, id))!, today) };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },

    async deactivateSchoolYear(
      ctx: ActorContext,
      id: string,
    ): Promise<CatalogResult<SchoolYearDto>> {
      if (!needs(ctx, 'catalog:manage_school')) {
        await denied(ctx, 'catalog.school_years.deactivate');
        return fail('FORBIDDEN', 'No tiene permiso para administrar el catálogo escolar');
      }
      try {
        return await store.transaction(async (tx) => {
          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtextextended('eta15.school_year.active', 0))`,
          );
          const row = await loadYear(tx, id, true);
          if (!row) return fail('NOT_FOUND', 'Ciclo escolar no encontrado');
          const today = await todayOf(tx);
          if (!row.is_active) return { ok: true as const, value: yearDto(row, today) };
          await tx.query(`UPDATE school_years SET is_active = false WHERE id = $1`, [id]);
          await audit(tx, ctx, 'school_year.deactivated', { id, name: row.name });
          return { ok: true as const, value: yearDto((await loadYear(tx, id))!, today) };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },

    // ----------------------------------------------------------------------------------------------- grupos
    async listGroups(ctx: ActorContext, query: ListGroupsQuery): Promise<CatalogResult<GroupList>> {
      if (!needs(ctx, 'catalog:read')) {
        await denied(ctx, 'catalog.groups.list');
        return fail('FORBIDDEN', 'No tiene permiso para consultar el catálogo escolar');
      }
      const where = `
        WHERE ($1::uuid IS NULL OR g.school_year_id = $1)
          AND ($2::int IS NULL OR g.grade = $2)
          AND ($3::text IS NULL OR ($3 = 'none' AND g.shift IS NULL) OR g.shift = $3)
          AND ($4::boolean IS NULL OR g.is_active = $4)
          AND ($5::text IS NULL OR g.code LIKE '%' || $5 || '%' ESCAPE '\\')`;
      const params = [
        query.schoolYearId ?? null,
        query.grade ?? null,
        query.shift ?? null,
        query.isActive ?? null,
        query.q ? escapeLike(query.q) : null,
      ];
      return store.transaction(async (tx) => {
        const today = await todayOf(tx);
        const total = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM groups g ${where}`,
          params,
        );
        const rows = await tx.query<GroupRow>(
          `${GROUP_SELECT} ${where}
            ORDER BY y.starts_on DESC, g.grade, g.code, g.shift NULLS FIRST, g.id LIMIT $6 OFFSET $7`,
          [...params, query.pageSize, (query.page - 1) * query.pageSize],
        );
        return {
          ok: true as const,
          value: {
            items: rows.rows.map((r) => groupDto(r, today)),
            page: query.page,
            pageSize: query.pageSize,
            total: total.rows[0]!.n,
          },
        };
      });
    },

    async getGroup(ctx: ActorContext, id: string): Promise<CatalogResult<GroupDto>> {
      if (!needs(ctx, 'catalog:read')) {
        await denied(ctx, 'catalog.groups.get');
        return fail('FORBIDDEN', 'No tiene permiso para consultar el catálogo escolar');
      }
      return store.transaction(async (tx) => {
        const row = await loadGroup(tx, id);
        if (!row) return fail('NOT_FOUND', 'Grupo no encontrado');
        return { ok: true as const, value: groupDto(row, await todayOf(tx)) };
      });
    },

    async createGroup(ctx: ActorContext, body: CreateGroupBody): Promise<CatalogResult<GroupDto>> {
      if (!needs(ctx, 'catalog:manage_school')) {
        await denied(ctx, 'catalog.groups.create');
        return fail('FORBIDDEN', 'No tiene permiso para administrar el catálogo escolar');
      }
      try {
        return await store.transaction(async (tx) => {
          const year = await loadYear(tx, body.schoolYearId, true);
          if (!year) return fail('VALIDATION', 'El ciclo escolar indicado no existe');
          const today = await todayOf(tx);
          if (year.ends_on < today) {
            return fail(
              'HISTORICAL',
              'El ciclo ya terminó: no se crean grupos en un ciclo histórico',
            );
          }
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO groups (school_year_id, grade, code, shift, expected_entry_time)
             VALUES ($1, $2, $3, $4, $5::time) RETURNING id`,
            [body.schoolYearId, body.grade, body.code, body.shift, body.expectedEntryTime],
          );
          const id = inserted.rows[0]!.id;
          await audit(tx, ctx, 'group.created', {
            id,
            schoolYearId: body.schoolYearId,
            grade: body.grade,
            code: body.code,
            shift: body.shift,
            expectedEntryTime: body.expectedEntryTime ? body.expectedEntryTime.slice(0, 5) : null,
          });
          return { ok: true as const, value: groupDto((await loadGroup(tx, id))!, today) };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },

    async updateGroup(
      ctx: ActorContext,
      id: string,
      body: UpdateGroupBody,
    ): Promise<CatalogResult<GroupDto>> {
      if (!needs(ctx, 'catalog:manage_school')) {
        await denied(ctx, 'catalog.groups.update');
        return fail('FORBIDDEN', 'No tiene permiso para administrar el catálogo escolar');
      }
      try {
        return await store.transaction(async (tx) => {
          const row = await loadGroup(tx, id, true);
          if (!row) return fail('NOT_FOUND', 'Grupo no encontrado');
          const today = await todayOf(tx);
          if (row.year_ends_on < today) {
            return fail(
              'HISTORICAL',
              'El ciclo ya terminó: sus grupos son historial y no se modifican',
            );
          }
          const before = {
            code: row.code,
            shift: row.shift,
            expectedEntryTime: row.expected_entry_time ? row.expected_entry_time.slice(0, 5) : null,
            isActive: row.is_active,
          };
          const after = {
            code: body.code ?? before.code,
            shift: body.shift === undefined ? before.shift : body.shift,
            expectedEntryTime:
              body.expectedEntryTime === undefined
                ? before.expectedEntryTime
                : body.expectedEntryTime === null
                  ? null
                  : body.expectedEntryTime.slice(0, 5),
            isActive: body.isActive ?? before.isActive,
          };
          const changes = (Object.keys(after) as Array<keyof typeof after>).filter(
            (k) => after[k] !== before[k],
          );
          if (changes.length === 0) return { ok: true as const, value: groupDto(row, today) };
          await tx.query(
            `UPDATE groups SET code = $2, shift = $3, expected_entry_time = $4::time, is_active = $5 WHERE id = $1`,
            [id, after.code, after.shift, after.expectedEntryTime, after.isActive],
          );
          await audit(tx, ctx, 'group.updated', { id, changed: changes, before, after });
          return { ok: true as const, value: groupDto((await loadGroup(tx, id))!, today) };
        });
      } catch (error) {
        return mapDbError(error);
      }
    },
  };
}

export type SchoolCatalogService = ReturnType<typeof createSchoolCatalogService>;
