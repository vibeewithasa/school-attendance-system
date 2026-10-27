import { useId, useState } from 'react';
import type { SchoolYearDto } from '@eta15/shared-contracts';
import { ConfirmDialog } from '../../components/Modal';
import { api } from '../../lib/api';
import { YearDialog } from './YearDialog';
import {
  BTN_PRIMARY,
  BTN_SMALL,
  FIELD,
  YearBadges,
  catalogErrorMessage,
  formatDay,
} from './shared';

type Pending = { kind: 'activate' | 'deactivate'; year: SchoolYearDto };

/**
 * Ciclos escolares. Los controles de escritura solo aparecen con `catalog:manage_school` (el servidor vuelve a autorizar). Solo el
 * ciclo que incluye hoy puede activarse y los ciclos terminados son historial: no se editan.
 */
export function YearsPanel({
  years,
  canManage,
  onChanged,
}: {
  years: SchoolYearDto[];
  canManage: boolean;
  /** Avisa que algo cambio (recarga el catalogo) con el texto de confirmacion. */
  onChanged: (notice: string) => void;
}) {
  const filterId = useId();
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [editing, setEditing] = useState<SchoolYearDto | 'new' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = years.filter((y) =>
    filter === 'all' ? true : filter === 'active' ? y.isActive : !y.isActive,
  );

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { kind, year } = pending;
      if (kind === 'activate') await api.activateSchoolYear(year.id);
      else await api.deactivateSchoolYear(year.id);
      setPending(null);
      onChanged(
        kind === 'activate'
          ? `El ciclo ${year.name} es ahora el ciclo vigente.`
          : `El ciclo ${year.name} ya no es el ciclo vigente.`,
      );
    } catch (e) {
      setError(catalogErrorMessage(e, 'No se pudo cambiar el estado del ciclo.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ciclos-titulo">
      <h2 id="ciclos-titulo" className="sr-only">
        Ciclos escolares
      </h2>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-64">
          <label htmlFor={filterId} className="block text-sm font-semibold text-slate-800">
            Vigencia
          </label>
          <select
            id={filterId}
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className={FIELD}
          >
            <option value="all">Todos los ciclos</option>
            <option value="active">Solo el vigente</option>
            <option value="inactive">No vigentes</option>
          </select>
        </div>
        {canManage && (
          <button type="button" onClick={() => setEditing('new')} className={BTN_PRIMARY}>
            Nuevo ciclo
          </button>
        )}
      </div>

      <div className="mt-4">
        {shown.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-400 px-4 py-8 text-center text-slate-700">
            {years.length === 0
              ? canManage
                ? 'Todavía no hay ciclos escolares. Crea el primero con «Nuevo ciclo».'
                : 'Todavía no hay ciclos escolares registrados.'
              : 'No hay ciclos que coincidan con el filtro.'}
          </p>
        ) : (
          <ul
            className="divide-y divide-tinto-100 rounded-md border border-tinto-100"
            aria-label="Ciclos escolares"
          >
            {shown.map((year) => (
              <li
                key={year.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-semibold text-slate-900">{year.name}</p>
                  <p className="text-sm text-slate-700">
                    {formatDay(year.startsOn)} — {formatDay(year.endsOn)} · {year.groupCount}{' '}
                    {year.groupCount === 1 ? 'grupo' : 'grupos'}
                  </p>
                  <div className="mt-1">
                    <YearBadges year={year} />
                  </div>
                </div>
                {canManage && year.period !== 'past' && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={BTN_SMALL}
                      onClick={() => setEditing(year)}
                      aria-label={`Editar ciclo ${year.name}`}
                    >
                      Editar
                    </button>
                    {year.isActive ? (
                      <button
                        type="button"
                        className={BTN_SMALL}
                        onClick={() => setPending({ kind: 'deactivate', year })}
                        aria-label={`Desactivar ciclo ${year.name}`}
                      >
                        Desactivar
                      </button>
                    ) : (
                      year.period === 'current' && (
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() => setPending({ kind: 'activate', year })}
                          aria-label={`Activar ciclo ${year.name}`}
                        >
                          Activar
                        </button>
                      )
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <YearDialog
          year={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            const created = editing === 'new';
            setEditing(null);
            onChanged(created ? `Ciclo ${saved.name} creado.` : `Ciclo ${saved.name} actualizado.`);
          }}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={pending.kind === 'activate' ? 'Activar ciclo escolar' : 'Desactivar ciclo escolar'}
          message={
            pending.kind === 'activate' ? (
              <p>
                ¿Activar el ciclo <strong>{pending.year.name}</strong> como ciclo vigente? Si hay
                otro ciclo vigente, dejará de serlo. No se borra ningún dato.
              </p>
            ) : (
              <p>
                ¿Desactivar el ciclo vigente <strong>{pending.year.name}</strong>? Sus grupos se
                conservan; el sistema quedará sin ciclo vigente hasta que actives otro.
              </p>
            )
          }
          confirmLabel={pending.kind === 'activate' ? 'Activar ciclo' : 'Desactivar ciclo'}
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
