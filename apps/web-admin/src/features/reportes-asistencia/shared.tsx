import type {
  AttendanceDayStatus,
  AttendanceReportOptions,
  ReportGroupDto,
  ReportSchoolYearDto,
  StudentReportState,
} from '@eta15/shared-contracts';
import { ATTENDANCE_REPORT_MAX_RANGE_DAYS, inclusiveDaySpan } from '@eta15/shared-contracts';
import { useCallback, useEffect, useId, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { FIELD } from '../../components/form';
import { ApiError, api } from '../../lib/api';
import { attendanceErrorMessage, BADGE, groupLabel } from '../asistencia/shared';
import { ErrorNotice } from '../personal/shared';

/**
 * Piezas comunes de los reportes basicos de asistencia (SOLO LECTURA). El servidor decide la fecha escolar ("hoy"), autoriza cada
 * llamada y aplica el alcance por grupo; aqui solo se presentan los datos. Nada se infiere: sin lista, sin marca, fuera del padron
 * y sin grupo NO son ausencias, y los justificantes no existen todavia (decision D-10 pendiente de la escuela).
 */

export const addDaysIso = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const formatShortDay = (iso: string) => {
  const text = new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const LIST_STATUS_TEXT: Record<AttendanceDayStatus | 'none', string> = {
  none: 'Sin lista',
  draft: 'Borrador',
  finalized: 'Finalizada',
};
export const LIST_STATUS_CLS: Record<AttendanceDayStatus | 'none', string> = {
  none: 'border-slate-500 bg-white text-slate-700',
  draft: 'border-amber-700 bg-amber-50 text-amber-900',
  finalized: 'border-green-700 bg-green-50 text-green-900',
};

/** Situacion de un alumno en un dia habil. Solo "Ausente" es una ausencia registrada. */
export const STATE_TEXT: Record<StudentReportState, string> = {
  present: 'Presente',
  absent: 'Ausente',
  no_mark: 'Sin marca (lista en borrador)',
  no_list: 'Sin lista',
  not_in_roster: 'No estaba en el padrón de la lista',
  not_in_group: 'Sin grupo ese día',
};
export const STATE_CLS: Record<StudentReportState, string> = {
  present: 'border-green-700 bg-green-50 text-green-900',
  absent: 'border-tinto-700 bg-tinto-50 text-tinto-900',
  no_mark: 'border-amber-700 bg-amber-50 text-amber-900',
  no_list: 'border-slate-500 bg-white text-slate-700',
  not_in_roster: 'border-slate-500 bg-white text-slate-700',
  not_in_group: 'border-slate-400 bg-slate-50 text-slate-600',
};

export function StateBadge({ state }: { state: StudentReportState }) {
  return <span className={`${BADGE} ${STATE_CLS[state]}`}>{STATE_TEXT[state]}</span>;
}
export function ListBadge({ status }: { status: AttendanceDayStatus | 'none' }) {
  return <span className={`${BADGE} ${LIST_STATUS_CLS[status]}`}>{LIST_STATUS_TEXT[status]}</span>;
}

/** Limitaciones del reporte: SIEMPRE visibles junto a los resultados (no son un detalle oculto). */
export function ReportLimits() {
  return (
    <aside
      aria-label="Alcance y limitaciones del reporte"
      className="mt-6 rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-800"
    >
      <p className="font-semibold">Qué muestra y qué no muestra este reporte</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          Solo cuenta las marcas registradas en las listas de asistencia. Un día{' '}
          <strong>sin lista</strong> no es una ausencia: no se sabe si hubo clase ni si se tomó
          asistencia.
        </li>
        <li>
          Un alumno <strong>sin marca</strong> (lista en borrador), uno que{' '}
          <strong>no estaba en el padrón</strong> de la lista o uno <strong>sin grupo</strong> ese
          día tampoco cuenta como ausente. Solo «Ausente» es una ausencia registrada.
        </li>
        <li>
          <strong>No incluye justificantes</strong>: la escuela aún no define esa regla, así que
          ninguna ausencia se justifica ni se ajusta.
        </li>
        <li>
          Solo se consideran días de lunes a viernes. No se conocen días festivos ni suspensiones, y
          no se calculan porcentajes ni indicadores oficiales.
        </li>
      </ul>
    </aside>
  );
}

/** Pestanas entre los reportes (enlaces; la ruta activa se marca con aria-current). */
export function ReportTabs() {
  const cls = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm font-semibold ${isActive ? 'bg-tinto-700 text-white' : 'border border-tinto-700 text-tinto-700 hover:bg-tinto-50'}`;
  return (
    <nav aria-label="Reportes de asistencia" className="mt-4 flex flex-wrap gap-2">
      <NavLink to="/asistencia/reportes/grupo" className={cls}>
        Reporte por grupo
      </NavLink>
      <NavLink to="/asistencia/reportes/alumno" className={cls}>
        Reporte por alumno
      </NavLink>
    </nav>
  );
}

/** Mensajes de los reportes. Los rechazos de rango del servidor ya traen un texto claro y sin datos de menores. */
export function reportErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return 'No se encontró el grupo o el alumno, o no tienes acceso a él en ese ciclo.';
    if (error.status === 400) {
      if (error.code === 'RANGE_OUT_OF_YEAR' || error.code === 'RANGE_IN_FUTURE')
        return `${error.message}.`;
      return 'Revisa el ciclo, el grupo y el periodo: los datos enviados no son válidos.';
    }
  }
  return attendanceErrorMessage(error, fallback);
}

/** Validacion previa del periodo (el servidor la repite). Devuelve el mensaje o null. */
export function periodProblem(
  year: ReportSchoolYearDto | undefined,
  today: string,
  from: string,
  to: string,
): string | null {
  if (!from || !to) return 'Indica la fecha de inicio y la de fin del periodo.';
  if (from > to) return 'El inicio del periodo no puede ser posterior al fin.';
  if (inclusiveDaySpan(from, to) > ATTENDANCE_REPORT_MAX_RANGE_DAYS)
    return `El periodo no puede exceder ${ATTENDANCE_REPORT_MAX_RANGE_DAYS} días.`;
  if (year && (from < year.startsOn || to > year.endsOn))
    return 'El periodo debe estar dentro del ciclo escolar.';
  if (to > today) return 'El periodo no puede incluir fechas posteriores a hoy.';
  return null;
}

/** Periodo inicial: los ultimos 30 dias dentro del ciclo y sin pasar de hoy. */
export function defaultPeriod(year: ReportSchoolYearDto, today: string) {
  const to = today < year.endsOn ? today : year.endsOn;
  const earliest = addDaysIso(to, -29);
  return { from: earliest > year.startsOn ? earliest : year.startsOn, to };
}

/** Ciclos y grupos que la persona puede consultar. Reintentable; ignora respuestas de una carga anterior. */
export function useReportOptions(allowed: boolean) {
  const [options, setOptions] = useState<AttendanceReportOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(allowed);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .attendanceReportOptions()
      .then((o) => !cancelled && setOptions(o))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(reportErrorMessage(e, 'No se pudieron cargar los ciclos y grupos.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [allowed, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { options, error, loading, retry };
}

export const yearDefault = (o: AttendanceReportOptions): string => {
  const current = o.schoolYears.find(
    (y) => y.startsOn <= o.schoolToday && o.schoolToday <= y.endsOn,
  );
  return (current ?? o.schoolYears[0])?.id ?? '';
};

export function NoAccess({ title }: { title: string }) {
  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">{title}</h1>
      <p
        role="alert"
        className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
      >
        No tienes permiso para consultar la asistencia.
      </p>
    </section>
  );
}

export function LoadingOrError(props: {
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  if (props.error)
    return (
      <div className="mt-6">
        <ErrorNotice message={props.error} onRetry={props.retry} />
      </div>
    );
  if (props.loading)
    return (
      <p role="status" className="mt-6 text-slate-700">
        Cargando…
      </p>
    );
  return null;
}

interface FilterProps {
  options: AttendanceReportOptions;
  yearId: string;
  groupId: string;
  onYear: (id: string) => void;
  onGroup: (id: string) => void;
}

/** Selectores de ciclo y grupo (solo los que el servidor devolvio para esta cuenta). */
export function YearGroupFields({ options, yearId, groupId, onYear, onGroup }: FilterProps) {
  const ids = { year: useId(), group: useId() };
  const year = options.schoolYears.find((y) => y.id === yearId);
  const groups: ReportGroupDto[] = year?.groups ?? [];
  return (
    <>
      <div>
        <label htmlFor={ids.year} className="block text-sm font-semibold text-slate-800">
          Ciclo escolar
        </label>
        <select
          id={ids.year}
          value={yearId}
          onChange={(e) => onYear(e.target.value)}
          className={FIELD}
        >
          {options.schoolYears.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.group} className="block text-sm font-semibold text-slate-800">
          Grupo
        </label>
        <select
          id={ids.group}
          value={groupId}
          onChange={(e) => onGroup(e.target.value)}
          className={FIELD}
        >
          <option value="">Elige un grupo</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {groupLabel(g)}
              {g.isActive ? '' : ' (inactivo)'}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** Fechas del periodo (inclusivas), acotadas al ciclo y a hoy. */
export function PeriodFields(props: {
  year: ReportSchoolYearDto | undefined;
  today: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  error: string | null;
}) {
  const ids = { from: useId(), to: useId(), err: useId() };
  const max = props.year && props.year.endsOn < props.today ? props.year.endsOn : props.today;
  const invalid = props.error !== null;
  return (
    <>
      <div>
        <label htmlFor={ids.from} className="block text-sm font-semibold text-slate-800">
          Desde
        </label>
        <input
          id={ids.from}
          type="date"
          value={props.from}
          min={props.year?.startsOn}
          max={max}
          onChange={(e) => props.onFrom(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? ids.err : undefined}
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor={ids.to} className="block text-sm font-semibold text-slate-800">
          Hasta
        </label>
        <input
          id={ids.to}
          type="date"
          value={props.to}
          min={props.year?.startsOn}
          max={max}
          onChange={(e) => props.onTo(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? ids.err : undefined}
          className={FIELD}
        />
      </div>
      {props.error && (
        <p id={ids.err} role="alert" className="text-sm text-tinto-700 sm:col-span-2 lg:col-span-4">
          {props.error}
        </p>
      )}
    </>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string;
  note?: string;
}) {
  return (
    <div className="rounded-md border border-tinto-100 p-3">
      <dt className="text-sm text-slate-700">{label}</dt>
      <dd className="mt-1 text-2xl font-bold text-tinto-900">{value}</dd>
      {note && <p className="text-xs text-slate-600">{note}</p>}
    </div>
  );
}
