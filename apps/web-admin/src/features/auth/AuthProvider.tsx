import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthMeResponse } from '@eta15/shared-contracts';
import { ApiError, NetworkError, api, setUnauthorizedHandler } from '../../lib/api';

/**
 * Estado de la sesion en MEMORIA. No se guarda nada en localStorage/sessionStorage ni en la URL: la cookie HttpOnly la
 * gestiona el navegador y la verdad es siempre GET /auth/me. La interfaz solo adapta la presentacion; los permisos los
 * decide el backend en cada peticion.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'unavailable' }
  | { status: 'authenticated'; me: AuthMeResponse };

interface AuthContextValue {
  state: AuthState;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Vuelve a comprobar la sesion (p. ej. tras un fallo de red). */
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const check = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'authenticated', me: await api.me() });
    } catch (error) {
      setState({
        status: error instanceof ApiError && error.status === 401 ? 'anonymous' : 'unavailable',
      });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Cualquier 401 posterior (sesion vencida o revocada) devuelve a login sin mas detalle.
  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await api.login(email, password);
    setState({ status: 'authenticated', me: await api.me() });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (error) {
      // Un 401 significa que la sesion ya no existe (el resultado buscado). Un fallo de red se informa a quien llama.
      if (error instanceof NetworkError) throw error;
    }
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, logout, retry: () => void check() }),
    [state, login, logout, check],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
