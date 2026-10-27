import { useCallback, useEffect, useState } from 'react';
import type { EnrollmentDto, SchoolYearDto, StudentDto } from '@eta15/shared-contracts';
import { ConfirmDialog } from '../../components/Modal';
import { BTN_SMALL } from '../../components/form';
import { api } from '../../lib/api';
import type { permissionsOf } from '../../lib/permissions';
import { ErrorNotice } from '../personal/shared';
import { EnrollDialog, GroupMoveDialog, WithdrawDialog } from './EnrollmentDialogs';
import { StudentDialog } from './StudentDialog';
import { ENROLLMENT_LABELS, formatDay, fullName, groupLabel, studentsErrorMessage } from './shared';

type Perms = ReturnType<typeof permissionsOf>;
type Dialog =
  | { kind: 'edit' }
  | { kind: 'enroll' }
  | { kind: 'assign' | 'transfer' | 'withdraw'; enrollment: EnrollmentDto }
  | { kind: 'toggle' };

const BADGE = 'inline-block rounded-full border px-2 py-0.5 text-xs font-semibold';
const STATUS_CLS: Record<EnrollmentDto['status'], string> = {
  active: 'border-green-700 bg-green-50 text-green-900',
  upcoming: 'border-amber-700 bg-amber-50 text-amber-900',
  withdrawn: 'border-slate-500 bg-slate-100 text-slate-700',
  completed: 'border-slate-500 bg-white text-slate-700',
};

/**
 * Detalle del alumno: datos, matriculas por ciclo e historial de grupos. Los controles dependen de los permisos efectivos
 * (solo presentacion; el servidor autoriza cada llamada y aplica el alcance por grupo).
 */
export function StudentDetail({
  studentId,
  perms,
  years,
  onChanged,
  onClose,
}: {
  studentId: string;
  perms: Perms;
  years: SchoolYearDto[];
  onChanged: (notice: string) => void;
  onClose: () => void;
}) {
  const [student, setStudent] = useState<StudentDto | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setFileError(null);
    api
      .getStudent(studentId)
      .then((s) => !cancelled && setStudent(s))
      .catch(
        (e: unknown) =>
          !cancelled && setError(studentsErrorMessage(e, 'No se pudo cargar el alumno.')),
      );
    if (perms.canViewStudentFile) {
      api
        .listEnrollments(studentId)
        .then((r) => !cancelled && setEnrollments(r))
        .catch((e: unknown) => {
          if (!cancelled) {
            setEnrollments([]);
            setFileError(studentsErrorMessage(e, 'No se pudo cargar el historial.'));
          }
        });
    } else setEnrollments(null);
    return () => {
      cancelled = true;
    };
  }, [studentId, perms.canViewStudentFile, attempt]);

  function done(notice: string) {
    setDialog(null);
    reload();
    onChanged(notice);
  }

  async function confirmToggle() {
    if (!student || busy) return;
    setBusy(true);
    setToggleError(null);
    try {
      if (student.isActive) await api.deactivateStudent(student.id);
      else await api.reactivateStudent(student.id);
      done(
        student.isActive ? `${fullName(student)} desactivado.` : `${fullName(student)} reactivado.`,
      );
    } catch (e) {
      setToggleError(studentsErrorMessage(e, 'No se pudo cambiar el estado del alumno.'));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (!student)
    return (
      <p role="status" className="py-6 text-center text-slate-700">
        Cargando alumno…
      </p>
    );

  const enrolledYearIds = new Set((enrollments ?? []).map((e) => e.schoolYearId));
  const enrollable = years.filter((y) => y.period !== 'past' && !enrolledYearIds.has(y.id));

  return (
    <section aria-labelledby="alumno-titulo" className="rounded-md border border-tinto-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="alumno-titulo" className="text-xl font-bold text-tinto-700">
            {fullName(student)}
          </h2>
          <p className="text-sm text-slate-700">
            {student.schoolCode === undefined
              ? ''
              : `${student.schoolCode ? `Código ${student.schoolCode}` : 'Sin código escolar'} · `}
            {student.currentGroup ? groupLabel(student.currentGroup) : 'Sin grupo vigente'}
          </p>
          <span
            className={`${BADGE} mt-1 ${student.isActive ? 'border-green-700 bg-green-50 text-green-900' : 'border-slate-500 bg-slate-100 text-slate-700'}`}
          >
            {student.isActive ? 'Activo' : 'Inactivo'}
          </span>
        </div>
        <button type="button" onClick={onClose} className={BTN_SMALL}>
          Cerrar detalle
        </button>
      </div>

      {(perms.canManageStudents || perms.canManageEnrollments) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {perms.canManageStudents && (
            <button type="button" className={BTN_SMALL} onClick={() => setDialog({ kind: 'edit' })}>
              Corregir datos
            </button>
          )}
          {perms.canManageEnrollments && student.isActive && enrollable.length > 0 && (
            <button
              type="button"
              className={BTN_SMALL}
              onClick={() => setDialog({ kind: 'enroll' })}
            >
              Inscribir en un ciclo
            </button>
          )}
          {perms.canManageStudents && (
            <button
              type="button"
              className={BTN_SMALL}
              onClick={() => setDialog({ kind: 'toggle' })}
            >
              {student.isActive ? 'Desactivar alumno' : 'Reactivar alumno'}
            </button>
          )}
        </div>
      )}

      {perms.canViewStudentFile && (
        <div className="mt-5">
          <h3 className="text-lg font-semibold text-slate-900">Matrículas por ciclo</h3>
          {fileError && <ErrorNotice message={fileError} onRetry={reload} />}
          {enrollments === null ? (
            <p role="status" className="py-3 text-slate-700">
              Cargando historial…
            </p>
          ) : enrollments.length === 0 && !fileError ? (
            <p className="mt-2 rounded-md border border-dashed border-slate-400 px-4 py-6 text-center text-slate-700">
              Todavía no tiene matrículas.
            </p>
          ) : (
            <ul className="mt-2 space-y-3" aria-label="Matrículas">
              {enrollments.map((e) => {
                const open = e.assignments.find((a) => a.endsOn === null);
                const editable = e.status === 'active' || e.status === 'upcoming';
                return (
                  <li key={e.id} className="rounded-md border border-tinto-100 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-slate-900">
                        Ciclo {e.schoolYearName}{' '}
                        <span className={`${BADGE} ml-1 ${STATUS_CLS[e.status]}`}>
                          {ENROLLMENT_LABELS[e.status]}
                        </span>
                      </p>
                      <p className="text-sm text-slate-700">
                        Desde {formatDay(e.startsOn)}
                        {e.endsOn ? ` hasta ${formatDay(e.endsOn)}` : ''}
                      </p>
                    </div>
                    <h4 className="mt-2 text-sm font-semibold text-slate-800">
                      Historial de grupos
                    </h4>
                    {e.assignments.length === 0 ? (
                      <p className="text-sm text-slate-700">Sin grupo asignado.</p>
                    ) : (
                      <ol
                        className="mt-1 divide-y divide-tinto-100 text-sm"
                        aria-label={`Grupos del ciclo ${e.schoolYearName}`}
                      >
                        {e.assignments.map((a) => (
                          <li
                            key={a.id}
                            className="flex flex-wrap items-center justify-between gap-1 py-1"
                          >
                            <span className="font-semibold">
                              {a.group.grade}.º {a.group.code}
                              {a.current && (
                                <span
                                  className={`${BADGE} ml-2 border-green-700 bg-green-50 text-green-900`}
                                >
                                  Hoy
                                </span>
                              )}
                            </span>
                            <span className="text-slate-700">
                              {formatDay(a.startsOn)} —{' '}
                              {a.endsOn ? formatDay(a.endsOn) : 'sin cierre'}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {perms.canManageEnrollments && editable && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {e.assignments.length === 0 && (
                          <button
                            type="button"
                            className={BTN_SMALL}
                            onClick={() => setDialog({ kind: 'assign', enrollment: e })}
                            aria-label={`Asignar grupo en el ciclo ${e.schoolYearName}`}
                          >
                            Asignar grupo
                          </button>
                        )}
                        {open && (
                          <button
                            type="button"
                            className={BTN_SMALL}
                            onClick={() => setDialog({ kind: 'transfer', enrollment: e })}
                            aria-label={`Trasladar de grupo en el ciclo ${e.schoolYearName}`}
                          >
                            Trasladar de grupo
                          </button>
                        )}
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() => setDialog({ kind: 'withdraw', enrollment: e })}
                          aria-label={`Dar de baja la matrícula del ciclo ${e.schoolYearName}`}
                        >
                          Dar de baja
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {dialog?.kind === 'edit' && (
        <StudentDialog
          student={student}
          onClose={() => setDialog(null)}
          onSaved={() => done('Datos del alumno actualizados.')}
        />
      )}
      {dialog?.kind === 'enroll' && (
        <EnrollDialog
          studentId={student.id}
          years={enrollable}
          onClose={() => setDialog(null)}
          onDone={(e) => done(`Alumno inscrito en el ciclo ${e.schoolYearName}.`)}
        />
      )}
      {(dialog?.kind === 'assign' || dialog?.kind === 'transfer') && (
        <GroupMoveDialog
          mode={dialog.kind}
          enrollment={dialog.enrollment}
          onClose={() => setDialog(null)}
          onDone={() =>
            done(dialog.kind === 'assign' ? 'Grupo asignado.' : 'Traslado de grupo registrado.')
          }
        />
      )}
      {dialog?.kind === 'withdraw' && (
        <WithdrawDialog
          enrollment={dialog.enrollment}
          onClose={() => setDialog(null)}
          onDone={() => done('Baja de matrícula registrada.')}
        />
      )}
      {dialog?.kind === 'toggle' && (
        <ConfirmDialog
          title={student.isActive ? 'Desactivar alumno' : 'Reactivar alumno'}
          message={
            student.isActive ? (
              <p>
                ¿Desactivar a <strong>{fullName(student)}</strong>? No se borra nada: se conserva su
                historial. Si tiene una matrícula sin baja, primero hay que darla de baja.
              </p>
            ) : (
              <p>
                ¿Reactivar a <strong>{fullName(student)}</strong>? Podrá volver a inscribirse. La
                reactivación queda auditada.
              </p>
            )
          }
          confirmLabel={student.isActive ? 'Desactivar alumno' : 'Reactivar alumno'}
          busy={busy}
          error={toggleError}
          onConfirm={confirmToggle}
          onCancel={() => {
            setDialog(null);
            setToggleError(null);
          }}
        />
      )}
    </section>
  );
}
