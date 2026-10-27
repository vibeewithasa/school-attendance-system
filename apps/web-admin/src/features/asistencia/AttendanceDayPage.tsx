import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  AttendanceDayDetail,
  AttendanceMark,
  AttendanceRecordDto,
  AttendanceRecordStatus,
} from '@eta15/shared-contracts';
import { ConfirmDialog } from '../../components/Modal';
import { BTN_PRIMARY, BTN_SECONDARY } from '../../components/form';
import { ApiError, NetworkError, api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import {
  BADGE,
  DAY_STATUS_CLS,
  DAY_STATUS_LABELS,
  FocusAlert,
  MARK_CLS,
  MARK_LABELS,
  attendanceErrorMessage,
  formatLongDay,
  groupLabel,
} from './shared';

const OPTIONS: ReadonlyArray<{ value: AttendanceMark; label: string; on: string }> = [
  {
    value: 'present',
    label: 'Presente',
    on: 'has-[:checked]:border-green-700 has-[:checked]:bg-green-50 has-[:checked]:text-green-900',
  },
  {
    value: 'absent',
    label: 'Ausente',
    on: 'has-[:checked]:border-tinto-700 has-[:checked]:bg-tinto-50 has-[:checked]:text-tinto-900',
  },
];

const fullName = (r: AttendanceRecordDto) => `${r.givenNames} ${r.familyName}`;

/**
 * Una lista de asistencia (un grupo, un dia). Presentacion y captura de prueba: el servidor decide si la lista es editable, vuelve
 * a autorizar cada operacion y rechaza con 409 si otra persona la modifico (control optimista): aqui nunca se sobrescribe sin avisar.
 * Las marcas sin guardar viven solo en esta pantalla; "Guardar borrador" envia unicamente lo que cambio. Una lista finalizada, de un
 * dia anterior o abierta con una cuenta de solo consulta se muestra de solo lectura.
 */
export function AttendanceDayPage() {
  const { dayId = '' } = useParams();
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const allowed = me ? permissionsOf(me).canViewAttendance : false;

  const [day, setDay] = useState<AttendanceDayDetail | null>(null);
  const [local, setLocal] = useState<Record<string, AttendanceMark>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Un 404 (lista ajena, inexistente o sin acceso) no se arregla reintentando: no se ofrece "Reintentar".
  const [retryable, setRetryable] = useState(true);
  const [problem, setProblem] = useState<{ text: string; conflict: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Mismo identificador de guardado mientras el contenido no cambie: un reintento por fallo de red nunca duplica historial.
  const requestRef = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (!allowed || !dayId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getAttendanceDay(dayId)
      .then((d) => {
        if (cancelled) return;
        setDay(d);
        setLocal({});
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRetryable(!(e instanceof ApiError && e.status === 404));
        setLoadError(attendanceErrorMessage(e, 'No se pudo cargar la lista.'));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [allowed, dayId, attempt]);

  const dirty = Object.keys(local).length > 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const statusOf = useCallback(
    (r: AttendanceRecordDto): AttendanceRecordStatus => local[r.studentId] ?? r.status,
    [local],
  );

  function setMark(r: AttendanceRecordDto, value: AttendanceMark) {
    setNotice(null);
    setLocal((cur) => {
      const next = { ...cur };
      if (value === r.status) delete next[r.studentId];
      else next[r.studentId] = value;
      return next;
    });
  }

  /** Vuelve a pedir la lista. Las marcas locales se conservan salvo las de alumnos que otra persona ya marco distinto. */
  async function reload() {
    if (!day) return;
    setProblem(null);
    try {
      const fresh = await api.getAttendanceDay(day.id);
      const before = new Map(day.records.map((r) => [r.studentId, r.status]));
      const now = new Map(fresh.records.map((r) => [r.studentId, r.status]));
      let dropped = 0;
      const keep: Record<string, AttendanceMark> = {};
      for (const [studentId, mark] of Object.entries(local)) {
        if (now.get(studentId) !== before.get(studentId))
          dropped += 1; // otra persona ya lo marco: se respeta su valor
        else if (now.get(studentId) !== mark) keep[studentId] = mark;
      }
      setDay(fresh);
      setLocal(keep);
      requestRef.current = null;
      setNotice(
        dropped > 0
          ? `Se recargó la lista. ${dropped === 1 ? '1 alumno ya había sido marcado' : `${dropped} alumnos ya habían sido marcados`} por otra persona y se muestra su valor actual; tus demás marcas siguen sin guardar.`
          : 'Se recargó la lista con los cambios más recientes.',
      );
    } catch (e) {
      setProblem({
        text: attendanceErrorMessage(e, 'No se pudo recargar la lista.'),
        conflict: false,
      });
    }
  }

  async function save() {
    if (!day || saving || !dirty) return;
    const marks = Object.entries(local).map(([studentId, status]) => ({ studentId, status }));
    const key = JSON.stringify([
      day.revision,
      [...marks].sort((a, b) => a.studentId.localeCompare(b.studentId)),
    ]);
    if (requestRef.current?.key !== key) requestRef.current = { key, id: crypto.randomUUID() };
    setSaving(true);
    setProblem(null);
    setNotice(null);
    try {
      const r = await api.saveAttendanceMarks(day.id, {
        expectedRevision: day.revision,
        requestId: requestRef.current.id,
        marks,
      });
      setDay(r.day);
      setLocal({});
      requestRef.current = null;
      setNotice(
        r.replayed
          ? 'Ese guardado ya estaba aplicado.'
          : r.changed === 0
            ? 'No había cambios nuevos que guardar.'
            : 'Borrador guardado.',
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
        setProblem({
          text: 'Otra persona modificó esta lista mientras la editabas. No se guardó nada: recarga para ver sus cambios.',
          conflict: true,
        });
      } else if (e instanceof NetworkError) {
        setProblem({
          text: 'No se pudo contactar con el servidor. Tus marcas siguen aquí sin guardar; vuelve a intentarlo (el reintento es seguro).',
          conflict: false,
        });
      } else {
        setProblem({
          text: attendanceErrorMessage(e, 'No se pudo guardar el borrador.'),
          conflict: false,
        });
        if (
          e instanceof ApiError &&
          ['DAY_FINALIZED', 'DAY_NOT_CURRENT', 'GROUP_INACTIVE'].includes(e.code)
        )
          setAttempt((n) => n + 1);
      }
    } finally {
      setSaving(false);
    }
  }

  async function finalize() {
    if (!day) return;
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const r = await api.finalizeAttendanceDay(day.id, { expectedRevision: day.revision });
      setDay(r.day);
      setLocal({});
      setConfirming(false);
      setNotice(
        r.alreadyFinalized
          ? 'La lista ya estaba finalizada.'
          : 'Lista finalizada. Ya no se puede modificar desde aquí.',
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
        setConfirming(false);
        setProblem({
          text: 'Otra persona modificó esta lista antes de finalizarla. Recarga para revisar los cambios y vuelve a finalizar.',
          conflict: true,
        });
      } else {
        setFinalizeError(attendanceErrorMessage(e, 'No se pudo finalizar la lista.'));
      }
    } finally {
      setFinalizing(false);
    }
  }

  if (!me) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Lista de asistencia</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para consultar la asistencia.
        </p>
      </section>
    );
  }
  if (loadError)
    return (
      <section>
        <p>
          <Link to="/asistencia" className="font-semibold text-tinto-700 underline">
            ← Volver a asistencia
          </Link>
        </p>
        <div className="mt-4">
          <ErrorNotice
            message={loadError}
            onRetry={retryable ? () => setAttempt((n) => n + 1) : undefined}
          />
        </div>
      </section>
    );
  if (loading || !day)
    return (
      <p role="status" className="text-slate-700">
        Cargando la lista…
      </p>
    );

  const eff = day.records.map(statusOf);
  const present = eff.filter((s) => s === 'present').length;
  const absent = eff.filter((s) => s === 'absent').length;
  const pending = eff.length - present - absent;
  const editable = day.editable;
  const canFinalize = editable && !dirty && pending === 0 && eff.length > 0;
  const { addedToRoster, removedFromRoster } = day.discrepancies;
  const readOnlyReason =
    day.status === 'finalized'
      ? 'Esta lista fue finalizada y ya no se puede modificar desde aquí. Puedes consultarla.'
      : !permissionsOf(me).canCaptureAttendance
        ? 'Consulta de supervisión: esta cuenta no captura asistencia.'
        : day.attendanceDate !== day.schoolToday
          ? 'Esta lista es de un día anterior y ya no se puede modificar desde aquí.'
          : 'Esta lista no se puede modificar en este momento.';

  return (
    <section>
      <p>
        <Link to="/asistencia" className="font-semibold text-tinto-700 underline">
          ← Volver a asistencia
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold text-tinto-700">
          {groupLabel(day.group)}
          <span className="sr-only"> · lista de asistencia</span>
        </h1>
        <span className={`${BADGE} ${DAY_STATUS_CLS[day.status]}`}>
          {DAY_STATUS_LABELS[day.status]}
        </span>
      </div>
      <p className="mt-1 text-slate-800">{formatLongDay(day.attendanceDate)}</p>

      {!editable && (
        <p
          role="note"
          className="mt-3 rounded-md border border-slate-400 bg-slate-50 px-4 py-3 text-sm text-slate-800"
        >
          {readOnlyReason}
        </p>
      )}
      {(addedToRoster > 0 || removedFromRoster > 0) && (
        <p
          role="note"
          className="mt-3 rounded-md border border-amber-700 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          El padrón del grupo cambió después de abrir esta lista ({addedToRoster} alumno(s)
          nuevo(s), {removedFromRoster} que ya no está(n) en el grupo ese día). La lista no se
          modifica sola; avisa a Dirección para revisarlo.
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {notice}
        </p>
      )}
      {problem && (
        <div className="mt-3">
          <FocusAlert>
            <p>{problem.text}</p>
            {problem.conflict && (
              <button type="button" onClick={() => void reload()} className={`${BTN_PRIMARY} mt-2`}>
                Recargar la lista
              </button>
            )}
          </FocusAlert>
        </div>
      )}

      <p aria-live="polite" className="mt-4 text-sm font-semibold text-slate-800">
        Marcados: {eff.length - pending} de {eff.length} · Presentes: {present} · Ausentes: {absent}{' '}
        · Pendientes: {pending}
        {dirty && <span className="ml-2 font-normal text-amber-900">(cambios sin guardar)</span>}
      </p>

      {day.records.length === 0 ? (
        <p className="mt-4 text-slate-700">Esta lista no tiene alumnos.</p>
      ) : (
        <ul
          className="mt-2 divide-y divide-slate-200 border-y border-slate-200"
          aria-label="Alumnos de la lista"
        >
          {day.records.map((r) => {
            const s = statusOf(r);
            return (
              <li
                key={r.studentId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="font-medium">
                  {fullName(r)}
                  {editable && s === 'pending' && (
                    <span className={`${BADGE} ${MARK_CLS.pending} ml-2`}>Pendiente</span>
                  )}
                </span>
                {editable ? (
                  <div
                    role="radiogroup"
                    aria-label={`Asistencia de ${fullName(r)}`}
                    className="flex gap-2"
                  >
                    {OPTIONS.map((o) => (
                      <label
                        key={o.value}
                        className={`flex min-h-11 cursor-pointer items-center rounded-md border border-slate-400 px-4 py-2 text-sm font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tinto-700 ${o.on}`}
                      >
                        <input
                          type="radio"
                          name={`asistencia-${r.studentId}`}
                          value={o.value}
                          checked={s === o.value}
                          onChange={() => setMark(r, o.value)}
                          className="sr-only"
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                ) : (
                  <span className={`${BADGE} ${MARK_CLS[s]}`}>{MARK_LABELS[s]}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            aria-busy={saving}
            className={BTN_PRIMARY}
          >
            {saving ? 'Guardando…' : 'Guardar borrador'}
          </button>
          <button
            type="button"
            onClick={() => {
              setFinalizeError(null);
              setConfirming(true);
            }}
            disabled={!canFinalize || saving}
            className={BTN_SECONDARY}
          >
            Finalizar lista
          </button>
          {!canFinalize && (
            <span className="text-sm text-slate-700">
              {dirty
                ? 'Guarda tus cambios para poder finalizar.'
                : pending > 0
                  ? `Faltan ${pending} por marcar para poder finalizar.`
                  : ''}
            </span>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Finalizar la lista"
          message={
            <p>
              Vas a finalizar la lista de <strong>{groupLabel(day.group)}</strong> del{' '}
              {formatLongDay(day.attendanceDate).toLocaleLowerCase('es-MX')}: {present} presente(s)
              y {absent} ausente(s). Una lista finalizada ya no se puede modificar desde este flujo.
            </p>
          }
          confirmLabel="Finalizar"
          busy={finalizing}
          error={finalizeError}
          onConfirm={() => void finalize()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
