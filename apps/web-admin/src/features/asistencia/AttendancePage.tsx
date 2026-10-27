import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  AttendanceDayDto,
  AttendanceDayList,
  AttendanceTodayResponse,
} from '@eta15/shared-contracts';
import { BTN_PRIMARY, BTN_SMALL } from '../../components/form';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import {
  BADGE,
  DAY_STATUS_CLS,
  DAY_STATUS_LABELS,
  FocusAlert,
  attendanceErrorMessage,
  formatLongDay,
  groupLabel,
  progressText,
} from './shared';

const PAGE_SIZE = 10;

/**
 * Asistencia diaria: los grupos del dia de quien consulta (la prefecta, solo los suyos; Direccion supervisa todos) y las listas
 * recientes. Solo presentacion: el servidor decide la fecha escolar, autoriza cada llamada y aplica el alcance por grupo. Una lista
 * por grupo y dia: abrirla de nuevo devuelve la misma. No sustituye a la app Android prevista.
 */
export function AttendancePage() {
  const { state } = useAuth();
  const navigate = useNavigate();
  const me = state.status === 'authenticated' ? state.me : null;
  const perms = me ? permissionsOf(me) : null;
  const allowed = perms?.canViewAttendance ?? false;

  const [today, setToday] = useState<AttendanceTodayResponse | null>(null);
  const [recent, setRecent] = useState<AttendanceDayList | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.attendanceToday(), api.listAttendanceDays({ page, pageSize: PAGE_SIZE })])
      .then(([t, r]) => {
        if (cancelled) return;
        setToday(t);
        setRecent(r);
      })
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(attendanceErrorMessage(e, 'No se pudo cargar la asistencia del día.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [allowed, page, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  async function openGroup(groupId: string) {
    setOpening(groupId);
    setOpenError(null);
    try {
      // El servidor decide la fecha (hoy): aqui solo se indica el grupo.
      const r = await api.openAttendanceDay({ groupId });
      navigate(`/asistencia/${r.day.id}`);
    } catch (e) {
      setOpenError(attendanceErrorMessage(e, 'No se pudo abrir la lista.'));
      setOpening(null);
    }
  }

  if (!me || !perms) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Asistencia</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para consultar la asistencia.
        </p>
      </section>
    );
  }

  const canCapture = perms.canCaptureAttendance;
  const pages = recent ? Math.max(1, Math.ceil(recent.total / recent.pageSize)) : 1;

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Asistencia</h1>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Una sola lista por grupo y día escolar, de lunes a viernes. La fecha la decide el servidor
        (hora de la escuela, Mazatlán).{' '}
        {canCapture
          ? 'Solo ves los grupos que tienes asignados.'
          : 'Consulta de supervisión: no se captura desde esta cuenta.'}
      </p>

      {loading && !today && (
        <p role="status" className="mt-6 text-slate-700">
          Cargando…
        </p>
      )}
      {error && (
        <div className="mt-6">
          <ErrorNotice message={error} onRetry={retry} />
        </div>
      )}

      {today && (
        <>
          <h2 className="mt-6 text-xl font-semibold text-tinto-900">
            Hoy: <span>{formatLongDay(today.schoolToday)}</span>
          </h2>
          {!today.isSchoolDay && (
            <p
              role="status"
              className="mt-3 rounded-md border border-amber-700 bg-amber-50 px-4 py-3 text-amber-900"
            >
              Hoy no hay clases: no se toma lista en sábado ni domingo. Puedes consultar las listas
              anteriores.
            </p>
          )}
          {openError && (
            <div className="mt-3">
              <FocusAlert>{openError}</FocusAlert>
            </div>
          )}
          {today.groups.length === 0 ? (
            <p className="mt-4 text-slate-700">
              No tienes grupos asignados hoy. Si debería haber alguno, avisa a Dirección.
            </p>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Grupos del día">
              {today.groups.map(({ group, canCapture: mayCapture, day }) => (
                <li key={group.id} className="rounded-md border border-tinto-100 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold">{groupLabel(group)}</h3>
                    <DayBadge day={day} />
                  </div>
                  {day && <p className="mt-1 text-sm text-slate-700">{progressText(day)}</p>}
                  <div className="mt-3">
                    {day ? (
                      <Link to={`/asistencia/${day.id}`} className={BTN_SMALL + ' inline-block'}>
                        {mayCapture && day.status === 'draft'
                          ? 'Continuar la lista'
                          : 'Ver la lista'}{' '}
                        <span className="sr-only">de {groupLabel(group)}</span>
                      </Link>
                    ) : mayCapture && today.isSchoolDay ? (
                      <button
                        type="button"
                        onClick={() => void openGroup(group.id)}
                        disabled={opening !== null}
                        aria-busy={opening === group.id}
                        className={BTN_PRIMARY}
                      >
                        {opening === group.id ? 'Abriendo…' : 'Abrir la lista'}{' '}
                        <span className="sr-only">de {groupLabel(group)}</span>
                      </button>
                    ) : (
                      <p className="text-sm text-slate-600">Sin lista abierta hoy.</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {recent && (
        <>
          <h2 className="mt-8 text-xl font-semibold text-tinto-900">Listas recientes</h2>
          {recent.items.length === 0 ? (
            <p className="mt-3 text-slate-700">Todavía no hay listas.</p>
          ) : (
            <ul
              className="mt-3 divide-y divide-slate-200 border-y border-slate-200"
              aria-label="Listas de asistencia recientes"
            >
              {recent.items.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"
                >
                  <div>
                    <p className="font-semibold">
                      {groupLabel(d.group)} · {formatLongDay(d.attendanceDate)}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
                      <DayBadge day={d} />
                      <span>{progressText(d)}</span>
                    </p>
                  </div>
                  <Link
                    to={`/asistencia/${d.id}`}
                    className="font-semibold text-tinto-700 underline"
                  >
                    Ver{' '}
                    <span className="sr-only">
                      la lista de {groupLabel(d.group)} del {d.attendanceDate}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav aria-label="Paginación" className="mt-3 flex items-center gap-3 text-sm">
              <button
                type="button"
                className={BTN_SMALL}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Anterior
              </button>
              <span>
                Página {page} de {pages}
              </span>
              <button
                type="button"
                className={BTN_SMALL}
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function DayBadge({ day }: { day: AttendanceDayDto | null }) {
  if (!day)
    return <span className={`${BADGE} border-slate-500 bg-white text-slate-700`}>Sin abrir</span>;
  return (
    <span className={`${BADGE} ${DAY_STATUS_CLS[day.status]}`}>
      {DAY_STATUS_LABELS[day.status]}
    </span>
  );
}
