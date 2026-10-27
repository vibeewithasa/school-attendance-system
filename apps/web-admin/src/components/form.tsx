import { useEffect, type RefObject } from 'react';

/** Estilos y ayudas de formularios compartidas por las secciones (catalogo, alumnos). */
export const FIELD =
  'mt-1 block w-full rounded-md border border-slate-400 px-3 py-2 disabled:bg-slate-100';
export const BTN_PRIMARY =
  'rounded-md bg-tinto-700 px-4 py-2 font-semibold text-white hover:bg-tinto-800 disabled:cursor-wait disabled:opacity-70';
export const BTN_SECONDARY =
  'rounded-md border border-slate-400 px-4 py-2 font-semibold hover:bg-slate-50 disabled:opacity-60';
export const BTN_SMALL =
  'rounded-md border border-tinto-700 px-3 py-2 text-sm font-semibold text-tinto-700 hover:bg-tinto-50 disabled:opacity-60';

export function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="mt-1 text-sm text-tinto-700">
      {message}
    </p>
  ) : null;
}

/**
 * Accesibilidad: tras un envio con errores, el foco pasa al primer campo marcado como invalido que sea visible y editable
 * (un lector de pantalla lo anuncia con su mensaje de error). `errors` cambia de identidad en cada envio fallido.
 */
export function useFocusFirstInvalid(root: RefObject<HTMLElement | null>, errors: object): void {
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    const fields = root.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]') ?? [];
    const target = [...fields].find(
      (el) =>
        !(el as HTMLInputElement).disabled &&
        !el.closest('[hidden],[aria-hidden="true"]') &&
        (typeof el.checkVisibility !== 'function' || el.checkVisibility()),
    );
    target?.focus();
  }, [errors, root]);
}
