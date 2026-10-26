import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { ActivationRequest, VerificationMethod } from '@eta15/shared-contracts';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import { DOMAIN_LABELS } from '../../lib/permissions';
import { ErrorNotice, adminErrorMessage, formatDate } from './shared';

const STATE_LABELS: Record<ActivationRequest['state'], { label: string; cls: string }> = {
  requested: {
    label: 'Esperando verificación',
    cls: 'border-amber-700 bg-amber-50 text-amber-900',
  },
  authorized: {
    label: 'Verificada: la persona debe elegir su contraseña',
    cls: 'border-green-700 bg-green-50 text-green-900',
  },
  expired: { label: 'Vencida', cls: 'border-slate-500 bg-slate-100 text-slate-700' },
};

/**
 * Solicitudes de activacion que la persona autenticada puede aprobar. La autoridad NO ve ni recibe el codigo ni el secreto:
 * debe verificar la identidad en persona y teclear el codigo que la persona lee en SU pantalla.
 */
export function ActivationPanel({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<ActivationRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [approving, setApproving] = useState<ActivationRequest | null>(null);
  const [cancelling, setCancelling] = useState<ActivationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listActivations()
      .then((r) => !cancelled && setItems(r.items))
      .catch(
        (e: unknown) =>
          !cancelled && setError(adminErrorMessage(e, 'No se pudieron cargar las solicitudes.')),
      );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    setDialogError(null);
    try {
      await api.cancelActivation(cancelling.id);
      setCancelling(null);
      setNotice('Solicitud cancelada. La persona puede iniciar otra.');
      load();
      onChanged();
    } catch (e) {
      setDialogError(adminErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="activaciones-titulo">
      <h2 id="activaciones-titulo" className="sr-only">
        Solicitudes de activación
      </h2>
      <p className="text-sm text-slate-700">
        Aprueba solo después de verificar <strong>en persona</strong> la identidad de quien tienes
        enfrente. Pídele el código que aparece en su pantalla; no lo compartas ni lo envíes por
        mensaje.
      </p>
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {notice}
        </p>
      )}
      <div className="mt-3" aria-live="polite">
        {error ? (
          <ErrorNotice message={error} onRetry={load} />
        ) : items === null ? (
          <p role="status" className="py-6 text-center text-slate-700">
            Cargando solicitudes…
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-400 px-4 py-8 text-center text-slate-700">
            No hay solicitudes de activación pendientes.
          </p>
        ) : (
          <ul
            className="divide-y divide-tinto-100 rounded-md border border-tinto-100"
            aria-label="Solicitudes de activación"
          >
            {items.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  <span className="block font-semibold">{r.displayName}</span>
                  <span className="block text-sm text-slate-700">
                    {r.email} · {DOMAIN_LABELS[r.accountDomain]}
                  </span>
                  <span className="block text-xs text-slate-600">
                    Solicitada {formatDate(r.requestedAt)} · vence {formatDate(r.expiresAt)}
                  </span>
                  <span
                    className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${STATE_LABELS[r.state].cls}`}
                  >
                    {STATE_LABELS[r.state].label}
                  </span>
                  {r.createdByActor && r.state === 'requested' && (
                    <span className="mt-1 block text-xs text-amber-900">
                      Creaste esta cuenta: por control dual normalmente la aprueba otra autoridad.
                      Si eres la única autoridad del dominio, se requiere el procedimiento
                      excepcional con acta (consola).
                    </span>
                  )}
                </span>
                <span className="flex gap-2">
                  {r.state === 'requested' && (
                    <button
                      type="button"
                      onClick={() => {
                        setApproving(r);
                        setDialogError(null);
                      }}
                      className="rounded-md bg-tinto-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-tinto-800"
                      aria-label={`Verificar identidad de ${r.displayName}`}
                    >
                      Verificar identidad
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setCancelling(r);
                      setDialogError(null);
                    }}
                    className="rounded-md border border-tinto-700 px-3 py-1.5 text-sm font-semibold text-tinto-700 hover:bg-tinto-50"
                    aria-label={`Cancelar la solicitud de ${r.displayName}`}
                  >
                    Cancelar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {approving && (
        <ApproveDialog
          request={approving}
          onClose={() => setApproving(null)}
          onApproved={() => {
            setApproving(null);
            setNotice(
              `Identidad verificada. ${approving.displayName} ya puede elegir su contraseña en su pantalla.`,
            );
            load();
            onChanged();
          }}
        />
      )}
      {cancelling && (
        <ConfirmDialog
          title="¿Cancelar esta solicitud?"
          message={
            <p>
              La solicitud de <strong>{cancelling.displayName}</strong> dejará de ser válida y la
              persona tendrá que iniciar otra. La cuenta sigue pendiente.
            </p>
          }
          confirmLabel="Cancelar solicitud"
          busy={busy}
          error={dialogError}
          onConfirm={cancel}
          onCancel={() => setCancelling(null)}
        />
      )}
    </section>
  );
}

function ApproveDialog({
  request,
  onClose,
  onApproved,
}: {
  request: ActivationRequest;
  onClose: () => void;
  onApproved: () => void;
}) {
  const codeId = useId();
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<VerificationMethod>('in_person_id');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (code.replace(/[\s-]/g, '').length !== 10) {
      setError('El código tiene 10 caracteres (por ejemplo 7K3QM-B9XW2). Pídeselo a la persona.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.approveActivation(request.id, { code, verificationMethod: method });
      onApproved();
    } catch (e) {
      setError(adminErrorMessage(e, 'No se pudo aprobar la solicitud.'));
      setBusy(false);
    }
  }

  return (
    <Modal title="Verificar identidad" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-slate-700">
          Cuenta de <strong>{request.displayName}</strong> ({request.email}). Comprueba que la
          persona frente a ti es quien dice ser y que el nombre coincide con su identificación.
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {error}
          </p>
        )}
        <fieldset>
          <legend className="text-sm font-semibold">¿Cómo verificaste su identidad?</legend>
          <label className="mt-1 flex items-center gap-2">
            <input
              type="radio"
              name="method"
              checked={method === 'in_person_id'}
              onChange={() => setMethod('in_person_id')}
            />
            Con identificación oficial vigente
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="method"
              checked={method === 'in_person_known'}
              onChange={() => setMethod('in_person_known')}
            />
            La conozco personalmente
          </label>
        </fieldset>
        <div>
          <label htmlFor={codeId} className="block text-sm font-semibold">
            Código que muestra la pantalla de la persona
          </label>
          <input
            id={codeId}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={16}
            className="mt-1 block w-full rounded-md border border-slate-400 px-3 py-2 font-mono text-lg uppercase tracking-widest"
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-slate-400 px-4 py-2 font-semibold hover:bg-slate-50 disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="rounded-md bg-tinto-700 px-4 py-2 font-semibold text-white hover:bg-tinto-800 disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? 'Verificando…' : 'Confirmar identidad'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
