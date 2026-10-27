import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  GroupDto,
  PrefectAssignmentDto,
  PrefectCandidateDto,
  SchoolYearDto,
} from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD,
  FieldError,
  useFocusFirstInvalid,
} from '../../components/form';
import { api } from '../../lib/api';
import { formatDay, prefectErrorMessage } from './shared';

type Errors = { user?: string; year?: string; groups?: string; startsOn?: string; endsOn?: string };

/**
 * Asignar uno o varios grupos a una prefecta. El ciclo no se envia: el servidor lo deduce del grupo. Sin fechas, empieza hoy y dura
 * hasta cerrarla o hasta el fin del ciclo; con "hasta" es una cobertura temporal. No hay asignacion automatica: cada grupo se confirma.
 * Se crea una asignacion por grupo; si alguna falla, las demas ya creadas se conservan y se explica cual fallo.
 */
export function AssignDialog({
  candidates,
  years,
  onDone,
  onPartial,
  onClose,
}: {
  candidates: PrefectCandidateDto[];
  years: SchoolYearDto[];
  /** Todas las asignaciones pedidas se crearon (acumuladas, incluidas las de intentos anteriores). */
  onDone: (created: PrefectAssignmentDto[]) => void;
  /** Resultado parcial: algo ya se creo y el dialogo sigue abierto; la pagina debe refrescar su lista. */
  onPartial?: (created: PrefectAssignmentDto[]) => void;
  onClose: () => void;
}) {
  const ids = { user: useId(), year: useId(), start: useId(), end: useId() };
  const usable = years.filter((y) => y.period !== 'past');
  const [userId, setUserId] = useState('');
  const [yearId, setYearId] = useState(usable.find((y) => y.isActive)?.id ?? usable[0]?.id ?? '');
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Asignaciones ya creadas en intentos anteriores de este mismo dialogo (se conservan: el reintento solo envia las que faltan).
  const [assigned, setAssigned] = useState<PrefectAssignmentDto[]>([]);
  const [failures, setFailures] = useState<Array<{ label: string; message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);
  const year = usable.find((y) => y.id === yearId);

  useEffect(() => {
    if (!yearId) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    setGroups(null);
    setPicked(new Set());
    api
      .listGroups({ schoolYearId: yearId, isActive: true, pageSize: 100 })
      .then((r) => !cancelled && setGroups(r.items))
      .catch(() => !cancelled && setGroups([]));
    return () => {
      cancelled = true;
    };
  }, [yearId]);

  // Cambiar de prefecta o de ciclo empieza un lote nuevo: lo asignado antes ya no pertenece a esta seleccion.
  useEffect(() => {
    setAssigned([]);
  }, [userId, yearId]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {};
    if (!userId) next.user = 'Elige a la prefecta.';
    if (!year) next.year = 'Elige el ciclo escolar.';
    if (picked.size === 0) next.groups = 'Elige al menos un grupo.';
    if (year && startsOn && (startsOn < year.startsOn || startsOn > year.endsOn))
      next.startsOn = `Debe estar entre ${formatDay(year.startsOn)} y ${formatDay(year.endsOn)}.`;
    if (endsOn && startsOn && endsOn < startsOn)
      next.endsOn = 'La fecha final no puede ser anterior a la inicial.';
    else if (year && endsOn && (endsOn < year.startsOn || endsOn > year.endsOn))
      next.endsOn = `Debe estar entre ${formatDay(year.startsOn)} y ${formatDay(year.endsOn)}.`;
    setErrors(next);
    setFormError(null);
    setFailures([]);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    const created: PrefectAssignmentDto[] = [];
    const failed: Array<{ label: string; message: string }> = [];
    const chosen = (groups ?? []).filter((g) => picked.has(g.id));
    for (const g of chosen) {
      try {
        created.push(
          await api.createPrefectAssignment({
            userId,
            groupId: g.id,
            ...(startsOn ? { startsOn } : {}),
            ...(endsOn ? { endsOn } : {}),
          }),
        );
      } catch (error) {
        failed.push({
          label: `${g.grade}.º ${g.code}`,
          message: prefectErrorMessage(error, 'No se pudo asignar.'),
        });
      }
    }
    setBusy(false);
    const everything = [...assigned, ...created];
    if (failed.length === 0) return onDone(everything);
    if (created.length > 0) {
      // Resultado PARCIAL: lo creado se conserva (no es todo-o-nada), se quita de la seleccion para que el reintento no lo repita
      // y se avisa a la pagina para que muestre ya esas asignaciones.
      const okGroups = new Set(created.map((c) => c.group.id));
      setPicked(new Set([...picked].filter((id) => !okGroups.has(id))));
      setAssigned(everything);
      onPartial?.(everything);
      setFormError(
        `Resultado parcial: se asignaron ${created.length} de ${chosen.length} grupos y ${failed.length} no. Las asignaciones creadas se conservan; corrige lo que falló y vuelve a intentar solo con los grupos pendientes.`,
      );
    } else {
      setFormError(
        assigned.length > 0
          ? 'No se pudo asignar ninguno de los grupos pendientes. Lo asignado antes se conserva.'
          : 'No se pudo asignar ningún grupo.',
      );
    }
    setFailures(failed);
  }

  const describe = (key: keyof Errors, id: string) => (errors[key] ? `${id}-e` : undefined);
  return (
    <Modal title="Asignar grupos a prefectura" onClose={onClose} closeDisabled={busy}>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        <p className="text-sm text-slate-700">
          Una prefecta puede tener varios grupos y un grupo puede tener varias prefectas (por
          ejemplo, una cobertura temporal). Nada se asigna automáticamente.
        </p>
        {formError && (
          <div
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            <p>{formError}</p>
            {assigned.length > 0 && (
              <p className="mt-1">
                <strong>Asignados correctamente:</strong>{' '}
                {assigned.map((a) => `${a.group.grade}.º ${a.group.code}`).join(', ')}.
              </p>
            )}
            {failures.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {failures.map((f) => (
                  <li key={f.label}>
                    <strong>{f.label}:</strong> {f.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <label htmlFor={ids.user} className="block text-sm font-semibold">
            Prefecta
          </label>
          <select
            id={ids.user}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={busy}
            className={FIELD}
            aria-invalid={errors.user ? true : undefined}
            aria-describedby={describe('user', ids.user)}
          >
            <option value="">
              {candidates.length === 0 ? 'No hay prefectas disponibles' : 'Elige una prefecta'}
            </option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} · {c.email}
              </option>
            ))}
          </select>
          <FieldError id={`${ids.user}-e`} message={errors.user} />
        </div>
        <div>
          <label htmlFor={ids.year} className="block text-sm font-semibold">
            Ciclo escolar
          </label>
          <select
            id={ids.year}
            value={yearId}
            onChange={(e) => setYearId(e.target.value)}
            disabled={busy}
            className={FIELD}
            aria-invalid={errors.year ? true : undefined}
            aria-describedby={describe('year', ids.year)}
          >
            {usable.length === 0 && <option value="">No hay ciclos disponibles</option>}
            {usable.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
                {y.isActive ? ' (vigente)' : ''}
              </option>
            ))}
          </select>
          <FieldError id={`${ids.year}-e`} message={errors.year} />
        </div>
        <fieldset
          aria-invalid={errors.groups ? true : undefined}
          aria-describedby={errors.groups ? 'grupos-e' : undefined}
        >
          <legend className="block text-sm font-semibold">Grupos</legend>
          {groups === null ? (
            <p role="status" className="mt-1 text-sm text-slate-700">
              Cargando grupos…
            </p>
          ) : groups.length === 0 ? (
            <p className="mt-1 text-sm text-slate-700">Este ciclo no tiene grupos activos.</p>
          ) : (
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {groups.map((g) => (
                <li key={g.id}>
                  <label className="flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={picked.has(g.id)}
                      onChange={() => toggle(g.id)}
                      disabled={busy}
                      aria-invalid={errors.groups ? true : undefined}
                    />
                    <span>
                      {g.grade}.º {g.code}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <FieldError id="grupos-e" message={errors.groups} />
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.start} className="block text-sm font-semibold">
              Desde (opcional)
            </label>
            <input
              id={ids.start}
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              disabled={busy}
              className={FIELD}
              aria-invalid={errors.startsOn ? true : undefined}
              aria-describedby={`${ids.start}-h${errors.startsOn ? ` ${ids.start}-e` : ''}`}
            />
            <p id={`${ids.start}-h`} className="mt-1 text-xs text-slate-600">
              Vacío = hoy. No puede ser anterior a hoy.
            </p>
            <FieldError id={`${ids.start}-e`} message={errors.startsOn} />
          </div>
          <div>
            <label htmlFor={ids.end} className="block text-sm font-semibold">
              Hasta (cobertura temporal, opcional)
            </label>
            <input
              id={ids.end}
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
              disabled={busy}
              className={FIELD}
              aria-invalid={errors.endsOn ? true : undefined}
              aria-describedby={`${ids.end}-h${errors.endsOn ? ` ${ids.end}-e` : ''}`}
            />
            <p id={`${ids.end}-h`} className="mt-1 text-xs text-slate-600">
              Último día con acceso. Vacío = hasta cerrarla o hasta el fin del ciclo.
            </p>
            <FieldError id={`${ids.end}-e`} message={errors.endsOn} />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? 'Asignando…' : 'Asignar grupos'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
