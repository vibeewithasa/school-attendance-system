import { useEffect, type RefObject } from 'react';
import type { GroupDto, SchoolYearDto, Shift } from '@eta15/shared-contracts';
import { ApiError } from '../../lib/api';
import { adminErrorMessage } from '../personal/shared';

export const SHIFT_LABELS: Record<Shift, string> = {
  matutino: 'Matutino',
  vespertino: 'Vespertino',
};
export const shiftLabel = (shift: Shift | null) => (shift ? SHIFT_LABELS[shift] : 'Sin turno');
export const GRADE_LABELS = ['1.º', '2.º', '3.º'] as const;
export const gradeLabel = (grade: number) => `${grade}.º`;

/** Fecha de calendario (sin hora): se muestra tal cual, sin desfases por zona horaria. */
export const formatDay = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', { dateStyle: 'medium' });

/**
 * Mensajes del catalogo. Los rechazos de negocio del servidor (409 traslapes/duplicados/historial y 400 de reglas como
 * "solo el ciclo que incluye hoy se activa") ya traen texto comprensible y sin detalles internos; el resto se resume.
 */
export function catalogErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === 'CATALOG_WRITE_UNAVAILABLE')
      return 'La base de datos aún no autoriza modificar el catálogo escolar. La consulta sigue disponible; avisa a administración técnica.';
    if (error.status === 400 && error.code === 'VALIDATION' && error.message) return error.message;
    if (error.status === 401) return 'Tu sesión terminó. Inicia sesión de nuevo.';
  }
  return adminErrorMessage(error, fallback);
}

const BADGE = 'inline-block rounded-full border px-2 py-0.5 text-xs font-semibold';

export function YearBadges({ year }: { year: SchoolYearDto }) {
  return (
    <span className="flex flex-wrap gap-1">
      {year.isActive ? (
        <span className={`${BADGE} border-green-700 bg-green-50 text-green-900`}>Vigente</span>
      ) : (
        <span className={`${BADGE} border-slate-500 bg-slate-100 text-slate-700`}>No vigente</span>
      )}
      {year.period === 'past' && (
        <span className={`${BADGE} border-slate-500 bg-white text-slate-700`}>Histórico</span>
      )}
      {year.period === 'future' && (
        <span className={`${BADGE} border-amber-700 bg-amber-50 text-amber-900`}>Próximo</span>
      )}
      {year.period === 'current' && !year.isActive && (
        <span className={`${BADGE} border-amber-700 bg-amber-50 text-amber-900`}>
          En curso sin activar
        </span>
      )}
    </span>
  );
}

export function GroupBadges({ group }: { group: GroupDto }) {
  return (
    <span className="flex flex-wrap gap-1">
      {group.isActive ? (
        <span className={`${BADGE} border-green-700 bg-green-50 text-green-900`}>Activo</span>
      ) : (
        <span className={`${BADGE} border-slate-500 bg-slate-100 text-slate-700`}>Inactivo</span>
      )}
      {group.historical && (
        <span className={`${BADGE} border-slate-500 bg-white text-slate-700`}>Histórico</span>
      )}
    </span>
  );
}

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
