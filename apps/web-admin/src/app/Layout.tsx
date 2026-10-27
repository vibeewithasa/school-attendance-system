import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { Emblem } from '../components/Emblem';
import { useAuth } from '../features/auth/AuthProvider';
import { permissionsOf } from '../lib/permissions';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-t-md px-3 py-2 text-sm font-semibold ${isActive ? 'bg-white text-tinto-700' : 'text-white hover:bg-tinto-800'}`;

export function Layout() {
  const { state, logout } = useAuth();
  const [closing, setClosing] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const me = state.status === 'authenticated' ? state.me : null;

  async function onLogout() {
    setClosing(true);
    setLogoutError(false);
    try {
      await logout();
    } catch {
      setLogoutError(true);
      setClosing(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-white focus:p-2"
      >
        Saltar al contenido
      </a>
      <header className="bg-tinto-700 text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <Emblem />
          <Link to="/" className="text-lg font-semibold tracking-wide">
            ETA 15 <span className="font-normal opacity-80">· Portal administrativo</span>
          </Link>
          {me && (
            <button
              type="button"
              onClick={onLogout}
              disabled={closing}
              className="ml-auto rounded-md border border-white/70 px-3 py-1.5 text-sm font-semibold hover:bg-tinto-800 disabled:opacity-70"
            >
              {closing ? 'Cerrando…' : 'Cerrar sesión'}
            </button>
          )}
        </div>
        {/* La navegacion solo muestra lo que la sesion puede usar; el servidor vuelve a autorizar cada llamada. */}
        {me && (
          <nav aria-label="Principal" className="mx-auto flex max-w-5xl gap-1 px-4">
            <NavLink to="/" end className={navClass}>
              Inicio
            </NavLink>
            {permissionsOf(me).canViewPersonnel && (
              <NavLink to="/personal" className={navClass}>
                Personal
              </NavLink>
            )}
            {permissionsOf(me).canViewCatalog && (
              <NavLink to="/catalogo" className={navClass}>
                Catálogo escolar
              </NavLink>
            )}
          </nav>
        )}
      </header>
      {logoutError && (
        <p role="alert" className="bg-tinto-50 px-4 py-2 text-center text-sm text-tinto-900">
          No se pudo cerrar la sesión: revisa tu conexión e inténtalo de nuevo.
        </p>
      )}
      <main id="contenido" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-tinto-100 py-4 text-center text-sm text-slate-600">
        Escuela Secundaria Técnica No. 15 · Costa Rica, Sinaloa
      </footer>
    </div>
  );
}
