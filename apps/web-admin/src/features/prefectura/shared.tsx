import type { GroupRefDto, PrefectAssignmentStatus } from '@eta15/shared-contracts';
import { ApiError } from '../../lib/api';
import { gradeLabel, shiftLabel } from '../catalogo/shared';
import { adminErrorMessage } from '../personal/shared';

export { formatDay } from '../catalogo/shared';

export const STATUS_LABELS: Record<PrefectAssignmentStatus, string> = {
  active: 'Vigente',
  upcoming: 'Próxima',
  closed: 'Cerrada',
  completed: 'Ciclo terminado',
  revoked: 'Revocada',
};

export const STATUS_CLS: Record<PrefectAssignmentStatus, string> = {
  active: 'border-green-700 bg-green-50 text-green-900',
  upcoming: 'border-amber-700 bg-amber-50 text-amber-900',
  closed: 'border-slate-500 bg-slate-100 text-slate-700',
  completed: 'border-slate-500 bg-white text-slate-700',
  revoked: 'border-tinto-700 bg-tinto-50 text-tinto-900',
};

export const groupLabel = (g: GroupRefDto) =>
  `${gradeLabel(g.grade)} ${g.code}${g.shift ? ` · ${shiftLabel(g.shift)}` : ''}`;

/**
 * Mensajes de asignaciones. Los rechazos de negocio del servidor (409 no elegible, traslapes, cierres; 400 de fechas) ya traen un
 * texto comprensible y sin datos internos ni de menores; el resto se resume.
 */
export function prefectErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === 'PREFECT_ASSIGNMENTS_UNAVAILABLE')
      return 'Las asignaciones de prefectura aún no están habilitadas en la base de datos. Avisa a administración técnica.';
    if (
      (error.status === 400 || error.status === 409) &&
      error.code !== 'VALIDATION_ERROR' &&
      error.message
    )
      return error.message;
    if (error.status === 404) return 'No se encontró la asignación.';
    if (error.status === 401) return 'Tu sesión terminó. Inicia sesión de nuevo.';
  }
  return adminErrorMessage(error, fallback);
}
