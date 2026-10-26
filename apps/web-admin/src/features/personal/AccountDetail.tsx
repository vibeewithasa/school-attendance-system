import { useId, useState } from 'react';
import type { AdminRole, AdminUser } from '@eta15/shared-contracts';
import { ConfirmDialog } from '../../components/Modal';
import { api } from '../../lib/api';
import { DOMAIN_LABELS, roleLabel, type permissionsOf } from '../../lib/permissions';
import { ACTIVATION_LABELS, StatusBadge, adminErrorMessage, formatDate } from './shared';

type Perms = ReturnType<typeof permissionsOf>;
type Pending = { kind: 'disable' } | { kind: 'revoke'; roleKey: string };

/**
 * Detalle de una cuenta. Los controles se muestran segun los permisos efectivos de la sesion, pero cada accion la
 * vuelve a autorizar el servidor (ocultar un boton no es una medida de seguridad).
 */
export function AccountDetail({
  user,
  roles,
  perms,
  selfId,
  onChanged,
  onClose,
}: {
  user: AdminUser;
  /** Roles que la sesion puede asignar (de `GET /admin/roles`); `null` si no se pudieron cargar. */
  roles: AdminRole[] | null;
  perms: Perms;
  selfId: string;
  onChanged: (user: AdminUser) => void;
  onClose: () => void;
}) {
  const selectId = useId();
  const [roleKey, setRoleKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isSelf = user.id === selfId;
  const domain = user.accountDomain;
  const canGrant = perms.canGrant(domain) && user.status !== 'disabled' && !isSelf;
  const canRevoke = perms.canGrant(domain) && !isSelf;
  const canDisable = perms.canDisable(domain) && !isSelf && user.status !== 'disabled';
  const held = new Set(user.roles.map((r) => r.key));
  const available = (roles ?? []).filter((r) => r.domain === domain && !held.has(r.key));

  async function run(action: () => Promise<AdminUser>, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      setNotice(success);
      return true;
    } catch (e) {
      setError(adminErrorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!roleKey) return;
    if (await run(() => api.assignRole(user.id, roleKey), `Rol «${roleLabel(roleKey)}» asignado.`))
      setRoleKey('');
  }

  async function confirm() {
    if (!pending) return;
    const ok =
      pending.kind === 'disable'
        ? await run(() => api.disableUser(user.id), 'La cuenta quedó deshabilitada.')
        : await run(
            () => api.revokeRole(user.id, pending.roleKey),
            `Rol «${roleLabel(pending.roleKey)}» revocado.`,
          );
    if (ok) setPending(null);
  }

  return (
    <section
      aria-labelledby="detalle-titulo"
      className="rounded-md border border-tinto-100 bg-white p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="detalle-titulo" className="text-xl font-bold text-tinto-700">
            {user.displayName}
          </h2>
          <p className="text-sm text-slate-700">{user.email}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-400 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
        >
          Cerrar detalle
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold">Estado</dt>
        <dd>
          <StatusBadge status={user.status} />
          {user.locked && (
            <span className="ml-2 text-xs text-tinto-700">(bloqueada temporalmente)</span>
          )}
        </dd>
        <dt className="font-semibold">Dominio</dt>
        <dd>{DOMAIN_LABELS[domain]}</dd>
        <dt className="font-semibold">Creada</dt>
        <dd>{formatDate(user.createdAt)}</dd>
        <dt className="font-semibold">Último acceso</dt>
        <dd>{formatDate(user.lastLoginAt)}</dd>
      </dl>

      {user.status === 'pending' && (
        <p className="mt-3 rounded-md border border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {user.activation ? ACTIVATION_LABELS[user.activation] : 'Aún no inició su activación.'} La
          persona activa su cuenta en <strong>/activar</strong> con una autoridad presente; la
          administración no puede elegir ni conocer su contraseña.
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
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
        >
          {error}
        </p>
      )}

      <h3 className="mt-4 text-lg font-semibold">Roles</h3>
      {user.roles.length === 0 ? (
        <p className="text-sm text-slate-700">
          Esta cuenta no tiene roles. Sin roles no podrá iniciar sesión.
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-tinto-100 rounded-md border border-tinto-100">
          {user.roles.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-semibold">{roleLabel(r.key)}</span>
                <span className="block text-xs text-slate-600">
                  Desde {formatDate(r.grantedAt)}
                </span>
              </span>
              {canRevoke && (
                <button
                  type="button"
                  onClick={() => setPending({ kind: 'revoke', roleKey: r.key })}
                  disabled={busy}
                  className="rounded-md border border-tinto-700 px-3 py-1 text-sm font-semibold text-tinto-700 hover:bg-tinto-50 disabled:opacity-60"
                  aria-label={`Revocar el rol ${roleLabel(r.key)}`}
                >
                  Revocar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isSelf && (
        <p className="mt-2 text-xs text-slate-600">
          Es tu propia cuenta: no puedes cambiar tus roles ni deshabilitarte.
        </p>
      )}

      {canGrant && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label htmlFor={selectId} className="block text-sm font-semibold">
              Asignar un rol
            </label>
            <select
              id={selectId}
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
              disabled={busy || available.length === 0}
              className="mt-1 block w-full rounded-md border border-slate-400 px-3 py-2"
            >
              <option value="">
                {available.length === 0 ? 'No hay roles disponibles' : 'Elige un rol…'}
              </option>
              {available.map((r) => (
                <option key={r.key} value={r.key}>
                  {roleLabel(r.key)}
                  {r.requiresMfa ? ' (exige verificación en dos pasos)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={assign}
            disabled={!roleKey || busy}
            className="rounded-md bg-tinto-700 px-4 py-2 font-semibold text-white hover:bg-tinto-800 disabled:opacity-60"
          >
            Asignar rol
          </button>
        </div>
      )}
      {canGrant && roles === null && (
        <p className="mt-2 text-sm text-slate-700">No se pudo cargar la lista de roles.</p>
      )}

      {canDisable && (
        <div className="mt-6 border-t border-tinto-100 pt-4">
          <button
            type="button"
            onClick={() => setPending({ kind: 'disable' })}
            disabled={busy}
            className="rounded-md border border-tinto-700 px-4 py-2 font-semibold text-tinto-700 hover:bg-tinto-50 disabled:opacity-60"
          >
            Deshabilitar cuenta
          </button>
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'disable' ? '¿Deshabilitar esta cuenta?' : '¿Revocar este rol?'}
          message={
            pending.kind === 'disable' ? (
              <p>
                <strong>{user.displayName}</strong> dejará de poder iniciar sesión y se cerrarán sus
                sesiones abiertas. Esta pantalla no permite volver a habilitarla: haría falta una
                nueva activación.
              </p>
            ) : (
              <p>
                <strong>{user.displayName}</strong> perderá el rol{' '}
                <strong>{roleLabel(pending.roleKey)}</strong> y se cerrarán sus sesiones abiertas.
              </p>
            )
          }
          confirmLabel={pending.kind === 'disable' ? 'Deshabilitar' : 'Revocar rol'}
          busy={busy}
          error={error}
          onConfirm={confirm}
          onCancel={() => {
            setPending(null);
            setError(null);
          }}
        />
      )}
    </section>
  );
}
