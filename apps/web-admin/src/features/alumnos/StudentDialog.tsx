import { useId, useRef, useState, type FormEvent } from 'react';
import {
  PERSON_NAME_MAX,
  PERSON_NAME_PATTERN,
  SCHOOL_CODE_MAX,
  SCHOOL_CODE_PATTERN,
  normalizePersonName,
  normalizeSchoolCode,
  type StudentDto,
  type UpdateStudentBody,
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
import { studentsErrorMessage } from './shared';

type Errors = { givenNames?: string; familyName?: string; schoolCode?: string };

const nameError = (raw: string, label: string): string | undefined => {
  const v = normalizePersonName(raw);
  if (!v) return `Escribe ${label}.`;
  if (v.length > PERSON_NAME_MAX) return `Máximo ${PERSON_NAME_MAX} caracteres.`;
  if (!PERSON_NAME_PATTERN.test(v)) return 'Solo letras, espacios, apóstrofo, guion y punto.';
  return undefined;
};

/** Mismas reglas que el contrato compartido (la API las vuelve a validar). */
export function validateStudent(v: {
  givenNames: string;
  familyName: string;
  schoolCode: string;
}): Errors {
  const errors: Errors = {};
  const g = nameError(v.givenNames, 'el nombre o nombres');
  const f = nameError(v.familyName, 'los apellidos');
  if (g) errors.givenNames = g;
  if (f) errors.familyName = f;
  const code = normalizeSchoolCode(v.schoolCode);
  if (code) {
    if (code.length > SCHOOL_CODE_MAX) errors.schoolCode = `Máximo ${SCHOOL_CODE_MAX} caracteres.`;
    else if (!SCHOOL_CODE_PATTERN.test(code))
      errors.schoolCode = 'Letras A-Z sin acentos, números y guiones entre bloques.';
  }
  return errors;
}

/**
 * Alta o correccion de un alumno. Solo nombre, apellidos y codigo escolar opcional (datos minimos de menores). El alumno NO es una
 * cuenta de acceso: aqui no hay correo ni contrasena.
 */
export function StudentDialog({
  student,
  onSaved,
  onClose,
}: {
  student?: StudentDto;
  onSaved: (saved: StudentDto) => void;
  onClose: () => void;
}) {
  const ids = { given: useId(), family: useId(), code: useId() };
  const [givenNames, setGivenNames] = useState(student?.givenNames ?? '');
  const [familyName, setFamilyName] = useState(student?.familyName ?? '');
  const [schoolCode, setSchoolCode] = useState(student?.schoolCode ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next = validateStudent({ givenNames, familyName, schoolCode });
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    const values = {
      givenNames: normalizePersonName(givenNames),
      familyName: normalizePersonName(familyName),
      schoolCode: normalizeSchoolCode(schoolCode) || null,
    };
    setBusy(true);
    try {
      if (student) {
        const changes: UpdateStudentBody = {};
        if (values.givenNames !== student.givenNames) changes.givenNames = values.givenNames;
        if (values.familyName !== student.familyName) changes.familyName = values.familyName;
        if (values.schoolCode !== student.schoolCode) changes.schoolCode = values.schoolCode;
        if (Object.keys(changes).length === 0) {
          setFormError('No hay cambios que guardar.');
          setBusy(false);
          return;
        }
        onSaved(await api.updateStudent(student.id, changes));
      } else {
        onSaved(await api.createStudent(values));
      }
    } catch (error) {
      setFormError(
        studentsErrorMessage(
          error,
          student ? 'No se pudo guardar el alumno.' : 'No se pudo registrar el alumno.',
        ),
      );
      setBusy(false);
    }
  }

  const describe = (key: keyof Errors, id: string) => (errors[key] ? `${id}-e` : undefined);
  return (
    <Modal
      title={student ? 'Corregir datos del alumno' : 'Registrar alumno'}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        <p className="text-sm text-slate-700">
          Solo se guardan el nombre, los apellidos y, si existe, el código escolar. El alumno no es
          una cuenta de acceso al sistema.
        </p>
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {formError}
          </p>
        )}
        <div>
          <label htmlFor={ids.given} className="block text-sm font-semibold">
            Nombre o nombres
          </label>
          <input
            id={ids.given}
            value={givenNames}
            onChange={(e) => setGivenNames(e.target.value)}
            disabled={busy}
            autoComplete="off"
            className={FIELD}
            aria-invalid={errors.givenNames ? true : undefined}
            aria-describedby={describe('givenNames', ids.given)}
          />
          <FieldError id={`${ids.given}-e`} message={errors.givenNames} />
        </div>
        <div>
          <label htmlFor={ids.family} className="block text-sm font-semibold">
            Apellidos
          </label>
          <input
            id={ids.family}
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
            disabled={busy}
            autoComplete="off"
            className={FIELD}
            aria-invalid={errors.familyName ? true : undefined}
            aria-describedby={describe('familyName', ids.family)}
          />
          <FieldError id={`${ids.family}-e`} message={errors.familyName} />
        </div>
        <div>
          <label htmlFor={ids.code} className="block text-sm font-semibold">
            Código escolar (opcional)
          </label>
          <input
            id={ids.code}
            value={schoolCode}
            onChange={(e) => setSchoolCode(e.target.value)}
            disabled={busy}
            autoComplete="off"
            className={`${FIELD} uppercase`}
            aria-invalid={errors.schoolCode ? true : undefined}
            aria-describedby={`${ids.code}-h${errors.schoolCode ? ` ${ids.code}-e` : ''}`}
          />
          <p id={`${ids.code}-h`} className="mt-1 text-xs text-slate-600">
            Identificador administrativo de la escuela. Si lo escribes, no puede repetirse en otro
            alumno.
          </p>
          <FieldError id={`${ids.code}-e`} message={errors.schoolCode} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? 'Guardando…' : student ? 'Guardar cambios' : 'Registrar alumno'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
