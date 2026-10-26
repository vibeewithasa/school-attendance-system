import { useCallback, useEffect, useState } from 'react';
import type { AdminRole, AdminUser } from '@eta15/shared-contracts';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { AccountDetail } from './AccountDetail';
import { ActivationPanel } from './ActivationPanel';
import { CreateAccountDialog } from './CreateAccountDialog';
import { UsersPanel } from './UsersPanel';

type Tab = 'cuentas' | 'solicitudes';

/**
 * Administracion de personal. La pagina se adapta a los permisos efectivos de la sesion, pero ES SOLO PRESENTACION: cada
 * llamada la autoriza de nuevo el servidor (que ademas limita lo visible a los dominios que la persona administra).
 */
export function PersonalPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const [tab, setTab] = useState<Tab>('cuentas');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const bump = useCallback(() => setRefreshKey((n) => n + 1), []);

  const perms = me ? permissionsOf(me) : null;
  const allowed = perms?.canViewPersonnel ?? false;

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    api
      .listRoles()
      .then((r) => !cancelled && setRoles(r))
      .catch(() => !cancelled && setRoles(null));
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!me || !perms) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Personal</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para administrar cuentas de personal.
        </p>
      </section>
    );
  }

  const creatable = perms.manageable.filter((d) => perms.canCreate(d));
  const tabCls = (t: Tab) =>
    `rounded-t-md border-b-4 px-4 py-2 font-semibold ${tab === t ? 'border-tinto-700 text-tinto-700' : 'border-transparent text-slate-700 hover:bg-tinto-50'}`;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-tinto-700">Personal</h1>
        {creatable.length > 0 && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-tinto-700 px-4 py-2 font-semibold text-white hover:bg-tinto-800"
          >
            Nueva cuenta
          </button>
        )}
      </div>
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {notice}
        </p>
      )}

      <div
        role="tablist"
        aria-label="Secciones de personal"
        className="mt-4 flex gap-1 border-b border-tinto-100"
      >
        <button
          role="tab"
          type="button"
          id="tab-cuentas"
          aria-selected={tab === 'cuentas'}
          aria-controls="panel-cuentas"
          onClick={() => setTab('cuentas')}
          className={tabCls('cuentas')}
        >
          Cuentas
        </button>
        <button
          role="tab"
          type="button"
          id="tab-solicitudes"
          aria-selected={tab === 'solicitudes'}
          aria-controls="panel-solicitudes"
          onClick={() => setTab('solicitudes')}
          className={tabCls('solicitudes')}
        >
          Solicitudes de activación
        </button>
      </div>

      <div className="mt-4">
        {tab === 'cuentas' ? (
          <div
            id="panel-cuentas"
            role="tabpanel"
            aria-labelledby="tab-cuentas"
            className="grid gap-6 lg:grid-cols-[3fr_2fr]"
          >
            <UsersPanel
              domains={perms.manageable}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              refreshKey={refreshKey}
            />
            {selected && (
              <AccountDetail
                key={selected.id}
                user={selected}
                roles={roles}
                perms={perms}
                selfId={me.user.id}
                onClose={() => setSelected(null)}
                onChanged={(user) => {
                  setSelected(user);
                  bump();
                }}
              />
            )}
          </div>
        ) : (
          <div id="panel-solicitudes" role="tabpanel" aria-labelledby="tab-solicitudes">
            <ActivationPanel onChanged={bump} />
          </div>
        )}
      </div>

      {creating && (
        <CreateAccountDialog
          domains={creatable}
          onClose={() => setCreating(false)}
          onCreated={(user) => {
            setCreating(false);
            setSelected(user);
            setTab('cuentas');
            setNotice(
              `Cuenta creada para ${user.displayName}. Asígnale un rol y pídele que la active en /activar con una autoridad presente.`,
            );
            bump();
          }}
        />
      )}
    </section>
  );
}
