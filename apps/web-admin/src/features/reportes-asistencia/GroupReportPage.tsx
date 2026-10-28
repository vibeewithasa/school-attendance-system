import type { AttendanceGroupReport } from '@eta15/shared-contracts';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BTN_PRIMARY } from '../../components/form';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { formatLongDay, groupLabel } from '../asistencia/shared';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import {
  ListBadge,
  LoadingOrError,
  NoAccess,
  PeriodFields,
  ReportLimits,
  ReportTabs,
  Stat,
  YearGroupFields,
  defaultPeriod,
  formatShortDay,
  periodProblem,
  reportErrorMessage,
  useReportOptions,
  yearDefault,
} from './shared';

/**
 * Reporte de asistencia por grupo (SOLO LECTURA): ciclo, grupo autorizado y periodo. Por cada dia habil dice si hay lista (borrador
 * o finalizada) y cuantos presentes, ausentes y sin marca; y por alumno las listas del periodo cuyo padron lo incluye. Un dia sin
 * lista NO es una ausencia. El servidor autoriza y aplica el alcance; aqui solo se presenta.
 */
export function GroupReportPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const allowed = me ? permissionsOf(me).canViewAttendance : false;
  const { options, error, loading, retry } = useReportOptions(allowed);

  const [yearId, setYearId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [report, setReport] = useState<AttendanceGroupReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const ticket = useRef(0);

  if (options && !initialized) {
    const y = options.schoolYears.find((s) => s.id === yearDefault(options));
    if (y) {
      const p = defaultPeriod(y, options.schoolToday);
      setYearId(y.id);
      setFrom(p.from);
      setTo(p.to);
    }
    setInitialized(true);
  }

  if (!me) return null;
  if (!allowed) return <NoAccess title="Reporte de asistencia por grupo" />;

  const year = options?.schoolYears.find((y) => y.id === yearId);

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

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!options) return;
    if (!groupId) {
      setProblem('Elige un grupo.');
      return;
    }
    const p = periodProblem(year, options.schoolToday, from, to);
    setProblem(p);
    if (p) return;
    const mine = ++ticket.current;
    setRunning(true);
    setRunError(null);
    setReport(null);
    try {
      const r = await api.attendanceGroupReport({ groupId, schoolYearId: yearId, from, to });
      if (mine === ticket.current) setReport(r);
    } catch (err) {
      if (mine === ticket.current)
        setRunError(reportErrorMessage(err, 'No se pudo generar el reporte.'));
    } finally {
      if (mine === ticket.current) setRunning(false);
    }
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Reporte de asistencia por grupo</h1>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Consulta de solo lectura con las marcas registradas en las listas del grupo durante un
        periodo. Solo ves los grupos a los que tienes acceso.
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
          onSubmit={(e) => void generate(e)}
          aria-label="Filtros del reporte por grupo"
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
              {running ? 'Generando…' : 'Generar reporte'}
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
          Generando el reporte…
        </p>
      )}
      {report && <GroupReportView report={report} />}
      {options && options.schoolYears.length > 0 && <ReportLimits />}
    </section>
  );
}

function GroupReportView({ report }: { report: AttendanceGroupReport }) {
  const t = report.totals;
  const studentLink = (id: string) =>
    `/asistencia/reportes/alumno?${new URLSearchParams({
      ciclo: report.schoolYear.id,
      grupo: report.group.id,
      alumno: id,
      desde: report.period.from,
      hasta: report.period.to,
    }).toString()}`;
  return (
    <div className="mt-8" aria-label="Resultado del reporte por grupo" role="region">
      <h2 className="text-xl font-semibold text-tinto-900">
        {groupLabel(report.group)} · {report.schoolYear.name}
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        Periodo: {formatLongDay(report.period.from)} al {formatLongDay(report.period.to)}. Fecha
        escolar de hoy: {formatLongDay(report.schoolToday)}.
      </p>

      <dl
        className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4"
        aria-label="Totales del periodo"
      >
        <Stat label="Días hábiles del periodo" value={t.weekdays} note="Lunes a viernes" />
        <Stat
          label="Días con lista"
          value={t.withList}
          note={`${t.finalized} finalizada(s) · ${t.draft} en borrador`}
        />
        <Stat label="Días sin lista" value={t.withoutList} note="No determinado; no es ausencia" />
        <Stat label="Registros alumno-día" value={t.studentDays} />
        <Stat label="Presentes" value={t.present} />
        <Stat label="Ausentes" value={t.absent} />
        <Stat label="Sin marca" value={t.noMark} note="Solo en listas en borrador" />
      </dl>

      <h3 className="mt-8 text-lg font-semibold text-tinto-900">Por día</h3>
      {report.days.length === 0 ? (
        <p className="mt-2 text-slate-700">El periodo no incluye días hábiles (lunes a viernes).</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Listas de asistencia del grupo por día hábil</caption>
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="py-2 pr-4">
                  Fecha
                </th>
                <th scope="col" className="py-2 pr-4">
                  Lista
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  En el padrón
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Presentes
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Ausentes
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Sin marca
                </th>
                <th scope="col" className="py-2">
                  <span className="sr-only">Detalle</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {report.days.map((d) => (
                <tr key={d.date} className="border-b border-slate-200">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {formatShortDay(d.date)}
                  </th>
                  <td className="py-2 pr-4">
                    <ListBadge status={d.list ? d.list.status : 'none'} />
                  </td>
                  {d.list ? (
                    <>
                      <td className="py-2 pr-4 text-right">{d.list.rosterSize}</td>
                      <td className="py-2 pr-4 text-right">{d.list.present}</td>
                      <td className="py-2 pr-4 text-right">{d.list.absent}</td>
                      <td className="py-2 pr-4 text-right">{d.list.noMark}</td>
                      <td className="py-2">
                        <Link
                          to={`/asistencia/${d.list.dayId}`}
                          className="font-semibold text-tinto-700 underline"
                        >
                          Ver lista <span className="sr-only">del {d.date}</span>
                        </Link>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 pr-4 text-right" colSpan={4}>
                        <span className="text-slate-600">No determinado</span>
                      </td>
                      <td />
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-8 text-lg font-semibold text-tinto-900">Por alumno</h3>
      {report.students.length === 0 ? (
        <p className="mt-2 text-slate-700">
          Ninguna lista del periodo incluye alumnos: no hay marcas que contar.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Marcas por alumno en las listas del periodo</caption>
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="py-2 pr-4">
                  Alumno
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Listas que lo incluyen
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Presentes
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Ausentes
                </th>
                <th scope="col" className="py-2 pr-4 text-right">
                  Sin marca
                </th>
                <th scope="col" className="py-2">
                  <span className="sr-only">Detalle</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {report.students.map((s) => (
                <tr key={s.studentId} className="border-b border-slate-200">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {s.givenNames} {s.familyName}
                  </th>
                  <td className="py-2 pr-4 text-right">{s.listsApplicable}</td>
                  <td className="py-2 pr-4 text-right">{s.present}</td>
                  <td className="py-2 pr-4 text-right">{s.absent}</td>
                  <td className="py-2 pr-4 text-right">{s.noMark}</td>
                  <td className="py-2">
                    <Link
                      to={studentLink(s.studentId)}
                      className="font-semibold text-tinto-700 underline"
                    >
                      Ver reporte{' '}
                      <span className="sr-only">
                        de {s.givenNames} {s.familyName}
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
