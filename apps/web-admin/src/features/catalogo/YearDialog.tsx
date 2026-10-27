import { useId, useRef, useState, type FormEvent } from 'react';
import {
  SCHOOL_YEAR_MAX_DAYS,
  SCHOOL_YEAR_MIN_DAYS,
  schoolYearLengthDays,
  type SchoolYearDto,
  type UpdateSchoolYearBody,
} from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD,
  FieldError,
  catalogErrorMessage,
  useFocusFirstInvalid,
} from './shared';

type Errors = { name?: string; startsOn?: string; endsOn?: string };

/** Mismas reglas que el contrato compartido (la API las vuelve a validar y ademas revisa traslapes con otros ciclos). */
export function validateYear(v: { name: string; startsOn: string; endsOn: string }): Errors {
  const errors: Errors = {};
  if (!v.name) errors.name = 'Escribe el nombre del ciclo, por ejemplo «2026-2027».';
  else if (v.name.length > 50) errors.name = 'El nombre admite hasta 50 caracteres.';
  if (!v.startsOn) errors.startsOn = 'Indica la fecha de inicio.';
  if (!v.endsOn) errors.endsOn = 'Indica la fecha de fin.';
  if (v.startsOn && v.endsOn) {
    if (v.endsOn <= v.startsOn)
      errors.endsOn = 'La fecha de fin debe ser posterior a la de inicio.';
    else {
      const days = schoolYearLengthDays(v.startsOn, v.endsOn);
      if (days < SCHOOL_YEAR_MIN_DAYS || days > SCHOOL_YEAR_MAX_DAYS)
        errors.endsOn = `El ciclo debe durar entre ${SCHOOL_YEAR_MIN_DAYS} y ${SCHOOL_YEAR_MAX_DAYS} días (dura ${days}).`;
    }
  }
  return errors;
}

/** Alta o edicion de un ciclo. Solo se envian los campos que cambiaron. Un ciclo nunca se borra. */
export function YearDialog({
  year,
  onSaved,
  onClose,
}: {
  /** Si se indica, se edita ese ciclo; si no, se crea uno nuevo. */
  year?: SchoolYearDto;
  onSaved: (saved: SchoolYearDto) => void;
  onClose: () => void;
}) {
  const ids = { name: useId(), startsOn: useId(), endsOn: useId() };
  const [name, setName] = useState(year?.name ?? '');
  const [startsOn, setStartsOn] = useState(year?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(year?.endsOn ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const values = { name: name.trim(), startsOn, endsOn };
    const next = validateYear(values);
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      if (year) {
        const changes: UpdateSchoolYearBody = {};
        if (values.name !== year.name) changes.name = values.name;
        if (values.startsOn !== year.startsOn) changes.startsOn = values.startsOn;
        if (values.endsOn !== year.endsOn) changes.endsOn = values.endsOn;
        if (Object.keys(changes).length === 0) {
          setFormError('No hay cambios que guardar.');
          setBusy(false);
          return;
        }
        onSaved(await api.updateSchoolYear(year.id, changes));
      } else {
        onSaved(await api.createSchoolYear(values));
      }
    } catch (error) {
      setFormError(
        catalogErrorMessage(
          error,
          year ? 'No se pudo guardar el ciclo.' : 'No se pudo crear el ciclo.',
        ),
      );
      setBusy(false);
    }
  }

  const describe = (key: keyof Errors, id: string) => (errors[key] ? `${id}-e` : undefined);
  return (
    <Modal
      title={year ? `Editar ciclo ${year.name}` : 'Nuevo ciclo escolar'}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        {year?.isActive && (
          <p className="text-sm text-slate-700">
            Este es el ciclo vigente: sus fechas deben seguir incluyendo el día de hoy.
          </p>
        )}
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {formError}
          </p>
        )}
        <div>
          <label htmlFor={ids.name} className="block text-sm font-semibold">
            Nombre del ciclo
          </label>
          <input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            disabled={busy}
            autoComplete="off"
            className={FIELD}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describe('name', ids.name)}
          />
          <FieldError id={`${ids.name}-e`} message={errors.name} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.startsOn} className="block text-sm font-semibold">
              Inicio
            </label>
            <input
              id={ids.startsOn}
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              disabled={busy}
              className={FIELD}
              aria-invalid={errors.startsOn ? true : undefined}
              aria-describedby={describe('startsOn', ids.startsOn)}
            />
            <FieldError id={`${ids.startsOn}-e`} message={errors.startsOn} />
          </div>
          <div>
            <label htmlFor={ids.endsOn} className="block text-sm font-semibold">
              Fin
            </label>
            <input
              id={ids.endsOn}
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
              disabled={busy}
              className={FIELD}
              aria-invalid={errors.endsOn ? true : undefined}
              aria-describedby={describe('endsOn', ids.endsOn)}
            />
            <FieldError id={`${ids.endsOn}-e`} message={errors.endsOn} />
          </div>
        </div>
        <p className="text-xs text-slate-600">
          Los ciclos no pueden traslaparse y duran entre {SCHOOL_YEAR_MIN_DAYS} y{' '}
          {SCHOOL_YEAR_MAX_DAYS} días. Crear un ciclo no lo activa.
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? 'Guardando…' : year ? 'Guardar cambios' : 'Crear ciclo'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
