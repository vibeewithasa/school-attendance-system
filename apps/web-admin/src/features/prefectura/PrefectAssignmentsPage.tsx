import { useCallback, useEffect, useId, useState } from 'react';
import {
  PREFECT_ASSIGNMENT_STATUSES,
  type PrefectAssignmentDto,
  type PrefectAssignmentList,
  type PrefectAssignmentStatus,
  type PrefectCandidateDto,
  type SchoolYearDto,
} from '@eta15/shared-contracts';
import { BTN_PRIMARY, BTN_SMALL, FIELD } from '../../components/form';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import { AssignDialog } from './AssignDialog';
import { CloseDialog, RevokeDialog } from './AssignmentActions';
import { STATUS_CLS, STATUS_LABELS, formatDay, groupLabel, prefectErrorMessage } from './shared';

const PAGE_SIZE = 20;
const BADGE = 'inline-block rounded-full border px-2 py-0.5 text-xs font-semibold';

type Dialog =
  | { kind: 'assign' }
  | { kind: 'close'; assignment: PrefectAssignmentDto }
  | { kind: 'revoke'; assignment: PrefectAssignmentDto };

/**
 * Asignaciones de grupos a prefectura: Direccion decide que prefecta atiende que grupo (varias por grupo, como cobertura temporal)
 * y consulta el historial. Solo presentacion: el servidor autoriza cada llamada y la prefectura NO administra nada aqui. Una
 * asignacion se cierra por fecha (acceso hasta ese dia) o se revoca (acceso retirado de inmediato); nada se borra.
 */
export function PrefectAssignmentsPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const perms = me ? permissionsOf(me) : null;
  const allowed = perms?.canViewPrefectAssignments ?? false;
  const ids = { user: useId(), year: useId(), status: useId() };

  const [userId, setUserId] = useState('');
  const [yearId, setYearId] = useState('');
  const [status, setStatus] = useState<PrefectAssignmentStatus | ''>('');
  const [page, setPage] = useState(1);
  const [candidates, setCandidates] = useState<PrefectCandidateDto[]>([]);
  const [years, setYears] = useState<SchoolYearDto[]>([]);
  const [data, setData] = useState<PrefectAssignmentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = perms?.canManagePrefectAssignments ?? false;

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    if (canManage)
      api
        .listPrefectCandidates()
        .then((r) => !cancelled && setCandidates(r))
        .catch(() => !cancelled && setCandidates([]));
    if (perms?.canViewCatalog)
      api
        .listSchoolYears({ pageSize: 100 })
        .then((r) => !cancelled && setYears(r.items))
        .catch(() => !cancelled && setYears([]));
    return () => {
      cancelled = true;
    };
  }, [allowed, canManage, perms?.canViewCatalog, refreshKey]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listPrefectAssignments({
        page,
        pageSize: PAGE_SIZE,
        userId: userId || undefined,
        schoolYearId: yearId || undefined,
        status: status || undefined,
      })
      .then((r) => !cancelled && setData(r))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(prefectErrorMessage(e, 'No se pudo cargar la lista de asignaciones.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [allowed, page, userId, yearId, status, refreshKey, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const changed = (text: string) => {
    setDialog(null);
    setNotice(text);
    setRefreshKey((n) => n + 1);
  };

  if (!me || !perms) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Asignaciones de prefectura</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para consultar las asignaciones de prefectura.
        </p>
      </section>
    );
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = Boolean(userId || yearId || status);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-tinto-700">Asignaciones de prefectura</h1>
        {canManage && (
          <button
            type="button"
            onClick={() => setDialog({ kind: 'assign' })}
            className={BTN_PRIMARY}
          >
            Asignar grupos
          </button>
        )}
      </div>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Cada prefecta consulta únicamente los grupos que tenga asignados. Un grupo puede tener más
        de una prefecta (cobertura temporal). Nada se borra: una asignación se cierra por fecha o se
        revoca de inmediato, y el historial se conserva.
      </p>
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {notice}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3" role="search">
        {canManage && (
          <div>
            <label htmlFor={ids.user} className="block text-sm font-semibold text-slate-800">
              Prefecta
            </label>
            <select
              id={ids.user}
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setPage(1);
              }}
              className={FIELD}
            >
              <option value="">Todas</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
        {perms.canViewCatalog && (
          <div>
            <label htmlFor={ids.year} className="block text-sm font-semibold text-slate-800">
              Ciclo escolar
            </label>
            <select
              id={ids.year}
              value={yearId}
              onChange={(e) => {
                setYearId(e.target.value);
                setPage(1);
              }}
              className={FIELD}
            >
              <option value="">Todos</option>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                  {y.isActive ? ' (vigente)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor={ids.status} className="block text-sm font-semibold text-slate-800">
            Estado
          </label>
          <select
            id={ids.status}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as PrefectAssignmentStatus | '');
              setPage(1);
            }}
            className={FIELD}
          >
            <option value="">Todos (historial)</option>
            {PREFECT_ASSIGNMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4" aria-live="polite" aria-busy={loading}>
        {error ? (
          <ErrorNotice message={error} onRetry={retry} />
        ) : loading && !data ? (
          <p role="status" className="py-6 text-center text-slate-700">
            Cargando asignaciones…
          </p>
        ) : data && data.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-400 px-4 py-8 text-center text-slate-700">
            {filtered
              ? 'No hay asignaciones que coincidan con los filtros.'
              : canManage
                ? 'Todavía no hay asignaciones. Usa «Asignar grupos» para crear la primera.'
                : 'No hay asignaciones.'}
          </p>
        ) : (
          data && (
            <>
              <ul
                className="divide-y divide-tinto-100 rounded-md border border-tinto-100"
                aria-label="Asignaciones de prefectura"
              >
                {data.items.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:justify-between"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">
                        {a.user.displayName} · {groupLabel(a.group)}
                      </p>
                      <p className="text-sm text-slate-700">
                        Ciclo {a.group.schoolYearName} · desde {formatDay(a.startsOn)}
                        {a.endsOn ? ` hasta ${formatDay(a.endsOn)}` : ' · sin fecha de fin'}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-2">
                        <span className={`${BADGE} ${STATUS_CLS[a.status]}`}>
                          {STATUS_LABELS[a.status]}
                        </span>
                        {a.status === 'active' && !a.grantsAccess && (
                          <span className={`${BADGE} border-amber-700 bg-amber-50 text-amber-900`}>
                            Sin efecto hoy: revisa cuenta, rol o grupo
                          </span>
                        )}
                      </p>
                      {a.status === 'revoked' && a.revokedAt && (
                        <p className="mt-1 text-sm text-slate-700">
                          Revocada el {formatDay(a.revokedAt.slice(0, 10))}
                          {a.revocationReason ? `. Motivo: ${a.revocationReason}` : ''}
                        </p>
                      )}
                    </div>
                    {canManage && (a.status === 'active' || a.status === 'upcoming') && (
                      <div className="flex flex-wrap items-start gap-2">
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() => setDialog({ kind: 'close', assignment: a })}
                          aria-label={`Cerrar la asignación de ${a.user.displayName} a ${groupLabel(a.group)}`}
                        >
                          Cerrar
                        </button>
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() => setDialog({ kind: 'revoke', assignment: a })}
                          aria-label={`Revocar el acceso de ${a.user.displayName} a ${groupLabel(a.group)}`}
                        >
                          Revocar
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <nav
                className="mt-3 flex items-center justify-between gap-2 text-sm"
                aria-label="Paginación de asignaciones"
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
                  {data.total === 1 ? 'asignación' : 'asignaciones'}
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

      {dialog?.kind === 'assign' && (
        <AssignDialog
          candidates={candidates}
          years={years}
          onClose={() => setDialog(null)}
          onPartial={() => setRefreshKey((n) => n + 1)}
          onDone={(created) =>
            changed(
              created.length === 1 ? 'Grupo asignado.' : `${created.length} grupos asignados.`,
            )
          }
        />
      )}
      {dialog?.kind === 'close' && (
        <CloseDialog
          assignment={dialog.assignment}
          onClose={() => setDialog(null)}
          onDone={() => changed('Asignación cerrada.')}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <RevokeDialog
          assignment={dialog.assignment}
          onClose={() => setDialog(null)}
          onDone={() => changed('Acceso revocado de inmediato.')}
        />
      )}
    </section>
  );
}
