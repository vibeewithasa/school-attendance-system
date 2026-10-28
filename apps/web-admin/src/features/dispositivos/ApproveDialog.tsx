import { useId, useRef, useState, type FormEvent } from 'react';
import { MOBILE_FINGERPRINT_PATTERN, type MobileRequestDto } from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD,
  FieldError,
  useFocusFirstInvalid,
} from '../../components/form';
import { api } from '../../lib/api';
import { mobileErrorMessage } from './shared';

/**
 * Aprobacion de una vinculacion: quien aprueba TECLEA la huella que ve en la pantalla del dispositivo (verificacion presencial).
 * El campo nunca se rellena con la huella de la solicitud: si se pudiera aprobar con un clic, un dispositivo ajeno o una solicitud
 * reclamada por otra persona pasarian sin que nadie comparara nada.
 */
export function ApproveDialog({
  request,
  onDone,
  onClose,
}: {
  request: MobileRequestDto;
  onDone: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, error ? { fingerprint: error } : {});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    const fingerprint = value.trim().toUpperCase();
    if (!MOBILE_FINGERPRINT_PATTERN.test(fingerprint)) {
      setError('Escribe la huella con el formato XXXX-XXXX-XXXX (letras A–F y números).');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await api.approveMobileRequest(request.id, { fingerprint });
      onDone();
    } catch (e) {
      setFormError(mobileErrorMessage(e, 'No se pudo aprobar la vinculación.'));
      setBusy(false);
    }
  }

  return (
    <Modal title="Aprobar vinculación" onClose={onClose} closeDisabled={busy}>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="text-sm text-slate-700">
          Vas a autorizar el dispositivo <strong>{request.label}</strong> para{' '}
          <strong>{request.titular?.displayName ?? 'una persona'}</strong>. Ten el dispositivo
          delante y <strong>escribe la huella que muestra su pantalla</strong>. Si no coincide, no
          apruebes: puede ser otro dispositivo.
        </div>
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {formError}
          </p>
        )}
        <div>
          <label htmlFor={id} className="block text-sm font-semibold">
            Huella que muestra el dispositivo
          </label>
          <input
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            placeholder="XXXX-XXXX-XXXX"
            className={`${FIELD} font-mono tracking-wider`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-e` : undefined}
          />
          <FieldError id={`${id}-e`} message={error} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? 'Aprobando…' : 'Aprobar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
