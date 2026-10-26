import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../auth/AuthProvider';

type ApiState = 'checking' | 'up' | 'down';

const ROLE_LABELS: Record<string, string> = {
  prefectura: 'Prefectura',
  trabajo_social: 'Trabajo social',
  control_acceso: 'Control de acceso',
  direccion: 'Dirección',
  admin_tecnico: 'Administración técnica',
};
const DOMAIN_LABELS = { school: 'Escolar', technical: 'Técnico' } as const;

export function HomePage() {
  const { state } = useAuth();
  const [apiState, setApiState] = useState<ApiState>('checking');
  const me = state.status === 'authenticated' ? state.me : null;

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then(() => !cancelled && setApiState('up'))
      .catch(() => !cancelled && setApiState('down'));
    return () => {
      cancelled = true;
    };
  }, []);

  const label = {
    checking: 'Comprobando conexión con la API…',
    up: 'API en línea (el proceso HTTP responde)',
    down: 'API no disponible',
  }[apiState];

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Bienvenida, bienvenido</h1>
      <p className="mt-3 max-w-prose text-slate-700">
        Esta es la pantalla inicial del portal administrativo. Los módulos escolares se agregarán en
        los siguientes sprints. Lo que puedes hacer lo decide siempre el servidor.
      </p>

      {me && (
        <div className="mt-6 max-w-lg rounded-md border border-tinto-100 bg-tinto-50 p-4">
          <h2 className="text-lg font-semibold text-tinto-900">Tu sesión</h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Dominio</dt>
            <dd>{DOMAIN_LABELS[me.user.accountDomain]}</dd>
            <dt className="font-semibold">Roles</dt>
            <dd>{me.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || 'Sin roles'}</dd>
            <dt className="font-semibold">Vence por inactividad</dt>
            <dd>{new Date(me.session.idleExpiresAt).toLocaleString('es-MX')}</dd>
          </dl>
          {me.mfa.required && !me.mfa.enforced && (
            <p role="note" className="mt-3 border-l-4 border-tinto-700 pl-3 text-sm text-tinto-900">
              Modo de desarrollo local: la verificación en dos pasos de tu rol está diferida. No
              uses datos reales de alumnos.
            </p>
          )}
        </div>
      )}

      <p
        role="status"
        className={`mt-6 inline-block rounded-md border px-4 py-2 text-sm ${
          apiState === 'up'
            ? 'border-green-700 bg-green-50 text-green-900'
            : apiState === 'down'
              ? 'border-tinto-700 bg-tinto-50 text-tinto-900'
              : 'border-slate-300 bg-slate-50 text-slate-700'
        }`}
      >
        {label}
      </p>
    </section>
  );
}
