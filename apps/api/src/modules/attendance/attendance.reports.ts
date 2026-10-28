/**
 * Reportes basicos de asistencia (SOLO LECTURA). Consultas puras sobre una transaccion ya abierta por el servicio (foto
 * REPEATABLE READ, "hoy" y acceso ya resueltos). Ver docs/architecture/reportes-asistencia.md.
 *
 *  - Unica fuente de marcas: `attendance_records` (canonica). `attendance_events` NO se consulta: los recibos de idempotencia
 *    (`mark_changed` con old = new) y cualquier otro evento jamas cuentan como marca.
 *  - El alcance (`all` / `assigned_groups`) se aplica EN LA CONSULTA (`group_id = ANY(...)`); un recurso fuera de alcance es
 *    indistinguible de uno inexistente (`missing`).
 *  - Sin escrituras, sin auditoria de lectura, sin nombres en logs. Parametros siempre enlazados ($n), nunca concatenados.
 *  - Nada se infiere: sin lista != ausencia, sin marca != ausencia, fuera del padron != ausencia, y no hay porcentajes ni
 *    justificantes (decision D-10 pendiente).
 */
import {
  type AttendanceDayStatus,
  type AttendanceGroupReport,
  type AttendanceGroupReportQuery,
  type AttendanceReportOptions,
  type AttendanceReportStudentOptions,
  type AttendanceStudentReport,
  type AttendanceStudentReportQuery,
  type GroupReportDayDto,
  type GroupReportStudentDto,
  type ReportGroupDto,
  type ReportSchoolYearDto,
  type Shift,
  type StudentReportDayDto,
  type StudentReportGroupDto,
  type StudentReportState,
} from '@eta15/shared-contracts';
import type { Access } from '../access-control/authorize.js';
import type { SqlClient } from '../auth/session-service.js';

export type ReportOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string; message: string };

export const ok = <T>(value: T): ReportOutcome<T> => ({ kind: 'ok', value });
const missing = { kind: 'missing' } as const;

/** Dias habiles (lunes a viernes) entre dos fechas de calendario ISO, inclusivas, en orden ascendente. */
export function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

interface GroupRow {
  group_id: string;
  school_year_id: string;
  year_name: string;
  year_starts_on: string;
  year_ends_on: string;
  grade: number;
  code: string;
  shift: string | null;
  is_active: boolean;
}

const GROUP_COLUMNS = `g.id AS group_id, g.school_year_id, y.name AS year_name, y.starts_on::text AS year_starts_on,
       y.ends_on::text AS year_ends_on, g.grade, g.code, g.shift, g.is_active`;

const groupDto = (r: GroupRow): ReportGroupDto => ({
  id: r.group_id,
  schoolYearId: r.school_year_id,
  schoolYearName: r.year_name,
  grade: r.grade,
  code: r.code,
  shift: r.shift as Shift | null,
  isActive: r.is_active,
});

const yearDto = (r: GroupRow): ReportSchoolYearDto => ({
  id: r.school_year_id,
  name: r.year_name,
  startsOn: r.year_starts_on,
  endsOn: r.year_ends_on,
});

/** Rango dentro del ciclo y sin fechas futuras (segun el "hoy" del servidor). null = valido. */
function rangeProblem(
  year: ReportSchoolYearDto,
  range: { from: string; to: string },
  today: string,
): ReportOutcome<never> | null {
  if (range.from < year.startsOn || range.to > year.endsOn)
    return {
      kind: 'invalid',
      reason: 'RANGE_OUT_OF_YEAR',
      message: 'El periodo debe estar dentro del ciclo escolar',
    };
  if (range.to > today)
    return {
      kind: 'invalid',
      reason: 'RANGE_IN_FUTURE',
      message: 'El periodo no puede incluir fechas posteriores a hoy',
    };
  return null;
}

/** Alcance en SQL: `all` sin filtro; `groups` con la lista de grupos autorizados (vacia = nada). */
function scopeFilter(
  access: Access,
  column: string,
  params: unknown[],
): { sql: string; none: boolean } {
  if (access.kind === 'groups') {
    if (access.groupIds.size === 0) return { sql: 'FALSE', none: true };
    params.push([...access.groupIds].sort());
    return { sql: `${column} = ANY($${params.length}::uuid[])`, none: false };
  }
  return { sql: 'TRUE', none: false };
}

export async function reportOptions(
  tx: SqlClient,
  access: Access,
  today: string,
): Promise<AttendanceReportOptions> {
  const params: unknown[] = [];
  const scope = scopeFilter(access, 'g.id', params);
  const empty: AttendanceReportOptions = { schoolToday: today, schoolYears: [] };
  if (scope.none) return empty;
  const rows = await tx.query<GroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM groups g JOIN school_years y ON y.id = g.school_year_id
      WHERE ${scope.sql} ORDER BY y.starts_on DESC, y.id, g.grade, g.code, g.id`,
    params,
  );
  const years = new Map<string, AttendanceReportOptions['schoolYears'][number]>();
  for (const r of rows.rows) {
    let y = years.get(r.school_year_id);
    if (!y) years.set(r.school_year_id, (y = { ...yearDto(r), groups: [] }));
    y.groups.push(groupDto(r));
  }
  return { schoolToday: today, schoolYears: [...years.values()] };
}

async function loadGroup(tx: SqlClient, access: Access, groupId: string): Promise<GroupRow | null> {
  const params: unknown[] = [groupId];
  const scope = scopeFilter(access, 'g.id', params);
  if (scope.none) return null;
  const r = await tx.query<GroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM groups g JOIN school_years y ON y.id = g.school_year_id
      WHERE g.id = $1 AND ${scope.sql}`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function reportGroupStudents(
  tx: SqlClient,
  access: Access,
  groupId: string,
): Promise<ReportOutcome<AttendanceReportStudentOptions>> {
  const group = await loadGroup(tx, access, groupId);
  if (!group) return missing;
  const r = await tx.query<{ id: string; given_names: string; family_name: string }>(
    `SELECT s.id, s.given_names, s.family_name
       FROM students s
      WHERE s.id IN (SELECT e.student_id
                       FROM student_group_assignments a JOIN enrollments e ON e.id = a.enrollment_id
                      WHERE a.group_id = $1)
      ORDER BY s.family_name, s.given_names, s.id`,
    [groupId],
  );
  return ok({
    group: groupDto(group),
    students: r.rows.map((s) => ({
      studentId: s.id,
      givenNames: s.given_names,
      familyName: s.family_name,
    })),
  });
}

export async function groupReport(
  tx: SqlClient,
  access: Access,
  today: string,
  query: AttendanceGroupReportQuery,
  generatedAt: Date,
): Promise<ReportOutcome<AttendanceGroupReport>> {
  const group = await loadGroup(tx, access, query.groupId);
  if (!group || (query.schoolYearId && query.schoolYearId !== group.school_year_id)) return missing;
  const year = yearDto(group);
  const range = { from: query.from, to: query.to };
  const problem = rangeProblem(year, range, today);
  if (problem) return problem;

  const lists = await tx.query<{
    id: string;
    attendance_date: string;
    status: AttendanceDayStatus;
    total: number;
    present: number;
    absent: number;
    pending: number;
  }>(
    `SELECT d.id, d.attendance_date::text AS attendance_date, d.status, c.total, c.present, c.absent, c.pending
       FROM attendance_days d
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS total,
               (count(*) FILTER (WHERE r.status = 'present'))::int AS present,
               (count(*) FILTER (WHERE r.status = 'absent'))::int AS absent,
               (count(*) FILTER (WHERE r.status IS NULL))::int AS pending
          FROM attendance_records r WHERE r.attendance_day_id = d.id) c
      WHERE d.group_id = $1 AND d.attendance_date BETWEEN $2::date AND $3::date
      ORDER BY d.attendance_date`,
    [group.group_id, range.from, range.to],
  );
  const students = await tx.query<{
    id: string;
    given_names: string;
    family_name: string;
    applicable: number;
    present: number;
    absent: number;
    pending: number;
  }>(
    `SELECT s.id, s.given_names, s.family_name, count(*)::int AS applicable,
            (count(*) FILTER (WHERE r.status = 'present'))::int AS present,
            (count(*) FILTER (WHERE r.status = 'absent'))::int AS absent,
            (count(*) FILTER (WHERE r.status IS NULL))::int AS pending
       FROM attendance_records r
       JOIN attendance_days d ON d.id = r.attendance_day_id
       JOIN enrollments e ON e.id = r.enrollment_id
       JOIN students s ON s.id = e.student_id
      WHERE d.group_id = $1 AND d.attendance_date BETWEEN $2::date AND $3::date
      GROUP BY s.id, s.given_names, s.family_name
      ORDER BY s.family_name, s.given_names, s.id`,
    [group.group_id, range.from, range.to],
  );

  const byDate = new Map(lists.rows.map((l) => [l.attendance_date, l]));
  const days: GroupReportDayDto[] = weekdaysBetween(range.from, range.to).map((date) => {
    const l = byDate.get(date);
    return {
      date,
      list: l
        ? {
            dayId: l.id,
            status: l.status,
            rosterSize: l.total,
            present: l.present,
            absent: l.absent,
            noMark: l.pending,
          }
        : null,
    };
  });
  const totals = {
    weekdays: days.length,
    withList: 0,
    draft: 0,
    finalized: 0,
    withoutList: 0,
    studentDays: 0,
    present: 0,
    absent: 0,
    noMark: 0,
  };
  for (const d of days) {
    if (!d.list) {
      totals.withoutList += 1;
      continue;
    }
    totals.withList += 1;
    if (d.list.status === 'draft') totals.draft += 1;
    else totals.finalized += 1;
    totals.studentDays += d.list.rosterSize;
    totals.present += d.list.present;
    totals.absent += d.list.absent;
    totals.noMark += d.list.noMark;
  }
  const studentRows: GroupReportStudentDto[] = students.rows.map((s) => ({
    studentId: s.id,
    givenNames: s.given_names,
    familyName: s.family_name,
    listsApplicable: s.applicable,
    present: s.present,
    absent: s.absent,
    noMark: s.pending,
  }));
  return ok({
    generatedAt: generatedAt.toISOString(),
    schoolToday: today,
    group: groupDto(group),
    schoolYear: year,
    period: range,
    days,
    students: studentRows,
    totals,
  });
}

export async function studentReport(
  tx: SqlClient,
  access: Access,
  today: string,
  studentId: string,
  query: AttendanceStudentReportQuery,
  generatedAt: Date,
): Promise<ReportOutcome<AttendanceStudentReport>> {
  if (access.kind !== 'all' && access.kind !== 'groups') return missing;
  const enr = await tx.query<{
    enrollment_id: string;
    enrollment_starts_on: string;
    enrollment_ends_on: string | null;
    student_id: string;
    given_names: string;
    family_name: string;
    school_code: string | null;
    school_year_id: string;
    year_name: string;
    year_starts_on: string;
    year_ends_on: string;
  }>(
    `SELECT e.id AS enrollment_id, e.starts_on::text AS enrollment_starts_on, e.ends_on::text AS enrollment_ends_on,
            s.id AS student_id, s.given_names, s.family_name, s.school_code,
            y.id AS school_year_id, y.name AS year_name, y.starts_on::text AS year_starts_on, y.ends_on::text AS year_ends_on
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       JOIN school_years y ON y.id = e.school_year_id
      WHERE e.student_id = $1 AND e.school_year_id = $2`,
    [studentId, query.schoolYearId],
  );
  const e = enr.rows[0];
  if (!e) return missing;

  // Pertenencias al grupo del ciclo, YA filtradas por alcance. Con alcance de grupos, sin ninguna en alcance el alumno "no existe".
  const params: unknown[] = [e.enrollment_id];
  const scope = scopeFilter(access, 'a.group_id', params);
  if (scope.none) return missing;
  const assignments = await tx.query<GroupRow & { starts_on: string; ends_on: string | null }>(
    `SELECT ${GROUP_COLUMNS}, a.starts_on::text AS starts_on, a.ends_on::text AS ends_on
       FROM student_group_assignments a
       JOIN groups g ON g.id = a.group_id
       JOIN school_years y ON y.id = g.school_year_id
      WHERE a.enrollment_id = $1 AND ${scope.sql}
      ORDER BY a.starts_on, a.id`,
    params,
  );
  if (access.kind === 'groups' && assignments.rows.length === 0) return missing;

  const year: ReportSchoolYearDto = {
    id: e.school_year_id,
    name: e.year_name,
    startsOn: e.year_starts_on,
    endsOn: e.year_ends_on,
  };
  const range = { from: query.from, to: query.to };
  const problem = rangeProblem(year, range, today);
  if (problem) return problem;

  const groupsById = new Map<string, ReportGroupDto>();
  for (const a of assignments.rows) groupsById.set(a.group_id, groupDto(a));
  const groupIds = [...groupsById.keys()].sort();

  const recParams: unknown[] = [e.enrollment_id, range.from, range.to];
  const recScope = scopeFilter(access, 'd.group_id', recParams);
  const records = await tx.query<{
    day_id: string;
    attendance_date: string;
    day_status: AttendanceDayStatus;
    group_id: string;
    status: 'present' | 'absent' | null;
  }>(
    `SELECT d.id AS day_id, d.attendance_date::text AS attendance_date, d.status AS day_status, d.group_id, r.status
       FROM attendance_records r JOIN attendance_days d ON d.id = r.attendance_day_id
      WHERE r.enrollment_id = $1 AND d.attendance_date BETWEEN $2::date AND $3::date AND ${recScope.sql}`,
    recParams,
  );
  const recByDate = new Map(records.rows.map((r) => [r.attendance_date, r]));
  const listRows =
    groupIds.length === 0
      ? []
      : (
          await tx.query<{
            day_id: string;
            group_id: string;
            attendance_date: string;
            status: AttendanceDayStatus;
          }>(
            `SELECT d.id AS day_id, d.group_id, d.attendance_date::text AS attendance_date, d.status
               FROM attendance_days d
              WHERE d.group_id = ANY($1::uuid[]) AND d.attendance_date BETWEEN $2::date AND $3::date`,
            [groupIds, range.from, range.to],
          )
        ).rows;
  const listByKey = new Map(listRows.map((l) => [`${l.group_id}|${l.attendance_date}`, l]));

  const enrolledOn = (date: string) =>
    date >= e.enrollment_starts_on &&
    (e.enrollment_ends_on === null || date <= e.enrollment_ends_on);
  const days: StudentReportDayDto[] = weekdaysBetween(range.from, range.to).map((date) => {
    const rec = recByDate.get(date);
    if (rec) {
      const state: StudentReportState =
        rec.status === 'present' ? 'present' : rec.status === 'absent' ? 'absent' : 'no_mark';
      return {
        date,
        state,
        group: groupsById.get(rec.group_id) ?? null,
        listStatus: rec.day_status,
        dayId: rec.day_id,
      };
    }
    const member = enrolledOn(date)
      ? assignments.rows.find(
          (a) => date >= a.starts_on && (a.ends_on === null || date <= a.ends_on),
        )
      : undefined;
    if (!member) return { date, state: 'not_in_group', group: null, listStatus: null, dayId: null };
    const list = listByKey.get(`${member.group_id}|${date}`);
    return {
      date,
      state: list ? 'not_in_roster' : 'no_list',
      group: groupsById.get(member.group_id) ?? null,
      listStatus: list ? list.status : null,
      dayId: list ? list.day_id : null,
    };
  });

  const count = (s: StudentReportState) => days.filter((d) => d.state === s).length;
  const present = count('present');
  const absent = count('absent');
  const noMark = count('no_mark');
  const groups: StudentReportGroupDto[] = assignments.rows.map((a) => ({
    group: groupDto(a),
    startsOn: a.starts_on,
    endsOn: a.ends_on,
  }));
  return ok({
    generatedAt: generatedAt.toISOString(),
    schoolToday: today,
    student: {
      id: e.student_id,
      givenNames: e.given_names,
      familyName: e.family_name,
      schoolCode: access.kind === 'all' ? e.school_code : null,
    },
    schoolYear: year,
    enrollment: { startsOn: e.enrollment_starts_on, endsOn: e.enrollment_ends_on },
    groups,
    period: range,
    days,
    totals: {
      weekdays: days.length,
      present,
      absent,
      noMark,
      noList: count('no_list'),
      notInRoster: count('not_in_roster'),
      notInGroup: count('not_in_group'),
      listsApplicable: present + absent + noMark,
    },
  });
}
