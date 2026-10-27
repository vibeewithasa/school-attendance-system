import { useCallback, useEffect, useId, useState } from 'react';
import type { GroupDto, SchoolYearDto, StudentList } from '@eta15/shared-contracts';
import { BTN_PRIMARY, FIELD } from '../../components/form';
import { api } from '../../lib/api';
import { searchMinTwo, useDebouncedSearch } from '../../lib/use-debounced-search';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import { StudentDetail } from './StudentDetail';
import { StudentDialog } from './StudentDialog';
import { fullName, groupLabel, studentsErrorMessage } from './shared';

const PAGE_SIZE = 20;

/**
 * Alumnos: listado con busqueda y filtros por ciclo y grupo, alta, detalle, matriculas e historial de grupos. Datos de menores:
 * la pagina solo adapta lo que muestra a los permisos efectivos; el servidor autoriza cada llamada, aplica el alcance por grupo y
 * responde igual a un alumno fuera de alcance que a uno inexistente.
 */
export function StudentsPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const perms = me ? permissionsOf(me) : null;
  const allowed = perms?.canViewStudents ?? false;
  const ids = { q: useId(), year: useId(), group: useId(), state: useId() };

  const [text, setText] = useState('');
  const [yearId, setYearId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [years, setYears] = useState<SchoolYearDto[]>([]);
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [data, setData] = useState<StudentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Los filtros por ciclo y grupo usan el catalogo; sin acceso al catalogo simplemente no se ofrecen.
  const canFilterByCatalog = perms?.canViewCatalog ?? false;
  useEffect(() => {
    if (!allowed || !canFilterByCatalog) return;
    let cancelled = false;
    api
      .listSchoolYears({ pageSize: 100 })
      .then((r) => !cancelled && setYears(r.items))
      .catch(() => !cancelled && setYears([]));
    return () => {
      cancelled = true;
    };
  }, [allowed, canFilterByCatalog, refreshKey]);

  useEffect(() => {
    if (!yearId) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    api
      .listGroups({ schoolYearId: yearId, pageSize: 100 })
      .then((r) => !cancelled && setGroups(r.items))
      .catch(() => !cancelled && setGroups([]));
    return () => {
      cancelled = true;
    };
  }, [yearId]);

  const q = useDebouncedSearch(text, searchMinTwo, () => setPage(1));

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listStudents({
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        schoolYearId: yearId || undefined,
        groupId: groupId || undefined,
        isActive: active === '' ? undefined : active === 'active',
      })
      .then((r) => !cancelled && setData(r))
      .catch(
        (e: unknown) =>
          !cancelled && setError(studentsErrorMessage(e, 'No se pudo cargar la lista de alumnos.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [allowed, page, q, yearId, groupId, active, refreshKey, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const changed = useCallback((text2: string) => {
    setNotice(text2);
    setRefreshKey((n) => n + 1);
  }, []);

  if (!me || !perms) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Alumnos</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para consultar alumnos.
        </p>
      </section>
    );
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = Boolean(q || yearId || groupId || active);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-tinto-700">Alumnos</h1>
        {perms.canManageStudents && (
          <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY}>
            Registrar alumno
          </button>
        )}
      </div>
      <p className="mt-2 max-w-prose text-sm text-slate-700">
        Datos mínimos de los alumnos, su inscripción por ciclo y su historial de grupos. Nada se
        borra: los alumnos se desactivan y las matrículas se cierran.
      </p>
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {notice}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search">
        <div>
          <label htmlFor={ids.q} className="block text-sm font-semibold text-slate-800">
            Buscar por nombre o código
          </label>
          <input
            id={ids.q}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={FIELD}
            autoComplete="off"
          />
        </div>
        {canFilterByCatalog && (
          <>
            <div>
              <label htmlFor={ids.year} className="block text-sm font-semibold text-slate-800">
                Ciclo escolar
              </label>
              <select
                id={ids.year}
                value={yearId}
                onChange={(e) => {
                  setYearId(e.target.value);
                  setGroupId('');
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
              <label htmlFor={ids.group} className="block text-sm font-semibold text-slate-800">
                Grupo
              </label>
              <select
                id={ids.group}
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setPage(1);
                }}
                disabled={!yearId}
                className={FIELD}
              >
                <option value="">{yearId ? 'Todos' : 'Elige un ciclo'}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.grade}.º {g.code}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div>
          <label htmlFor={ids.state} className="block text-sm font-semibold text-slate-800">
            Estado
          </label>
          <select
            id={ids.state}
            value={active}
            onChange={(e) => {
              setActive(e.target.value);
              setPage(1);
            }}
            className={FIELD}
          >
            <option value="">Todos</option>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
          </select>
        </div>
      </div>

      <div className={`mt-4 grid gap-6 ${selected ? 'lg:grid-cols-[2fr_3fr]' : ''}`}>
        <div aria-live="polite" aria-busy={loading}>
          {error ? (
            <ErrorNotice message={error} onRetry={retry} />
          ) : loading && !data ? (
            <p role="status" className="py-6 text-center text-slate-700">
              Cargando alumnos…
            </p>
          ) : data && data.items.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-400 px-4 py-8 text-center text-slate-700">
              {filtered
                ? 'No hay alumnos que coincidan con los filtros.'
                : perms.canManageStudents
                  ? 'Todavía no hay alumnos. Registra el primero con «Registrar alumno».'
                  : 'No hay alumnos que puedas consultar.'}
            </p>
          ) : (
            data && (
              <>
                <ul
                  className="divide-y divide-tinto-100 rounded-md border border-tinto-100"
                  aria-label="Alumnos"
                >
                  {data.items.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(s.id)}
                        aria-current={selected === s.id ? 'true' : undefined}
                        className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-tinto-50 sm:flex-row sm:items-center sm:justify-between ${selected === s.id ? 'bg-tinto-50' : ''}`}
                      >
                        <span>
                          <span className="block font-semibold text-slate-900">{fullName(s)}</span>
                          <span className="block text-sm text-slate-700">
                            {s.schoolCode ? `Código ${s.schoolCode} · ` : ''}
                            {s.currentGroup ? groupLabel(s.currentGroup) : 'Sin grupo vigente'}
                          </span>
                        </span>
                        {!s.isActive && (
                          <span className="inline-block rounded-full border border-slate-500 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                            Inactivo
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                <nav
                  className="mt-3 flex items-center justify-between gap-2 text-sm"
                  aria-label="Paginación de alumnos"
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
                    {data.total === 1 ? 'alumno' : 'alumnos'}
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
        {selected && (
          <StudentDetail
            key={selected}
            studentId={selected}
            perms={perms}
            years={years}
            onChanged={changed}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {creating && (
        <StudentDialog
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            setCreating(false);
            setSelected(s.id);
            changed(`Alumno ${fullName(s)} registrado. Ahora puedes inscribirlo en un ciclo.`);
          }}
        />
      )}
    </section>
  );
}
