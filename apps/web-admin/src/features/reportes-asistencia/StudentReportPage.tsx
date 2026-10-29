import type {
  AttendanceReportOptions,
  AttendanceStudentReport,
  ReportStudentOptionDto,
} from '@eta15/shared-contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BTN_PRIMARY, FIELD } from '../../components/form';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { formatLongDay, groupLabel } from '../asistencia/shared';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import {
  LoadingOrError,
  NoAccess,
  PeriodFields,
  ReportLimits,
  ReportTabs,
  StateBadge,
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
 * Reporte de asistencia por alumno (SOLO LECTURA): ciclo, grupo, alumno y periodo. Muestra, por dia habil, la marca registrada
 * (presente, ausente, sin marca) o por que no hay marca (sin lista, no estaba en el padron de la lista, sin grupo ese dia). Nunca
 * se atribuye al alumno asistencia de un grupo al que no pertenecia ni se convierte un dato faltante en ausencia. La prefectura
 * solo ve los dias y grupos de sus propios grupos. El servidor autoriza y aplica el alcance.
 */
export function StudentReportPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const allowed = me ? permissionsOf(me).canViewAttendance : false;
  const { options, error, loading, retry } = useReportOptions(allowed);
  const [params] = useSearchParams();

  const [yearId, setYearId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [students, setStudents] = useState<ReportStudentOptionDto[] | null>(null);
  const [studentsError, setStudentsError] = useState<string | null>(null);
  const [report, setReport] = useState<AttendanceStudentReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const ticket = useRef(0);
  const autoRun = useRef(false);
  const studentFieldId = useId();

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
      setStudentId(g ? (params.get('alumno') ?? '') : '');
      autoRun.current = Boolean(g && params.get('alumno'));
    }
    setInitialized(true);
  }

  // Alumnos del grupo elegido (solo los que el servidor permite ver).
  useEffect(() => {
    setStudents(null);
    setStudentsError(null);
    if (!groupId) return;
    let cancelled = false;
    api
      .attendanceReportGroupStudents(groupId)
      .then((r) => !cancelled && setStudents(r.students))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setStudentsError(reportErrorMessage(e, 'No se pudieron cargar los alumnos del grupo.')),
      );
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const year = options?.schoolYears.find((y) => y.id === yearId);

  async function run(opts: AttendanceReportOptions, sid: string, f: string, t: string) {
    const p = periodProblem(year, opts.schoolToday, f, t);
    setProblem(p);
    if (p) return;
    const mine = ++ticket.current;
    setRunning(true);
    setRunError(null);
    setReport(null);
    try {
      const r = await api.attendanceStudentReport(sid, { schoolYearId: yearId, from: f, to: t });
      if (mine === ticket.current) setReport(r);
    } catch (err) {
      if (mine === ticket.current)
        setRunError(reportErrorMessage(err, 'No se pudo generar el reporte.'));
    } finally {
      if (mine === ticket.current) setRunning(false);
    }
  }

  // Llegada desde el reporte por grupo: se genera una vez, con los datos del enlace.
  useEffect(() => {
    if (autoRun.current && options && students && studentId) {
      autoRun.current = false;
      if (students.some((s) => s.studentId === studentId)) void run(options, studentId, from, to);
      else setStudentId('');
    }
  }, [options, students, studentId]);

  if (!me) return null;
  if (!allowed) return <NoAccess title="Reporte de asistencia por alumno" />;

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
    setStudentId('');
    setProblem(null);
    if (y && options) {
      const p = defaultPeriod(y, options.schoolToday);
      setFrom(p.from);
      setTo(p.to);
    }
    clearResult();
  }

  function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!options) return;
    if (!groupId || !studentId) {
      setProblem('Elige un grupo y un alumno.');
      return;
    }
    void run(options, studentId, from, to);
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Reporte de asistencia por alumno</h1>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Consulta de solo lectura con las marcas registradas de un alumno durante un periodo. Elige
        el grupo para ver a sus alumnos.
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
          aria-label="Filtros del reporte por alumno"
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
              setStudentId('');
              setProblem(null);
              clearResult();
            }}
          />
          <div>
            <label htmlFor={studentFieldId} className="block text-sm font-semibold text-slate-800">
              Alumno
            </label>
            <select
              id={studentFieldId}
              value={studentId}
              disabled={!groupId || students === null}
              onChange={(e) => {
                setStudentId(e.target.value);
                setProblem(null);
                clearResult();
              }}
              className={FIELD}
            >
              <option value="">
                {!groupId ? 'Elige un grupo' : students === null ? 'Cargando…' : 'Elige un alumno'}
              </option>
              {(students ?? []).map((s) => (
                <option key={s.studentId} value={s.studentId}>
                  {s.familyName} {s.givenNames}
                </option>
              ))}
            </select>
          </div>
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

      {studentsError && (
        <div className="mt-4">
          <ErrorNotice message={studentsError} />
        </div>
      )}
      {students && students.length === 0 && groupId && (
        <p role="status" className="mt-4 text-slate-700">
          Este grupo no tiene alumnos asignados en el ciclo.
        </p>
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
      {report && <StudentReportView report={report} />}
      {options && options.schoolYears.length > 0 && <ReportLimits />}
    </section>
  );
}

function StudentReportView({ report }: { report: AttendanceStudentReport }) {
  const t = report.totals;
  const s = report.student;
  return (
    <div className="mt-8" role="region" aria-label="Resultado del reporte por alumno">
      <h2 className="text-xl font-semibold text-tinto-900">
        {s.givenNames} {s.familyName}
        {s.schoolCode ? (
          <span className="font-normal text-slate-700"> · {s.schoolCode}</span>
        ) : null}
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        Ciclo {report.schoolYear.name}. Periodo: {formatLongDay(report.period.from)} al{' '}
        {formatLongDay(report.period.to)}. Inscrito desde{' '}
        {formatLongDay(report.enrollment.startsOn)}
        {report.enrollment.endsOn ? ` hasta ${formatLongDay(report.enrollment.endsOn)}` : ''}.
      </p>

      <h3 className="mt-4 text-lg font-semibold text-tinto-900">Grupos del ciclo</h3>
      {report.groups.length === 0 ? (
        <p className="mt-1 text-slate-700">El alumno no tiene grupo asignado en este ciclo.</p>
      ) : (
        <ul className="mt-1 list-disc pl-5 text-sm" aria-label="Grupos del alumno en el ciclo">
          {report.groups.map((g) => (
            <li key={`${g.group.id}-${g.startsOn}`}>
              {groupLabel(g.group)}: desde {formatLongDay(g.startsOn)}
              {g.endsOn ? ` hasta ${formatLongDay(g.endsOn)}` : ' (vigente)'}
            </li>
          ))}
        </ul>
      )}

      <dl
        className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4"
        aria-label="Totales del periodo"
      >
        <Stat label="Días hábiles del periodo" value={t.weekdays} note="Lunes a viernes" />
        <Stat label="Presente" value={t.present} />
        <Stat label="Ausente" value={t.absent} />
        <Stat label="Sin marca" value={t.noMark} note="Lista en borrador" />
        <Stat label="Sin lista" value={t.noList} note="No determinado; no es ausencia" />
        <Stat label="Fuera del padrón" value={t.notInRoster} note="No es ausencia" />
        <Stat label="Sin grupo" value={t.notInGroup} note="No es ausencia" />
        <Stat label="Días con lista aplicable" value={t.listsApplicable} />
      </dl>

      <h3 className="mt-8 text-lg font-semibold text-tinto-900">Por día</h3>
      {report.days.length === 0 ? (
        <p className="mt-2 text-slate-700">El periodo no incluye días hábiles (lunes a viernes).</p>
      ) : (
        <div className="relative mt-2 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Situación del alumno por día hábil</caption>
            <thead>
              <tr className="border-b border-slate-300">
                <th scope="col" className="py-2 pr-4">
                  Fecha
                </th>
                <th scope="col" className="py-2 pr-4">
                  Situación
                </th>
                <th scope="col" className="py-2 pr-4">
                  Grupo
                </th>
                <th scope="col" className="py-2 pr-4">
                  Lista
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
                    <StateBadge state={d.state} />
                  </td>
                  <td className="py-2 pr-4">{d.group ? groupLabel(d.group) : '—'}</td>
                  <td className="py-2 pr-4">
                    {d.dayId ? (
                      <Link
                        to={`/asistencia/${d.dayId}`}
                        className="font-semibold text-tinto-700 underline"
                      >
                        {d.listStatus === 'finalized' ? 'Finalizada' : 'Borrador'}{' '}
                        <span className="sr-only">del {d.date}</span>
                      </Link>
                    ) : (
                      '—'
                    )}
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
