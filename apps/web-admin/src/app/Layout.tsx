import { Link, Outlet } from 'react-router-dom';
import { Emblem } from '../components/Emblem';

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-white focus:p-2"
      >
        Saltar al contenido
      </a>
      <header className="bg-tinto-700 text-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Emblem />
          <Link to="/" className="text-lg font-semibold tracking-wide">
            ETA 15 <span className="font-normal opacity-80">· Portal administrativo</span>
          </Link>
        </div>
      </header>
      <main id="contenido" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-tinto-100 py-4 text-center text-sm text-slate-600">
        Escuela Secundaria Técnica No. 15 · Costa Rica, Sinaloa
      </footer>
    </div>
  );
}
