import { useCallback, useEffect, useId, useState } from 'react';
import type { GroupDto, GroupList, SchoolYearDto, Shift } from '@eta15/shared-contracts';
import { SHIFTS } from '@eta15/shared-contracts';
import { ConfirmDialog } from '../../components/Modal';
import { api } from '../../lib/api';
import { searchTrimmed, useDebouncedSearch } from '../../lib/use-debounced-search';
import { ErrorNotice } from '../personal/shared';
import { GroupDialog } from './GroupDialog';
import {
  BTN_PRIMARY,
  BTN_SMALL,
  FIELD,
  GroupBadges,
  SHIFT_LABELS,
  catalogErrorMessage,
  gradeLabel,
  shiftLabel,
} from './shared';

const PAGE_SIZE = 20;

/**
 * Grupos por ciclo, grado y turno, con la hora de entrada esperada. Los filtros viajan al servidor (que los valida).
 * Los controles de escritura solo aparecen con `catalog:manage_school`; los grupos de ciclos terminados son historial.
 */
export function GroupsPanel({
  years,
  canManage,
  refreshKey,
  onChanged,
}: {
  years: SchoolYearDto[];
  canManage: boolean;
  refreshKey: number;
  onChanged: (notice: string) => void;
}) {
  const ids = { year: useId(), grade: useId(), shift: useId(), state: useId(), search: useId() };
  const [yearId, setYearId] = useState('');
  const [grade, setGrade] = useState('');
  const [shift, setShift] = useState('');
  const [state, setState] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<GroupList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<GroupDto | 'new' | null>(null);
  const [toggle, setToggle] = useState<GroupDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // El ciclo vigente es el filtro inicial razonable; una vez que la persona elige, se respeta su eleccion.
  const [yearTouched, setYearTouched] = useState(false);
  useEffect(() => {
    if (yearTouched) return;
    const current = years.find((y) => y.isActive);
    if (current) setYearId(current.id);
  }, [years, yearTouched]);

  const q = useDebouncedSearch(text, searchTrimmed, () => setPage(1));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listGroups({
        page,
        pageSize: PAGE_SIZE,
        schoolYearId: yearId || undefined,
        grade: grade ? Number(grade) : undefined,
        shift: (shift || undefined) as Shift | 'none' | undefined,
        isActive: state === '' ? undefined : state === 'active',
        q: q || undefined,
      })
      .then((result) => !cancelled && setData(result))
      .catch(
        (e: unknown) =>
          !cancelled && setError(catalogErrorMessage(e, 'No se pudo cargar la lista de grupos.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page, yearId, grade, shift, state, q, refreshKey, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = Boolean(yearId || grade || shift || state || q);
  const creatableYears = years.filter((y) => y.period !== 'past');

  async function confirmToggle() {
    if (!toggle || busy) return;
    setBusy(true);
    setToggleError(null);
    try {
      await api.updateGroup(toggle.id, { isActive: !toggle.isActive });
      const done = toggle;
      setToggle(null);
      onChanged(
        done.isActive
          ? `Grupo ${gradeLabel(done.grade)} ${done.code} desactivado.`
          : `Grupo ${gradeLabel(done.grade)} ${done.code} activado.`,
      );
    } catch (e) {
      setToggleError(catalogErrorMessage(e, 'No se pudo cambiar el estado del grupo.'));
    } finally {
      setBusy(false);
    }
  }

  const onFilter = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setPage(1);
  };

  return (
    <section aria-labelledby="grupos-titulo">
      <h2 id="grupos-titulo" className="sr-only">
        Grupos
      </h2>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" role="search">
          <div>
            <label htmlFor={ids.year} className="block text-sm font-semibold text-slate-800">
              Ciclo escolar
            </label>
            <select
              id={ids.year}
              value={yearId}
              onChange={(e) => {
                setYearTouched(true);
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
          <div>
            <label htmlFor={ids.grade} className="block text-sm font-semibold text-slate-800">
              Grado
            </label>
            <select id={ids.grade} value={grade} onChange={onFilter(setGrade)} className={FIELD}>
              <option value="">Todos</option>
              {[1, 2, 3].map((g) => (
                <option key={g} value={g}>
                  {gradeLabel(g)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.shift} className="block text-sm font-semibold text-slate-800">
              Turno
            </label>
            <select id={ids.shift} value={shift} onChange={onFilter(setShift)} className={FIELD}>
              <option value="">Todos</option>
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  {SHIFT_LABELS[s]}
                </option>
              ))}
              <option value="none">Sin turno</option>
            </select>
          </div>
          <div>
            <label htmlFor={ids.state} className="block text-sm font-semibold text-slate-800">
              Estado
            </label>
            <select id={ids.state} value={state} onChange={onFilter(setState)} className={FIELD}>
              <option value="">Todos</option>
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
            </select>
          </div>
          <div>
            <label htmlFor={ids.search} className="block text-sm font-semibold text-slate-800">
              Buscar grupo
            </label>
            <input
              id={ids.search}
              type="search"
              value={text}
              maxLength={10}
              onChange={(e) => setText(e.target.value)}
              className={FIELD}
              autoComplete="off"
            />
          </div>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className={`${BTN_PRIMARY} mt-6`}
            disabled={creatableYears.length === 0}
            title={creatableYears.length === 0 ? 'Primero crea un ciclo escolar' : undefined}
          >
            Nuevo grupo
          </button>
        )}
      </div>

      <div className="mt-4" aria-live="polite" aria-busy={loading}>
        {error ? (
          <ErrorNotice message={error} onRetry={retry} />
        ) : loading && !data ? (
          <p role="status" className="py-6 text-center text-slate-700">
            Cargando grupos…
          </p>
        ) : data && data.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-400 px-4 py-8 text-center text-slate-700">
            {filtered
              ? 'No hay grupos que coincidan con los filtros.'
              : canManage
                ? 'Todavía no hay grupos. Crea el primero con «Nuevo grupo».'
                : 'Todavía no hay grupos registrados.'}
          </p>
        ) : (
          data && (
            <>
              <ul
                className="divide-y divide-tinto-100 rounded-md border border-tinto-100"
                aria-label="Grupos"
              >
                {data.items.map((g) => (
                  <li
                    key={g.id}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">
                        {gradeLabel(g.grade)} {g.code}
                        <span className="ml-2 text-sm font-normal text-slate-700">
                          {g.schoolYearName}
                        </span>
                      </p>
                      <p className="text-sm text-slate-700">
                        {shiftLabel(g.shift)} ·{' '}
                        {g.expectedEntryTime
                          ? `Entrada ${g.expectedEntryTime}`
                          : 'Hora de entrada sin configurar'}
                      </p>
                      <div className="mt-1">
                        <GroupBadges group={g} />
                      </div>
                    </div>
                    {canManage && !g.historical && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() => setEditing(g)}
                          aria-label={`Editar grupo ${gradeLabel(g.grade)} ${g.code} ${g.schoolYearName}`}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() => setToggle(g)}
                          aria-label={`${g.isActive ? 'Desactivar' : 'Activar'} grupo ${gradeLabel(g.grade)} ${g.code} ${g.schoolYearName}`}
                        >
                          {g.isActive ? 'Desactivar' : 'Activar'}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <nav
                className="mt-3 flex items-center justify-between gap-2 text-sm"
                aria-label="Paginación de grupos"
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
                  {data.total === 1 ? 'grupo' : 'grupos'}
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

      {editing && (
        <GroupDialog
          group={editing === 'new' ? undefined : editing}
          years={creatableYears}
          defaultYearId={yearId && creatableYears.some((y) => y.id === yearId) ? yearId : undefined}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            const created = editing === 'new';
            setEditing(null);
            onChanged(
              created
                ? `Grupo ${gradeLabel(saved.grade)} ${saved.code} creado.`
                : `Grupo ${gradeLabel(saved.grade)} ${saved.code} actualizado.`,
            );
          }}
        />
      )}
      {toggle && (
        <ConfirmDialog
          title={toggle.isActive ? 'Desactivar grupo' : 'Activar grupo'}
          message={
            toggle.isActive ? (
              <p>
                ¿Desactivar el grupo{' '}
                <strong>
                  {gradeLabel(toggle.grade)} {toggle.code}
                </strong>{' '}
                de {toggle.schoolYearName}? No se borra: se conserva con su historial y puede
                activarse de nuevo.
              </p>
            ) : (
              <p>
                ¿Activar el grupo{' '}
                <strong>
                  {gradeLabel(toggle.grade)} {toggle.code}
                </strong>{' '}
                de {toggle.schoolYearName}?
              </p>
            )
          }
          confirmLabel={toggle.isActive ? 'Desactivar grupo' : 'Activar grupo'}
          busy={busy}
          error={toggleError}
          onConfirm={confirmToggle}
          onCancel={() => {
            setToggle(null);
            setToggleError(null);
          }}
        />
      )}
    </section>
  );
}
