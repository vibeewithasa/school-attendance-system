import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, NetworkError } from '../../lib/api';
import { useAuth } from './AuthProvider';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Mensajes comprensibles; ninguno revela si la cuenta existe ni por que fallo exactamente la autenticacion. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Correo o contraseña incorrectos.';
    if (error.status === 429)
      return 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
    if (error.code === 'MFA_REQUIRED')
      return 'Tu rol exige verificación en dos pasos, que aún no está disponible. No se inició sesión. Avisa al área de sistemas.';
    if (error.code === 'FORBIDDEN_ORIGIN')
      return 'No se puede iniciar sesión desde esta dirección. Abre el portal desde la dirección indicada por el área de sistemas.';
    if (error.status === 400) return 'Revisa el correo y la contraseña.';
  }
  return 'No se pudo iniciar sesión. Inténtalo de nuevo.';
}

/** Solo se vuelve a rutas internas (nunca a una URL externa). */
function safeReturnPath(from: unknown): string {
  return typeof from === 'string' &&
    from.startsWith('/') &&
    !from.startsWith('//') &&
    from !== '/login'
    ? from
    : '/';
}

interface FieldErrors {
  email?: string;
  password?: string;
}

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  const trimmed = email.trim();
  if (!trimmed) errors.email = 'Escribe tu correo electrónico.';
  else if (!EMAIL_RE.test(trimmed) || trimmed.length > 254)
    errors.email = 'Escribe un correo electrónico válido.';
  if (!password) errors.password = 'Escribe tu contraseña.';
  else if (password.length > 1024) errors.password = 'La contraseña es demasiado larga.';
  return errors;
}

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [refocus, setRefocus] = useState(0);

  // El campo esta deshabilitado durante el envio: el foco vuelve a la contrasena cuando ya se pudo reactivar.
  useEffect(() => {
    if (refocus > 0) passwordRef.current?.focus();
  }, [refocus]);

  if (state.status === 'authenticated') {
    return (
      <Navigate to={safeReturnPath((location.state as { from?: unknown } | null)?.from)} replace />
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    // Los valores se leen del DOM: asi tambien cuentan los completados automaticos del navegador.
    const email = emailRef.current?.value ?? '';
    const password = passwordRef.current?.value ?? '';
    const errors = validate(email, password);
    setFieldErrors(errors);
    setFormError(null);
    if (errors.email) return void emailRef.current?.focus();
    if (errors.password) return void passwordRef.current?.focus();

    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate(safeReturnPath((location.state as { from?: unknown } | null)?.from), {
        replace: true,
      });
    } catch (error) {
      setFormError(loginErrorMessage(error));
      if (passwordRef.current) passwordRef.current.value = ''; // la contrasena no se conserva tras un fallo
      setSubmitting(false);
      setRefocus((n) => n + 1);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="flex flex-col justify-between bg-tinto-700 px-8 py-10 text-white lg:px-12">
        <div
          role="img"
          aria-label="Espacio reservado para el logotipo de la escuela"
          className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-dashed border-white/60 text-center text-[0.7rem] leading-tight text-white/80"
        >
          Logotipo
          <br />
          de la escuela
        </div>
        <div className="my-10 lg:my-0">
          <h1 className="text-3xl font-bold leading-tight lg:text-4xl">
            Escuela Secundaria Técnica No. 15
          </h1>
          <p className="mt-3 max-w-md text-lg text-white/85">
            Portal administrativo · Costa Rica, Sinaloa
          </p>
        </div>
        <p className="hidden text-sm text-white/70 lg:block">
          El acceso es personal e intransferible. Cierra la sesión al terminar.
        </p>
      </aside>

      <main className="flex items-center justify-center bg-white px-6 py-10">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-bold text-tinto-700">Iniciar sesión</h2>
          <p className="mt-1 text-slate-700">Usa tu correo institucional y tu contraseña.</p>

          <form
            onSubmit={onSubmit}
            noValidate
            className="mt-6 space-y-5"
            aria-describedby={formError ? errorId : undefined}
          >
            {formError && (
              <p
                id={errorId}
                role="alert"
                className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
              >
                {formError}
              </p>
            )}

            <div>
              <label htmlFor={emailId} className="block text-sm font-semibold text-slate-800">
                Correo electrónico
              </label>
              <input
                ref={emailRef}
                id={emailId}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={submitting}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? `${emailId}-error` : undefined}
                className="mt-1 block w-full rounded-md border border-slate-400 px-3 py-2 disabled:bg-slate-100"
              />
              {fieldErrors.email && (
                <p id={`${emailId}-error`} className="mt-1 text-sm text-tinto-700">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={passwordId} className="block text-sm font-semibold text-slate-800">
                Contraseña
              </label>
              <div className="relative mt-1">
                <input
                  ref={passwordRef}
                  id={passwordId}
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  disabled={submitting}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={fieldErrors.password ? `${passwordId}-error` : undefined}
                  className="block w-full rounded-md border border-slate-400 py-2 pl-3 pr-20 disabled:bg-slate-100"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 px-3 text-sm font-semibold text-tinto-700 hover:underline"
                >
                  {showPassword ? 'Ocultar' : 'Mostrar'}
                </button>
              </div>
              {fieldErrors.password && (
                <p id={`${passwordId}-error`} className="mt-1 text-sm text-tinto-700">
                  {fieldErrors.password}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
              className="w-full rounded-md bg-tinto-700 px-4 py-2.5 font-semibold text-white hover:bg-tinto-800 disabled:cursor-wait disabled:opacity-70"
            >
              {submitting ? 'Entrando…' : 'Iniciar sesión'}
            </button>
          </form>

          {state.status === 'unavailable' && (
            <p role="status" className="mt-4 text-sm text-slate-700">
              No se pudo comprobar si ya tienes una sesión abierta. Puedes intentar iniciar sesión.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
