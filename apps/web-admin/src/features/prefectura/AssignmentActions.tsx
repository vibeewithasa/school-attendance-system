import { useId, useRef, useState, type FormEvent } from 'react';
import type { PrefectAssignmentDto } from '@eta15/shared-contracts';
import { REVOCATION_REASON_MAX, REVOCATION_REASON_MIN } from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD,
  FieldError,
  useFocusFirstInvalid,
} from '../../components/form';
import { api } from '../../lib/api';
import { formatDay, groupLabel, prefectErrorMessage } from './shared';

function Shell({
  title,
  intro,
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
  intro: React.ReactNode;
  busy: boolean;
  formError: string | null;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
  children: React.ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose} closeDisabled={busy}>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="text-sm text-slate-700">{intro}</div>
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

/** Cierre programado: el acceso termina al acabar la fecha elegida (inclusive). No extiende ni reabre. */
export function CloseDialog({
  assignment,
  onDone,
  onClose,
}: {
  assignment: PrefectAssignmentDto;
  onDone: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [endsOn, setEndsOn] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, error ? { endsOn: error } : {});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    if (endsOn && endsOn < assignment.startsOn) {
      setError('No puede ser anterior al inicio de la asignación.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await api.closePrefectAssignment(assignment.id, endsOn ? { endsOn } : {});
      onDone();
    } catch (e) {
      setFormError(prefectErrorMessage(e, 'No se pudo cerrar la asignación.'));
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Cerrar asignación"
      intro={
        <>
          <strong>{assignment.user.displayName}</strong> dejará de tener acceso a{' '}
          <strong>{groupLabel(assignment.group)}</strong> al terminar la fecha elegida (inclusive).
          El historial se conserva. Para quitar el acceso de inmediato usa «Revocar».
        </>
      }
      busy={busy}
      formError={formError}
      submitLabel="Cerrar asignación"
      busyLabel="Cerrando…"
      onSubmit={onSubmit}
      onClose={onClose}
      formRef={formRef}
    >
      <div>
        <label htmlFor={id} className="block text-sm font-semibold">
          Último día con acceso (opcional)
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
          Vacío = hoy. Actual:{' '}
          {assignment.endsOn ? formatDay(assignment.endsOn) : 'sin fecha de fin'}.
        </p>
        <FieldError id={`${id}-e`} message={error} />
      </div>
    </Shell>
  );
}

/** Revocacion inmediata: delicada, exige un motivo y una confirmacion explicita. */
export function RevokeDialog({
  assignment,
  onDone,
  onClose,
}: {
  assignment: PrefectAssignmentDto;
  onDone: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, error ? { reason: error } : {});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    const value = reason.trim();
    if (value.length < REVOCATION_REASON_MIN || value.length > REVOCATION_REASON_MAX) {
      setError(
        `Escribe el motivo (${REVOCATION_REASON_MIN} a ${REVOCATION_REASON_MAX} caracteres).`,
      );
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await api.revokePrefectAssignment(assignment.id, { reason: value });
      onDone();
    } catch (e) {
      setFormError(prefectErrorMessage(e, 'No se pudo revocar la asignación.'));
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Revocar acceso ahora"
      intro={
        <>
          <strong>{assignment.user.displayName}</strong> perderá <strong>de inmediato</strong> el
          acceso a <strong>{groupLabel(assignment.group)}</strong>. La asignación queda en el
          historial y no se puede reabrir; para devolver el acceso habrá que crear otra. Un
          dispositivo sin conexión no recibe el aviso hasta que se reconecte.
        </>
      }
      busy={busy}
      formError={formError}
      submitLabel="Revocar acceso"
      busyLabel="Revocando…"
      onSubmit={onSubmit}
      onClose={onClose}
      formRef={formRef}
    >
      <div>
        <label htmlFor={id} className="block text-sm font-semibold">
          Motivo
        </label>
        <input
          id={id}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          maxLength={REVOCATION_REASON_MAX + 20}
          autoComplete="off"
          className={FIELD}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-h${error ? ` ${id}-e` : ''}`}
        />
        <p id={`${id}-h`} className="mt-1 text-xs text-slate-600">
          Texto breve y sin datos de alumnos. Queda en el historial.
        </p>
        <FieldError id={`${id}-e`} message={error} />
      </div>
    </Shell>
  );
}
