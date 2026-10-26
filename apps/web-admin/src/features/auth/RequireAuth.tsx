import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

/**
 * Ruta protegida. Es solo una conveniencia de presentacion: el backend vuelve a autorizar cada llamada. Una sesion invalida
 * regresa a /login sin revelar por que (vencida, revocada o inexistente se ven igual).
 */
export function RequireAuth() {
  const { state, retry } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <p role="status" className="p-8 text-center text-slate-700">
        Comprobando sesión…
      </p>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <main role="alert" className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold text-tinto-700">No se pudo comprobar la sesión</h1>
        <p className="mt-2 text-slate-700">
          Revisa tu conexión o inténtalo de nuevo en unos momentos.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 rounded-md bg-tinto-700 px-4 py-2 font-semibold text-white hover:bg-tinto-800"
        >
          Reintentar
        </button>
      </main>
    );
  }
  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
