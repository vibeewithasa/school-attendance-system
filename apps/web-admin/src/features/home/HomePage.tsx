import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

type ApiState = 'checking' | 'up' | 'down';

export function HomePage() {
  const [apiState, setApiState] = useState<ApiState>('checking');

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
      <h1 className="text-3xl font-bold text-tinto-700">El portal ETA 15 está funcionando</h1>
      <p className="mt-3 max-w-prose text-slate-700">
        Esta es la pantalla inicial del portal administrativo. Los módulos escolares se agregarán en
        los siguientes sprints.
      </p>
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
