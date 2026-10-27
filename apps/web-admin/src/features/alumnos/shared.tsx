import type { EnrollmentStatus, GroupRefDto, StudentDto } from '@eta15/shared-contracts';
import { ApiError } from '../../lib/api';
import { adminErrorMessage } from '../personal/shared';
import { gradeLabel, shiftLabel } from '../catalogo/shared';

export { formatDay, gradeLabel } from '../catalogo/shared';

/** "Apellidos, Nombres": el orden de las listas escolares. */
export const fullName = (s: Pick<StudentDto, 'givenNames' | 'familyName'>) =>
  `${s.familyName}, ${s.givenNames}`;

export const groupLabel = (g: GroupRefDto) =>
  `${gradeLabel(g.grade)} ${g.code}${g.shift ? ` · ${shiftLabel(g.shift)}` : ''} · ${g.schoolYearName}`;

export const ENROLLMENT_LABELS: Record<EnrollmentStatus, string> = {
  active: 'Vigente',
  upcoming: 'Próxima',
  withdrawn: 'Con baja',
  completed: 'Ciclo terminado',
};

/**
 * Mensajes del modulo de alumnos. Los rechazos de negocio del servidor (409 duplicados, traslados, historial; 400 de reglas) ya
 * traen texto comprensible y sin datos internos ni datos del menor; el resto se resume.
 */
export function studentsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === 'STUDENTS_UNAVAILABLE')
      return 'El módulo de alumnos aún no está habilitado en la base de datos. Avisa a administración técnica.';
    if (
      (error.status === 400 || error.status === 409) &&
      error.code !== 'VALIDATION_ERROR' &&
      error.message
    )
      return error.message;
    if (error.status === 404)
      return 'No se encontró el registro. Puede que ya no exista o que no tengas acceso.';
    if (error.status === 401) return 'Tu sesión terminó. Inicia sesión de nuevo.';
  }
  return adminErrorMessage(error, fallback);
}
