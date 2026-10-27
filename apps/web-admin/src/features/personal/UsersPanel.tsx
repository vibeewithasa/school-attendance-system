import { useCallback, useEffect, useId, useState } from 'react';
import type { AdminUser, AdminUserList } from '@eta15/shared-contracts';
import { api } from '../../lib/api';
import { searchMinTwo, useDebouncedSearch } from '../../lib/use-debounced-search';
import { DOMAIN_LABELS, roleLabel, type Domain } from '../../lib/permissions';
import { ACTIVATION_LABELS, ErrorNotice, StatusBadge, adminErrorMessage } from './shared';

const PAGE_SIZE = 10;

/** Listado con busqueda, filtros y paginacion. Los filtros se validan tambien en el servidor. */
export function UsersPanel({
  domains,
  selectedId,
  onSelect,
  refreshKey,
}: {
  /** Dominios que la persona administra (para mostrar el filtro solo si hay mas de uno). */
  domains: Domain[];
  selectedId: string | null;
  onSelect: (user: AdminUser) => void;
  /** Cambia cuando otra parte de la pantalla modifica cuentas (recarga el listado). */
  refreshKey: number;
}) {
  const searchId = useId();
  const statusId = useId();
  const domainId = useId();
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [domain, setDomain] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminUserList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Busqueda con retraso: no se consulta en cada tecla y se exige un minimo de 2 caracteres (como el servidor).
  const q = useDebouncedSearch(text, searchMinTwo, () => setPage(1));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listUsers({
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        status: (status || undefined) as AdminUser['status'] | undefined,
        domain: (domain || undefined) as Domain | undefined,
      })
      .then((result) => !cancelled && setData(result))
      .catch(
        (e: unknown) =>
          !cancelled && setError(adminErrorMessage(e, 'No se pudo cargar la lista de personal.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page, q, status, domain, refreshKey, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const field = 'mt-1 block w-full rounded-md border border-slate-400 px-3 py-2';

  return (
    <section aria-labelledby="personal-lista">
      <h2 id="personal-lista" className="sr-only">
        Lista de personal
      </h2>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]" role="search">
        <div>
          <label htmlFor={searchId} className="block text-sm font-semibold text-slate-800">
            Buscar por nombre o correo
          </label>
          <input
            id={searchId}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={field}
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor={statusId} className="block text-sm font-semibold text-slate-800">
            Estado
          </label>
          <select
            id={statusId}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className={field}
          >
            <option value="">Todos</option>
            <option value="pending">Pendiente de activación</option>
            <option value="active">Activa</option>
            <option value="disabled">Deshabilitada</option>
          </select>
        </div>
        {domains.length > 1 && (
          <div>
            <label htmlFor={domainId} className="block text-sm font-semibold text-slate-800">
              Dominio
            </label>
            <select
              id={domainId}
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                setPage(1);
              }}
              className={field}
            >
              <option value="">Todos</option>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {DOMAIN_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="mt-4" aria-live="polite" aria-busy={loading}>
        {error ? (
          <ErrorNotice message={error} onRetry={retry} />
        ) : loading && !data ? (
          <p role="status" className="py-6 text-center text-slate-700">
            Cargando personal…
          </p>
        ) : data && data.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-400 px-4 py-8 text-center text-slate-700">
            {q || status || domain
              ? 'No hay cuentas que coincidan con los filtros.'
              : 'Todavía no hay cuentas registradas. Crea la primera con «Nueva cuenta».'}
          </p>
        ) : (
          data && (
            <>
              <ul
                className="divide-y divide-tinto-100 rounded-md border border-tinto-100"
                aria-label="Cuentas"
              >
                {data.items.map((user) => (
                  <li key={user.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(user)}
                      aria-current={selectedId === user.id ? 'true' : undefined}
                      className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-tinto-50 sm:flex-row sm:items-center sm:justify-between ${selectedId === user.id ? 'bg-tinto-50' : ''}`}
                    >
                      <span>
                        <span className="block font-semibold text-slate-900">
                          {user.displayName}
                        </span>
                        <span className="block text-sm text-slate-700">{user.email}</span>
                        <span className="block text-xs text-slate-600">
                          {DOMAIN_LABELS[user.accountDomain]} ·{' '}
                          {user.roles.length
                            ? user.roles.map((r) => roleLabel(r.key)).join(', ')
                            : 'Sin roles'}
                          {user.status === 'pending' && user.activation
                            ? ` · ${ACTIVATION_LABELS[user.activation]}`
                            : ''}
                        </span>
                      </span>
                      <StatusBadge status={user.status} />
                    </button>
                  </li>
                ))}
              </ul>
              <nav
                className="mt-3 flex items-center justify-between gap-2 text-sm"
                aria-label="Paginación"
              >
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || loading}
                  className="rounded-md border border-slate-400 px-3 py-1.5 font-semibold disabled:opacity-50"
                >
                  Anterior
                </button>
                <span>
                  Página {data.page} de {pages} · {data.total}{' '}
                  {data.total === 1 ? 'cuenta' : 'cuentas'}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  disabled={page >= pages || loading}
                  className="rounded-md border border-slate-400 px-3 py-1.5 font-semibold disabled:opacity-50"
                >
                  Siguiente
                </button>
              </nav>
            </>
          )
        )}
      </div>
    </section>
  );
}
