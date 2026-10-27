import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { EnrollmentDto, GroupDto, SchoolYearDto } from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD,
  FieldError,
  useFocusFirstInvalid,
} from '../../components/form';
import { api } from '../../lib/api';
import { formatDay, gradeLabel, studentsErrorMessage } from './shared';

function FormShell({
  title,
  busy,
  formError,
  submitLabel,
  busyLabel,
  onSubmit,
  onClose,
  formRef,
  children,
}: {
  title: string;
  busy: boolean;
  formError: string | null;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose} closeDisabled={busy}>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {formError}
          </p>
        )}
        {children}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Inscripcion en un ciclo no terminado y en el que el alumno aun no esta inscrito (una matricula por alumno y ciclo). */
export function EnrollDialog({
  studentId,
  years,
  onDone,
  onClose,
}: {
  studentId: string;
  years: SchoolYearDto[];
  onDone: (e: EnrollmentDto) => void;
  onClose: () => void;
}) {
  const ids = { year: useId(), date: useId() };
  const [yearId, setYearId] = useState(years.find((y) => y.isActive)?.id ?? years[0]?.id ?? '');
  const [startsOn, setStartsOn] = useState('');
  const [errors, setErrors] = useState<{ year?: string; date?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);
  const year = years.find((y) => y.id === yearId);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next: { year?: string; date?: string } = {};
    if (!year) next.year = 'Elige el ciclo escolar.';
    else if (startsOn && (startsOn < year.startsOn || startsOn > year.endsOn))
      next.date = `La fecha debe estar entre ${formatDay(year.startsOn)} y ${formatDay(year.endsOn)}.`;
    setErrors(next);
    setFormError(null);
    if (next.year || next.date) return;
    setBusy(true);
    try {
      onDone(
        await api.enrollStudent(studentId, {
          schoolYearId: yearId,
          ...(startsOn ? { startsOn } : {}),
        }),
      );
    } catch (error) {
      setFormError(studentsErrorMessage(error, 'No se pudo inscribir al alumno.'));
      setBusy(false);
    }
  }

  return (
    <FormShell
      title="Inscribir en un ciclo"
      busy={busy}
      formError={formError}
      submitLabel="Inscribir"
      busyLabel="Inscribiendo…"
      onSubmit={onSubmit}
      onClose={onClose}
      formRef={formRef}
    >
      <div>
        <label htmlFor={ids.year} className="block text-sm font-semibold">
          Ciclo escolar
        </label>
        <select
          id={ids.year}
          value={yearId}
          onChange={(e) => setYearId(e.target.value)}
          disabled={busy}
          className={FIELD}
          aria-invalid={errors.year ? true : undefined}
          aria-describedby={errors.year ? `${ids.year}-e` : undefined}
        >
          {years.length === 0 && <option value="">No hay ciclos disponibles</option>}
          {years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
              {y.isActive ? ' (vigente)' : ''}
            </option>
          ))}
        </select>
        <FieldError id={`${ids.year}-e`} message={errors.year} />
      </div>
      <div>
        <label htmlFor={ids.date} className="block text-sm font-semibold">
          Primer día inscrito (opcional)
        </label>
        <input
          id={ids.date}
          type="date"
          value={startsOn}
          onChange={(e) => setStartsOn(e.target.value)}
          disabled={busy}
          className={FIELD}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={`${ids.date}-h${errors.date ? ` ${ids.date}-e` : ''}`}
        />
        <p id={`${ids.date}-h`} className="mt-1 text-xs text-slate-600">
          Si se deja vacío: hoy, o el inicio del ciclo si todavía no empieza. Una fecha anterior
          queda registrada como retroactiva.
        </p>
        <FieldError id={`${ids.date}-e`} message={errors.date} />
      </div>
    </FormShell>
  );
}

/**
 * Primera asignacion de grupo (`assign`) o traslado (`transfer`). Como el modelo trabaja con dias, un alumno no tiene dos grupos el
 * mismo dia: el traslado debe ser posterior al dia en que empezo el grupo actual (el servidor lo comprueba).
 */
export function GroupMoveDialog({
  mode,
  enrollment,
  onDone,
  onClose,
}: {
  mode: 'assign' | 'transfer';
  enrollment: EnrollmentDto;
  onDone: (e: EnrollmentDto) => void;
  onClose: () => void;
}) {
  const ids = { group: useId(), date: useId() };
  const current = enrollment.assignments.find((a) => a.endsOn === null)?.group.id ?? null;
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [date, setDate] = useState('');
  const [errors, setErrors] = useState<{ group?: string; date?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);

  useEffect(() => {
    let cancelled = false;
    api
      .listGroups({ schoolYearId: enrollment.schoolYearId, isActive: true, pageSize: 100 })
      .then((r) => !cancelled && setGroups(r.items))
      .catch(
        (e: unknown) =>
          !cancelled && setLoadError(studentsErrorMessage(e, 'No se pudieron cargar los grupos.')),
      );
    return () => {
      cancelled = true;
    };
  }, [enrollment.schoolYearId]);

  const options = (groups ?? []).filter((g) => g.id !== current);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next: { group?: string; date?: string } = {};
    if (!groupId) next.group = 'Elige el grupo.';
    if (date && date < enrollment.startsOn)
      next.date = 'La fecha no puede ser anterior al inicio de la matrícula.';
    setErrors(next);
    setFormError(null);
    if (next.group || next.date) return;
    setBusy(true);
    try {
      onDone(
        mode === 'assign'
          ? await api.assignGroup(enrollment.id, { groupId, ...(date ? { startsOn: date } : {}) })
          : await api.transferGroup(enrollment.id, {
              groupId,
              ...(date ? { effectiveOn: date } : {}),
            }),
      );
    } catch (error) {
      setFormError(studentsErrorMessage(error, 'No se pudo guardar el cambio de grupo.'));
      setBusy(false);
    }
  }

  return (
    <FormShell
      title={mode === 'assign' ? 'Asignar grupo' : 'Trasladar de grupo'}
      busy={busy}
      formError={formError ?? loadError}
      submitLabel={mode === 'assign' ? 'Asignar grupo' : 'Trasladar'}
      busyLabel="Guardando…"
      onSubmit={onSubmit}
      onClose={onClose}
      formRef={formRef}
    >
      <p className="text-sm text-slate-700">
        Ciclo <strong>{enrollment.schoolYearName}</strong>.{' '}
        {mode === 'transfer'
          ? 'El historial se conserva: el grupo actual se cierra el día anterior y el nuevo empieza en la fecha indicada.'
          : 'Es la primera asignación de esta matrícula.'}
      </p>
      <div>
        <label htmlFor={ids.group} className="block text-sm font-semibold">
          {mode === 'assign' ? 'Grupo' : 'Grupo nuevo'}
        </label>
        <select
          id={ids.group}
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          disabled={busy || groups === null}
          className={FIELD}
          aria-invalid={errors.group ? true : undefined}
          aria-describedby={errors.group ? `${ids.group}-e` : undefined}
        >
          <option value="">{groups === null ? 'Cargando grupos…' : 'Selecciona un grupo'}</option>
          {options.map((g) => (
            <option key={g.id} value={g.id}>
              {gradeLabel(g.grade)} {g.code}
              {g.shift ? ` · ${g.shift === 'matutino' ? 'Matutino' : 'Vespertino'}` : ''}
            </option>
          ))}
        </select>
        <FieldError id={`${ids.group}-e`} message={errors.group} />
      </div>
      <div>
        <label htmlFor={ids.date} className="block text-sm font-semibold">
          {mode === 'assign'
            ? 'Primer día en el grupo (opcional)'
            : 'Primer día en el grupo nuevo (opcional)'}
        </label>
        <input
          id={ids.date}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy}
          className={FIELD}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={`${ids.date}-h${errors.date ? ` ${ids.date}-e` : ''}`}
        />
        <p id={`${ids.date}-h`} className="mt-1 text-xs text-slate-600">
          {mode === 'assign'
            ? 'Si se deja vacío: el inicio de la matrícula.'
            : 'Si se deja vacío: hoy. No puede coincidir con el día en que empezó el grupo actual (no hay dos grupos el mismo día).'}
        </p>
        <FieldError id={`${ids.date}-e`} message={errors.date} />
      </div>
    </FormShell>
  );
}

/** Baja de la matricula: cierra tambien el grupo vigente; el historial se conserva y la baja no se reabre. */
export function WithdrawDialog({
  enrollment,
  onDone,
  onClose,
}: {
  enrollment: EnrollmentDto;
  onDone: (e: EnrollmentDto) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [endsOn, setEndsOn] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, error ? { error } : {});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    if (endsOn && endsOn < enrollment.startsOn) {
      setError('La fecha no puede ser anterior al inicio de la matrícula.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      onDone(await api.withdrawEnrollment(enrollment.id, endsOn ? { endsOn } : {}));
    } catch (e) {
      setFormError(studentsErrorMessage(e, 'No se pudo registrar la baja.'));
      setBusy(false);
    }
  }

  return (
    <FormShell
      title="Dar de baja la matrícula"
      busy={busy}
      formError={formError}
      submitLabel="Dar de baja"
      busyLabel="Procesando…"
      onSubmit={onSubmit}
      onClose={onClose}
      formRef={formRef}
    >
      <p className="text-sm text-slate-700">
        Se cierra la matrícula del ciclo <strong>{enrollment.schoolYearName}</strong> y su grupo
        vigente. No se borra nada y la baja no se puede reabrir.
      </p>
      <div>
        <label htmlFor={id} className="block text-sm font-semibold">
          Último día inscrito (opcional)
        </label>
        <input
          id={id}
          type="date"
          value={endsOn}
          onChange={(e) => setEndsOn(e.target.value)}
          disabled={busy}
          className={FIELD}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-h${error ? ` ${id}-e` : ''}`}
        />
        <p id={`${id}-h`} className="mt-1 text-xs text-slate-600">
          Si se deja vacío: hoy (inclusive).
        </p>
        <FieldError id={`${id}-e`} message={error} />
      </div>
    </FormShell>
  );
}
