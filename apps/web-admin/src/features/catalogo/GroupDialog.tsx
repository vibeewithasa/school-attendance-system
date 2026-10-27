import { useId, useRef, useState, type FormEvent } from 'react';
import {
  GROUP_CODE_PATTERN,
  SHIFTS,
  entryTime,
  normalizeGroupCode,
  type GroupDto,
  type SchoolYearDto,
  type Shift,
  type UpdateGroupBody,
} from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD,
  FieldError,
  useFocusFirstInvalid,
  SHIFT_LABELS,
  catalogErrorMessage,
  gradeLabel,
} from './shared';

type Errors = { schoolYearId?: string; code?: string; time?: string };

/** Mismas reglas que el contrato compartido; la API las vuelve a validar. `time` es "HH:MM" o vacio (sin configurar). */
export function validateGroup(v: { schoolYearId: string; code: string; time: string }): Errors {
  const errors: Errors = {};
  if (!v.schoolYearId) errors.schoolYearId = 'Elige el ciclo escolar.';
  const code = normalizeGroupCode(v.code);
  if (!code) errors.code = 'Escribe el identificador del grupo, por ejemplo «A».';
  else if (code.length > 10) errors.code = 'El identificador admite hasta 10 caracteres.';
  else if (!GROUP_CODE_PATTERN.test(code))
    errors.code =
      'Usa letras sin acentos, números y, si hace falta, un espacio o guion entre partes.';
  if (v.time && !entryTime.safeParse(v.time).success)
    errors.time = 'Indica una hora válida entre 00:00 y 23:59 (sin segundos).';
  return errors;
}

/**
 * Alta o edicion de un grupo. El ciclo y el grado se eligen solo al crear: despues son historial y no cambian.
 * La hora de entrada es opcional y no depende del turno (p. ej. 07:00 o 07:50).
 */
export function GroupDialog({
  group,
  years,
  defaultYearId,
  onSaved,
  onClose,
}: {
  group?: GroupDto;
  /** Ciclos disponibles para crear grupos (no historicos). */
  years: SchoolYearDto[];
  defaultYearId?: string;
  onSaved: (saved: GroupDto) => void;
  onClose: () => void;
}) {
  const ids = { year: useId(), grade: useId(), code: useId(), shift: useId(), time: useId() };
  const [schoolYearId, setSchoolYearId] = useState(
    group?.schoolYearId ?? defaultYearId ?? years.find((y) => y.isActive)?.id ?? years[0]?.id ?? '',
  );
  const [grade, setGrade] = useState(group?.grade ?? 1);
  const [code, setCode] = useState(group?.code ?? '');
  const [shift, setShift] = useState<Shift | ''>(group?.shift ?? '');
  const [time, setTime] = useState(group?.expectedEntryTime ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next = validateGroup({ schoolYearId, code, time });
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      const normalized = normalizeGroupCode(code);
      if (group) {
        const changes: UpdateGroupBody = {};
        if (normalized !== group.code) changes.code = normalized;
        if ((shift || null) !== group.shift) changes.shift = shift || null;
        if ((time || null) !== group.expectedEntryTime) changes.expectedEntryTime = time || null;
        if (Object.keys(changes).length === 0) {
          setFormError('No hay cambios que guardar.');
          setBusy(false);
          return;
        }
        onSaved(await api.updateGroup(group.id, changes));
      } else {
        onSaved(
          await api.createGroup({
            schoolYearId,
            grade,
            code: normalized,
            shift: shift || null,
            expectedEntryTime: time || null,
          }),
        );
      }
    } catch (error) {
      setFormError(
        catalogErrorMessage(
          error,
          group ? 'No se pudo guardar el grupo.' : 'No se pudo crear el grupo.',
        ),
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      title={group ? `Editar grupo ${gradeLabel(group.grade)} ${group.code}` : 'Nuevo grupo'}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {formError}
          </p>
        )}
        {group ? (
          <p className="text-sm text-slate-700">
            Ciclo <strong>{group.schoolYearName}</strong> · grado{' '}
            <strong>{gradeLabel(group.grade)}</strong>. El ciclo y el grado no se pueden cambiar: si
            te equivocaste, desactiva este grupo y crea otro.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.year} className="block text-sm font-semibold">
                Ciclo escolar
              </label>
              <select
                id={ids.year}
                value={schoolYearId}
                onChange={(e) => setSchoolYearId(e.target.value)}
                disabled={busy}
                className={FIELD}
                aria-invalid={errors.schoolYearId ? true : undefined}
                aria-describedby={errors.schoolYearId ? `${ids.year}-e` : undefined}
              >
                {years.length === 0 && <option value="">No hay ciclos disponibles</option>}
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                    {y.isActive ? ' (vigente)' : ''}
                  </option>
                ))}
              </select>
              <FieldError id={`${ids.year}-e`} message={errors.schoolYearId} />
            </div>
            <div>
              <label htmlFor={ids.grade} className="block text-sm font-semibold">
                Grado
              </label>
              <select
                id={ids.grade}
                value={grade}
                onChange={(e) => setGrade(Number(e.target.value))}
                disabled={busy}
                className={FIELD}
              >
                {[1, 2, 3].map((g) => (
                  <option key={g} value={g}>
                    {gradeLabel(g)} grado
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.code} className="block text-sm font-semibold">
              Grupo
            </label>
            <input
              id={ids.code}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={20}
              disabled={busy}
              autoComplete="off"
              className={`${FIELD} uppercase`}
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={errors.code ? `${ids.code}-e` : undefined}
            />
            <FieldError id={`${ids.code}-e`} message={errors.code} />
          </div>
          <div>
            <label htmlFor={ids.shift} className="block text-sm font-semibold">
              Turno
            </label>
            <select
              id={ids.shift}
              value={shift}
              onChange={(e) => setShift(e.target.value as Shift | '')}
              disabled={busy}
              className={FIELD}
            >
              <option value="">Sin turno</option>
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  {SHIFT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor={ids.time} className="block text-sm font-semibold">
            Hora de entrada (opcional)
          </label>
          <input
            id={ids.time}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={busy}
            className={FIELD}
            aria-invalid={errors.time ? true : undefined}
            aria-describedby={`${ids.time}-h${errors.time ? ` ${ids.time}-e` : ''}`}
          />
          <p id={`${ids.time}-h`} className="mt-1 text-xs text-slate-600">
            Hora local de la escuela a la que este grupo debe estar en la entrada, por ejemplo 07:00
            o 07:50. Déjala vacía si aún no se configura; no depende del turno.
          </p>
          <FieldError id={`${ids.time}-e`} message={errors.time} />
          {time && !busy && (
            <button
              type="button"
              onClick={() => setTime('')}
              className="mt-1 text-sm font-semibold text-tinto-700 underline"
            >
              Quitar la hora de entrada
            </button>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? 'Guardando…' : group ? 'Guardar cambios' : 'Crear grupo'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
