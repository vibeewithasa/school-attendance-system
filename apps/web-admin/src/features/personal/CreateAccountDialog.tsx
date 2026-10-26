import { useId, useRef, useState, type FormEvent } from 'react';
import type { AdminUser } from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import { DOMAIN_LABELS, type Domain } from '../../lib/permissions';
import { adminErrorMessage } from './shared';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Alta de una cuenta PENDIENTE. No hay campo de contrasena: la persona la elige ella misma al activar su cuenta con una
 * autoridad presente (la administracion nunca conoce ni elige una contrasena).
 */
export function CreateAccountDialog({
  domains,
  onCreated,
  onClose,
}: {
  domains: Domain[];
  onCreated: (user: AdminUser) => void;
  onClose: () => void;
}) {
  const ids = { name: useId(), email: useId(), domain: useId() };
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const domainRef = useRef<HTMLSelectElement>(null);
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const displayName = nameRef.current?.value.trim() ?? '';
    const email = emailRef.current?.value.trim() ?? '';
    const accountDomain = (domainRef.current?.value ?? domains[0]) as Domain;
    const next: { name?: string; email?: string } = {};
    if (!displayName) next.name = 'Escribe el nombre completo.';
    else if (displayName.length > 120) next.name = 'El nombre es demasiado largo.';
    if (!email) next.email = 'Escribe el correo electrónico.';
    else if (!EMAIL_RE.test(email)) next.email = 'Escribe un correo electrónico válido.';
    setErrors(next);
    setFormError(null);
    if (next.name || next.email) return;
    setBusy(true);
    try {
      onCreated(await api.createUser({ email, displayName, accountDomain }));
    } catch (error) {
      setFormError(adminErrorMessage(error, 'No se pudo crear la cuenta.'));
      setBusy(false);
    }
  }

  const input =
    'mt-1 block w-full rounded-md border border-slate-400 px-3 py-2 disabled:bg-slate-100';
  return (
    <Modal title="Nueva cuenta de personal" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <p className="text-sm text-slate-700">
          La cuenta nace <strong>pendiente</strong> y sin contraseña. Después la persona la activa
          ella misma con una autoridad presente que verifique su identidad.
        </p>
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {formError}
          </p>
        )}
        <div>
          <label htmlFor={ids.name} className="block text-sm font-semibold">
            Nombre completo
          </label>
          <input
            ref={nameRef}
            id={ids.name}
            className={input}
            disabled={busy}
            autoComplete="off"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${ids.name}-e` : undefined}
          />
          {errors.name && (
            <p id={`${ids.name}-e`} className="mt-1 text-sm text-tinto-700">
              {errors.name}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={ids.email} className="block text-sm font-semibold">
            Correo electrónico institucional
          </label>
          <input
            ref={emailRef}
            id={ids.email}
            type="email"
            className={input}
            disabled={busy}
            autoComplete="off"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${ids.email}-e` : undefined}
          />
          {errors.email && (
            <p id={`${ids.email}-e`} className="mt-1 text-sm text-tinto-700">
              {errors.email}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={ids.domain} className="block text-sm font-semibold">
            Dominio de la cuenta
          </label>
          <select
            ref={domainRef}
            id={ids.domain}
            className={input}
            disabled={busy || domains.length === 1}
            defaultValue={domains[0]}
          >
            {domains.map((d) => (
              <option key={d} value={d}>
                {DOMAIN_LABELS[d]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
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
            {busy ? 'Creando…' : 'Crear cuenta'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
