import type { AttendanceGroupReport } from '@eta15/shared-contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BTN_PRIMARY, FIELD } from '../../components/form';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { formatLongDay, groupLabel } from '../asistencia/shared';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import {
  DEFAULT_SORT,
  SORT_LABELS,
  buildRows,
  isFollowupSort,
  sortRows,
  summarize,
  totalsAreConsistent,
  type FollowupSort,
} from './followup';
import {
  LoadingOrError,
  NoAccess,
  PeriodFields,
  ReportLimits,
  ReportTabs,
  Stat,
  YearGroupFields,
  defaultPeriod,
  periodProblem,
  reportErrorMessage,
  useReportOptions,
  yearDefault,
} from './shared';

/** Aclaracion obligatoria y siempre visible junto a los conteos. */
export const FOLLOWUP_NOTICE =
  'Los conteos reflejan únicamente ausencias registradas. No incluyen reglas de justificantes ni representan alertas oficiales.';

/**
 * Seguimiento de ausencias REGISTRADAS (solo lectura) por grupo y periodo. Reutiliza el reporte por grupo (mismo endpoint, mismo
 * permiso `attendance:read` y alcance): solo reordena y describe lo que el servidor ya conto. No hay umbrales, porcentajes, niveles
 * de riesgo, alertas, notificaciones ni acciones (sancionar, justificar, corregir). Los justificantes recibidos NO descuentan nada.
 * Los filtros viven en la URL para poder volver desde el reporte individual sin perderlos.
 */
export function FollowupPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const allowed = me ? permissionsOf(me).canViewAttendance : false;
  const { options, error, loading, retry } = useReportOptions(allowed);
  const [params, setParams] = useSearchParams();
  const sortId = useId();

  const [yearId, setYearId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<FollowupSort>(() => {
    const s = params.get('orden');
    return isFollowupSort(s) ? s : DEFAULT_SORT;
  });
  const [initialized, setInitialized] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [report, setReport] = useState<AttendanceGroupReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const ticket = useRef(0);
  const autoRun = useRef(false);

  if (options && !initialized) {
    const wanted = options.schoolYears.find((s) => s.id === params.get('ciclo'));
    const y = wanted ?? options.schoolYears.find((s) => s.id === yearDefault(options));
    if (y) {
      const p = defaultPeriod(y, options.schoolToday);
      const g = wanted ? y.groups.find((x) => x.id === params.get('grupo')) : undefined;
      setYearId(y.id);
      setGroupId(g?.id ?? '');
      setFrom(g ? (params.get('desde') ?? p.from) : p.from);
      setTo(g ? (params.get('hasta') ?? p.to) : p.to);
      autoRun.current = Boolean(g);
    }
    setInitialized(true);
  }

  const year = options?.schoolYears.find((y) => y.id === yearId);

  async function run(gid: string, f: string, t: string) {
    if (!options) return;
    const p = periodProblem(year, options.schoolToday, f, t);
    setProblem(p);
    if (p) return;
    const mine = ++ticket.current;
    setRunning(true);
    setRunError(null);
    setReport(null);
    try {
      const r = await api.attendanceGroupReport({
        groupId: gid,
        schoolYearId: yearId,
        from: f,
        to: t,
      });
      if (mine === ticket.current) {
        if (!totalsAreConsistent(r))
          setRunError(
            'Los totales recibidos no coinciden entre sí, así que no se muestran. Vuelve a intentarlo.',
          );
        else setReport(r);
      }
    } catch (err) {
      if (mine === ticket.current)
        setRunError(reportErrorMessage(err, 'No se pudo generar el seguimiento.'));
    } finally {
      if (mine === ticket.current) setRunning(false);
    }
  }

  // Llegada con filtros en la URL (p. ej. al volver del reporte individual): se genera una sola vez.
  useEffect(() => {
    if (autoRun.current && options && groupId) {
      autoRun.current = false;
      void run(groupId, from, to);
    }
  }, [options, groupId]);

  if (!me) return null;
  if (!allowed) return <NoAccess title="Seguimiento de ausencias" />;

  function clearResult() {
    ticket.current += 1; // una respuesta en vuelo de la seleccion anterior ya no se muestra
    setReport(null);
    setRunError(null);
    setRunning(false);
  }
  function changeYear(id: string) {
    const y = options?.schoolYears.find((s) => s.id === id);
    setYearId(id);
    setGroupId('');
    setProblem(null);
    if (y && options) {
      const p = defaultPeriod(y, options.schoolToday);
      setFrom(p.from);
      setTo(p.to);
    }
    clearResult();
  }
  function changeSort(value: string) {
    const next = isFollowupSort(value) ? value : DEFAULT_SORT;
    setSort(next);
    const q = new URLSearchParams(params);
    q.set('orden', next);
    setParams(q, { replace: true });
  }
  function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!options) return;
    if (!groupId) {
      setProblem('Elige un grupo.');
      return;
    }
    setParams(
      new URLSearchParams({ ciclo: yearId, grupo: groupId, desde: from, hasta: to, orden: sort }),
      { replace: true },
    );
    void run(groupId, from, to);
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Seguimiento de ausencias</h1>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Consulta de solo lectura de las ausencias registradas en las listas de un grupo durante un
        periodo. Solo ves los grupos a los que tienes acceso.
      </p>
      <p
        role="note"
        className="mt-3 max-w-prose rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800"
      >
        {FOLLOWUP_NOTICE}
      </p>
      <ReportTabs />
      <LoadingOrError loading={loading && !options} error={error} retry={retry} />

      {options && options.schoolYears.length === 0 && (
        <p role="status" className="mt-6 text-slate-700">
          No tienes grupos disponibles para consultar. Si debería haber alguno, avisa a Dirección.
        </p>
      )}

      {options && options.schoolYears.length > 0 && (
        <form
          onSubmit={generate}
          aria-label="Filtros del seguimiento de ausencias"
          noValidate
          className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <YearGroupFields
            options={options}
            yearId={yearId}
            groupId={groupId}
            onYear={changeYear}
            onGroup={(id) => {
              setGroupId(id);
              setProblem(null);
              clearResult();
            }}
          />
          <PeriodFields
            year={year}
            today={options.schoolToday}
            from={from}
            to={to}
            onFrom={(v) => {
              setFrom(v);
              setProblem(null);
              clearResult();
            }}
            onTo={(v) => {
              setTo(v);
              setProblem(null);
              clearResult();
            }}
            error={problem}
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className={BTN_PRIMARY} disabled={running} aria-busy={running}>
              {running ? 'Consultando…' : 'Consultar seguimiento'}
            </button>
          </div>
        </form>
      )}

      {runError && (
        <div className="mt-4">
          <ErrorNotice message={runError} />
        </div>
      )}
      {running && (
        <p role="status" className="mt-4 text-slate-700">
          Consultando el seguimiento…
        </p>
      )}
      {report && (
        <FollowupView
          report={report}
          sort={sort}
          sortId={sortId}
          onSort={changeSort}
          backSearch={params.toString()}
        />
      )}
      {options && options.schoolYears.length > 0 && <ReportLimits />}
    </section>
  );
}

function FollowupView(props: {
  report: AttendanceGroupReport;
  sort: FollowupSort;
  sortId: string;
  onSort: (value: string) => void;
  backSearch: string;
}) {
  const { report } = props;
  const summary = summarize(report);
  const rows = sortRows(buildRows(report), props.sort);
  const studentLink = (id: string) =>
    `/asistencia/reportes/alumno?${new URLSearchParams({
      ciclo: report.schoolYear.id,
      grupo: report.group.id,
      alumno: id,
      desde: report.period.from,
      hasta: report.period.to,
    }).toString()}`;
  const complete = summary.gaps.length === 0;

  return (
    <div className="mt-8" role="region" aria-label="Resultado del seguimiento de ausencias">
      <h2 className="text-xl font-semibold text-tinto-900">
        {groupLabel(report.group)} · {report.schoolYear.name}
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        Periodo: {formatLongDay(report.period.from)} al {formatLongDay(report.period.to)}.
      </p>

      <div
        className="mt-3 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm"
        aria-label="Estado de los datos del periodo"
        role="group"
      >
        <p className="font-semibold text-slate-900">
          {complete
            ? 'Datos completos: todos los días hábiles del periodo tienen lista finalizada.'
            : 'Datos incompletos para el periodo:'}
        </p>
        {!complete && (
          <ul className="mt-1 list-disc pl-5 text-slate-800">
            {summary.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        )}
      </div>

      <dl
        className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4"
        aria-label="Totales del periodo"
      >
        <Stat label="Días hábiles del periodo" value={summary.weekdays} note="Lunes a viernes" />
        <Stat
          label="Días con lista"
          value={summary.withList}
          note={`${summary.finalized} finalizada(s) · ${summary.draft} en borrador`}
        />
        <Stat label="Días sin lista" value={summary.withoutList} note="No determinado" />
        <Stat label="Ausencias registradas" value={report.totals.absent} />
        <Stat label="Presentes registrados" value={report.totals.present} />
        <Stat label="Registros sin marca" value={report.totals.noMark} />
      </dl>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-lg font-semibold text-tinto-900">
          Alumnos con registros en el periodo
        </h3>
        <div>
          <label htmlFor={props.sortId} className="block text-sm font-semibold text-slate-800">
            Ordenar por
          </label>
          <select
            id={props.sortId}
            value={props.sort}
            onChange={(e) => props.onSort(e.target.value)}
            className={`${FIELD} mt-1 min-w-64`}
          >
            {(Object.keys(SORT_LABELS) as FollowupSort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p role="status" className="mt-3 text-slate-700">
          Ninguna lista del periodo incluye alumnos: no hay marcas que contar. Solo aparecen los
          alumnos que están en el padrón de alguna lista; no se infiere a nadie más.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">
              Ausencias registradas por alumno, ordenadas por{' '}
              {SORT_LABELS[props.sort].toLowerCase()}
            </caption>
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="py-2 pr-4">
                  Alumno
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Ausencias registradas
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Presentes registrados
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Sin marca
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Listas que lo incluyen
                </th>
                <th scope="col" className="py-2 pr-4">
                  Estado de los datos
                </th>
                <th scope="col" className="py-2">
                  <span className="sr-only">Detalle</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId} className="border-b border-slate-200 align-top">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {r.familyName} {r.givenNames}
                  </th>
                  <td className="py-2 pr-4 text-right font-semibold">{r.absent}</td>
                  <td className="py-2 pr-4 text-right">{r.present}</td>
                  <td className="py-2 pr-4 text-right">{r.noMark}</td>
                  <td className="py-2 pr-4 text-right">{r.listsApplicable}</td>
                  <td className="py-2 pr-4">
                    {r.gaps.length === 0 ? (
                      <span className="text-slate-700">Completo</span>
                    ) : (
                      <ul className="list-disc pl-4 text-slate-800">
                        {r.gaps.map((g) => (
                          <li key={g}>{g}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="py-2">
                    <Link
                      to={studentLink(r.studentId)}
                      className="font-semibold text-tinto-700 underline"
                    >
                      Ver reporte{' '}
                      <span className="sr-only">
                        de {r.givenNames} {r.familyName}
                      </span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
