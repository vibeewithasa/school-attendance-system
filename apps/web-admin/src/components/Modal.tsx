import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Dialogo modal accesible: role="dialog" + aria-modal, titulo asociado, foco inicial dentro, Tab atrapado, Escape cierra y
 * el foco regresa al elemento que lo abrio. (No se usa <dialog> nativo para comportarse igual en todos los entornos.)
 */
export function Modal({
  title,
  onClose,
  children,
  closeDisabled = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeDisabled?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape' && !closeDisabled) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-lg bg-white p-5 shadow-xl sm:rounded-lg"
      >
        <h2 id={titleId} className="text-xl font-bold text-tinto-700">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} closeDisabled={busy}>
      <div className="text-slate-700">{message}</div>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
        >
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-slate-400 px-4 py-2 font-semibold hover:bg-slate-50 disabled:opacity-60"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-md bg-tinto-700 px-4 py-2 font-semibold text-white hover:bg-tinto-800 disabled:cursor-wait disabled:opacity-70"
        >
          {busy ? 'Procesando…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
