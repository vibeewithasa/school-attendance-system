import { ApiError } from '../../lib/api';
import { adminErrorMessage } from '../personal/shared';

export { formatDate } from '../personal/shared';

/** Estados visibles de una solicitud de vinculacion. */
export const REQUEST_LABELS: Record<string, { label: string; cls: string }> = {
  claimed: {
    label: 'Esperando aprobación de Dirección',
    cls: 'border-amber-700 bg-amber-50 text-amber-900',
  },
  approved: {
    label: 'Aprobada: falta confirmar en el dispositivo',
    cls: 'border-green-700 bg-green-50 text-green-900',
  },
};

export const DEVICE_LABELS = {
  active: { label: 'Activo', cls: 'border-green-700 bg-green-50 text-green-900' },
  revoked: { label: 'Revocado', cls: 'border-slate-500 bg-slate-100 text-slate-700' },
} as const;

export const REVOKE_REASON_LABELS: Record<string, string> = {
  titular: 'La persona titular lo revocó',
  authority: 'Revocado por Dirección',
  lost: 'Pérdida o robo',
  replaced: 'Reemplazado',
};

/**
 * Mensajes de la vinculacion de dispositivos. El servidor ya devuelve textos sin datos internos; aqui solo se unifican los codigos
 * de negocio mas frecuentes y se evita revelar si una solicitud existe cuando el reclamo falla.
 */
export function mobileErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === 'MOBILE_AUTH_UNAVAILABLE')
      return 'La vinculación de dispositivos aún no está habilitada en la base de datos (entorno de pruebas).';
    if (error.code === 'CLAIM_INVALID')
      return 'El código no es válido o la solicitud ya no está disponible. Revisa los datos que muestra el dispositivo.';
    if (error.code === 'FINGERPRINT_MISMATCH')
      return 'La huella no coincide con la que muestra el dispositivo. No se aprobó nada.';
    if (error.code === 'SELF_APPROVAL') return 'Nadie puede aprobar su propia vinculación.';
    if (error.status === 429)
      return 'Demasiados intentos. Espera unos minutos antes de intentarlo otra vez.';
    if (
      error.status === 409 ||
      (error.status === 403 && error.code !== 'FORBIDDEN' && error.message)
    )
      return error.message || fallback;
  }
  return adminErrorMessage(error, fallback);
}
