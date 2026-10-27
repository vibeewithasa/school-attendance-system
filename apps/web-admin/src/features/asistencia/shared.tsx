import type {
  AttendanceDayDto,
  AttendanceDayStatus,
  AttendanceRecordStatus,
  GroupRefDto,
} from '@eta15/shared-contracts';
import { useEffect, useRef } from 'react';
import { ApiError } from '../../lib/api';
import { gradeLabel, shiftLabel } from '../catalogo/shared';
import { adminErrorMessage } from '../personal/shared';

export const BADGE = 'inline-block rounded-full border px-2 py-0.5 text-xs font-semibold';

export const DAY_STATUS_LABELS: Record<AttendanceDayStatus, string> = {
  draft: 'Borrador',
  finalized: 'Finalizada',
};
export const DAY_STATUS_CLS: Record<AttendanceDayStatus, string> = {
  draft: 'border-amber-700 bg-amber-50 text-amber-900',
  finalized: 'border-green-700 bg-green-50 text-green-900',
};
export const MARK_LABELS: Record<AttendanceRecordStatus, string> = {
  present: 'Presente',
  absent: 'Ausente',
  pending: 'Pendiente',
};
export const MARK_CLS: Record<AttendanceRecordStatus, string> = {
  present: 'border-green-700 bg-green-50 text-green-900',
  absent: 'border-tinto-700 bg-tinto-50 text-tinto-900',
  pending: 'border-slate-500 bg-white text-slate-700',
};

export const groupLabel = (g: GroupRefDto) =>
  `${gradeLabel(g.grade)} ${g.code}${g.shift ? ` · ${shiftLabel(g.shift)}` : ''}`;

/** Fecha de calendario con dia de la semana (sin hora ni desfases por zona horaria). */
export const formatLongDay = (iso: string) => {
  const text = new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', { dateStyle: 'full' });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const progressText = (day: Pick<AttendanceDayDto, 'counts'>) =>
  `${day.counts.total - day.counts.pending} de ${day.counts.total} marcados`;

/**
 * Mensajes de asistencia. Los rechazos de negocio del servidor (409/400) ya traen un texto comprensible y sin datos internos ni de
 * menores; los casos frecuentes se redactan aqui para la persona usuaria. El resto se resume sin detalles tecnicos.
 */
export function attendanceErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === 'ATTENDANCE_UNAVAILABLE')
      return 'La asistencia aún no está habilitada en la base de datos. Avisa a administración técnica.';
    if (error.status === 401) return 'Tu sesión terminó. Inicia sesión de nuevo.';
    if (error.status === 404) return 'No se encontró la lista o ya no tienes acceso a ese grupo.';
    switch (error.code) {
      case 'NOT_SCHOOL_DAY':
        return 'Hoy no hay clases: no se toma lista en sábado ni domingo.';
      case 'DATE_NOT_TODAY':
        return 'La fecha de la lista debe ser el día escolar de hoy.';
      case 'EMPTY_ROSTER':
        return 'El grupo no tiene alumnos inscritos hoy, por lo que no se abre una lista vacía.';
      case 'GROUP_INACTIVE':
        return 'El grupo está inactivo: la lista ya no se puede modificar.';
      case 'DAY_FINALIZED':
        return 'La lista ya fue finalizada y no se puede modificar.';
      case 'DAY_NOT_CURRENT':
        return 'La fecha escolar cambió: esta lista es de un día anterior y ya no se puede modificar desde aquí.';
      case 'PENDING_RECORDS':
        return `${error.message}. Marca a todos antes de finalizar.`;
      case 'IDEMPOTENCY_MISMATCH':
      case 'STUDENT_NOT_IN_LIST':
        return 'No se pudo guardar: recarga la lista e inténtalo de nuevo.';
      case 'ROSTER_CHANGED':
      case 'CONCURRENT':
        return 'Otra operación coincidió con la tuya. Inténtalo de nuevo.';
      default:
    }
    if (error.status === 403) return 'No tienes permiso para esta operación.';
  }
  return adminErrorMessage(error, fallback);
}

/** Aviso accesible: al aparecer recibe el foco para que un lector de pantalla lo anuncie. */
export function FocusAlert({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
    >
      {children}
    </div>
  );
}
