import { ApiError, NetworkError } from '../../lib/api';

/** Mensajes comprensibles para las acciones administrativas. El servidor siempre tiene la ultima palabra. */
export function adminErrorMessage(
  error: unknown,
  fallback = 'No se pudo completar la acción. Inténtalo de nuevo.',
): string {
  if (error instanceof NetworkError)
    return 'No se pudo conectar con el servidor. Revisa tu conexión.';
  if (error instanceof ApiError) {
    if (error.status === 429)
      return 'Demasiadas solicitudes. Espera un momento antes de intentarlo otra vez.';
    if (error.status === 403)
      return error.message && error.code !== 'FORBIDDEN'
        ? error.message
        : 'No tienes permiso para realizar esta acción.';
    if (error.status === 404)
      return 'No se encontró el elemento. Puede que ya no exista o que no tengas acceso.';
    if (error.status === 409 || error.code === 'CODE_MISMATCH') return error.message || fallback;
    if (error.status === 400) return 'Revisa los datos e inténtalo de nuevo.';
  }
  return fallback;
}

const STATUS = {
  pending: { label: 'Pendiente de activación', cls: 'border-amber-700 bg-amber-50 text-amber-900' },
  active: { label: 'Activa', cls: 'border-green-700 bg-green-50 text-green-900' },
  disabled: { label: 'Deshabilitada', cls: 'border-slate-500 bg-slate-100 text-slate-700' },
} as const;

export function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`}>
      {s.label}
    </span>
  );
}

export const ACTIVATION_LABELS = {
  requested: 'Solicitud enviada: falta verificar a la persona',
  authorized: 'Identidad verificada: falta que la persona elija su contraseña',
  expired: 'Solicitud vencida',
} as const;

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
    >
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md bg-tinto-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-tinto-800"
        >
          Reintentar
        </button>
      )}
    </div>
  );
}
