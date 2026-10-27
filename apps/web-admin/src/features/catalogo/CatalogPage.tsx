import { useCallback, useEffect, useState } from 'react';
import type { SchoolYearDto } from '@eta15/shared-contracts';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import { GroupsPanel } from './GroupsPanel';
import { YearsPanel } from './YearsPanel';
import { catalogErrorMessage } from './shared';

type Tab = 'ciclos' | 'grupos';

/**
 * Catalogo escolar: ciclos y grupos. La pagina se adapta a los permisos efectivos (`catalog:read` para ver,
 * `catalog:manage_school` para modificar) pero ES SOLO PRESENTACION: el servidor autoriza cada llamada. Sin alumnos ni asistencia.
 */
export function CatalogPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const perms = me ? permissionsOf(me) : null;
  const allowed = perms?.canViewCatalog ?? false;
  const [tab, setTab] = useState<Tab>('ciclos');
  const [years, setYears] = useState<SchoolYearDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setError(null);
    api
      .listSchoolYears({ pageSize: 100 })
      .then((r) => !cancelled && setYears(r.items))
      .catch(
        (e: unknown) =>
          !cancelled && setError(catalogErrorMessage(e, 'No se pudo cargar el catálogo escolar.')),
      );
    return () => {
      cancelled = true;
    };
  }, [allowed, refreshKey, attempt]);

  const changed = useCallback((text: string) => {
    setNotice(text);
    setRefreshKey((n) => n + 1);
  }, []);

  if (!me || !perms) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Catálogo escolar</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para consultar el catálogo escolar.
        </p>
      </section>
    );
  }

  const tabCls = (t: Tab) =>
    `rounded-t-md border-b-4 px-4 py-2 font-semibold ${tab === t ? 'border-tinto-700 text-tinto-700' : 'border-transparent text-slate-700 hover:bg-tinto-50'}`;

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Catálogo escolar</h1>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Ciclos escolares y grupos de la escuela.
        {perms.canManageCatalog
          ? ' Nada se borra: los ciclos y grupos se desactivan.'
          : ' Tu rol puede consultar el catálogo, no modificarlo.'}
      </p>
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
        aria-label="Secciones del catálogo"
        className="mt-4 flex gap-1 border-b border-tinto-100"
      >
        <button
          role="tab"
          type="button"
          id="tab-ciclos"
          aria-selected={tab === 'ciclos'}
          aria-controls="panel-ciclos"
          onClick={() => setTab('ciclos')}
          className={tabCls('ciclos')}
        >
          Ciclos escolares
        </button>
        <button
          role="tab"
          type="button"
          id="tab-grupos"
          aria-selected={tab === 'grupos'}
          aria-controls="panel-grupos"
          onClick={() => setTab('grupos')}
          className={tabCls('grupos')}
        >
          Grupos
        </button>
      </div>

      <div className="mt-4" aria-live="polite">
        {error ? (
          <ErrorNotice message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !years ? (
          <p role="status" className="py-6 text-center text-slate-700">
            Cargando catálogo…
          </p>
        ) : tab === 'ciclos' ? (
          <div id="panel-ciclos" role="tabpanel" aria-labelledby="tab-ciclos">
            <YearsPanel years={years} canManage={perms.canManageCatalog} onChanged={changed} />
          </div>
        ) : (
          <div id="panel-grupos" role="tabpanel" aria-labelledby="tab-grupos">
            <GroupsPanel
              years={years}
              canManage={perms.canManageCatalog}
              refreshKey={refreshKey}
              onChanged={changed}
            />
          </div>
        )}
      </div>
    </section>
  );
}
