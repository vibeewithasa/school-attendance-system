import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGES,
  passwordLength,
  validateNewPassword,
  type PasswordPolicyReason,
} from '@eta15/shared-contracts';
import { ApiError, NetworkError, api } from '../../lib/api';
import { createActivationProof, type ActivationProof } from '../../lib/activation-crypto';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const POLL_MS = 4000;

type Step = 'start' | 'waiting' | 'password' | 'done';

/**
 * Activacion de una cuenta PENDIENTE por su titular. El secreto de activacion se genera en este navegador, vive SOLO en la
 * memoria de esta pagina (nunca en localStorage, sessionStorage, URL ni cookies) y la autoridad nunca lo recibe: solo ve un
 * codigo corto derivado de su hash. Si se cierra o recarga la pagina, la solicitud se pierde y se empieza de nuevo (una
 * autoridad puede cancelar la anterior); no existe ningun metodo de recuperacion.
 */
export function ActivationPage({ pollMs = POLL_MS }: { pollMs?: number } = {}) {
  const navigate = useNavigate();
  const emailId = useId();
  const passId = useId();
  const confirmId = useId();
  const proofRef = useRef<ActivationProof | null>(null);
  const [step, setStep] = useState<Step>('start');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [serverReasons, setServerReasons] = useState<PasswordPolicyReason[]>([]);

  const reset = useCallback((note: string | null) => {
    proofRef.current = null; // el secreto se descarta
    setCode('');
    setPassword('');
    setConfirm('');
    setServerReasons([]);
    setError(null);
    setMessage(note);
    setStep('start');
  }, []);

  const check = useCallback(async () => {
    const proof = proofRef.current;
    if (!proof) return;
    try {
      const { state } = await api.activationStatus(proof.secretHash);
      if (state === 'authorized') {
        setStep('password');
        setMessage(null);
      } else if (state === 'expired') {
        reset('La solicitud venció. Inicia el proceso de nuevo.');
      } else if (state === 'unknown') {
        setMessage(
          'No encontramos tu solicitud. Revisa que el correo sea el que registró la autoridad. Si ya habías iniciado una activación antes, esa sigue vigente hasta que venza (30 minutos) o una autoridad la cancele: pídeselo y empieza de nuevo.',
        );
      } else {
        setMessage(null);
      }
    } catch {
      setMessage('No se pudo consultar el estado. Se reintentará automáticamente.');
    }
  }, [reset]);

  // Consulta periodica mientras se espera la verificacion presencial.
  useEffect(() => {
    if (step !== 'waiting') return;
    void check();
    const t = setInterval(() => void check(), pollMs);
    return () => clearInterval(t);
  }, [step, check, pollMs]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError('Escribe el correo electrónico con el que la autoridad registró tu cuenta.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const proof = await createActivationProof();
      await api.activationRequest(trimmed, proof.secretHash);
      proofRef.current = proof;
      setCode(proof.code);
      setStep('waiting');
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.'
          : e instanceof NetworkError
            ? 'No se pudo conectar con el servidor. Revisa tu conexión.'
            : e instanceof ApiError
              ? 'No se pudo iniciar la activación desde esta dirección. Inténtalo de nuevo.'
              : 'Este navegador no permite generar la prueba de activación de forma segura.',
      );
    } finally {
      setBusy(false);
    }
  }

  const clientPolicy = validateNewPassword(password, { email });
  const clientReasons = clientPolicy.ok ? [] : clientPolicy.reasons;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length > 0 && clientPolicy.ok && confirm === password && !busy;

  async function complete(event: FormEvent) {
    event.preventDefault();
    const proof = proofRef.current;
    if (!proof || !canSubmit) return;
    setBusy(true);
    setError(null);
    setServerReasons([]);
    try {
      await api.activationComplete(proof.secret, password);
      proofRef.current = null;
      setPassword('');
      setConfirm('');
      setStep('done');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PASSWORD_POLICY') {
        setServerReasons(e.reasons as PasswordPolicyReason[]);
      } else if (e instanceof ApiError && e.code === 'ACTIVATION_INVALID') {
        reset(
          'La activación venció o ya no es válida. Inicia el proceso de nuevo con la autoridad.',
        );
      } else if (e instanceof ApiError && e.status === 429) {
        setError('Demasiados intentos. Espera unos minutos antes de volver a intentarlo.');
      } else if (e instanceof NetworkError) {
        setError('No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.');
      } else {
        setError('No se pudo completar la activación. Inténtalo de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  }

  const input =
    'mt-1 block w-full rounded-md border border-slate-400 px-3 py-2 disabled:bg-slate-100';
  const primary =
    'w-full rounded-md bg-tinto-700 px-4 py-2.5 font-semibold text-white hover:bg-tinto-800 disabled:cursor-not-allowed disabled:opacity-60';
  const reasons = [...new Set([...clientReasons, ...serverReasons])];

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
          <h1 className="text-3xl font-bold leading-tight lg:text-4xl">Activa tu cuenta</h1>
          <p className="mt-3 max-w-md text-lg text-white/85">
            Una autoridad de la escuela verificará tu identidad en persona. Tú eliges tu contraseña:
            nadie más la conocerá.
          </p>
        </div>
        <p className="hidden text-sm text-white/70 lg:block">Escuela Secundaria Técnica No. 15</p>
      </aside>

      <main className="flex items-center justify-center bg-white px-6 py-10">
        <div className="w-full max-w-sm">
          {message && (
            <p
              role="status"
              className="mb-4 rounded-md border border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {message}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
            >
              {error}
            </p>
          )}

          {step === 'start' && (
            <form onSubmit={start} noValidate className="space-y-5">
              <h2 className="text-2xl font-bold text-tinto-700">Paso 1 · Inicia tu activación</h2>
              <p className="text-slate-700">
                Solo funciona si una autoridad ya registró tu cuenta. Ten a la mano tu
                identificación oficial.
              </p>
              <div>
                <label htmlFor={emailId} className="block text-sm font-semibold text-slate-800">
                  Correo electrónico de tu cuenta
                </label>
                <input
                  id={emailId}
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  className={input}
                />
              </div>
              <button type="submit" disabled={busy} aria-busy={busy} className={primary}>
                {busy ? 'Preparando…' : 'Iniciar activación'}
              </button>
              <p className="text-sm text-slate-700">
                ¿Ya activaste tu cuenta?{' '}
                <Link to="/login" className="font-semibold text-tinto-700 underline">
                  Inicia sesión
                </Link>
              </p>
            </form>
          )}

          {step === 'waiting' && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-tinto-700">
                Paso 2 · Verifica tu identidad en persona
              </h2>
              <p className="text-slate-700">
                Preséntate con una autoridad de la escuela con tu identificación y muéstrale este
                código en tu pantalla:
              </p>
              <p
                aria-label={`Tu código de verificación es ${code}`}
                className="rounded-md border-2 border-tinto-700 bg-tinto-50 py-4 text-center font-mono text-3xl font-bold tracking-widest text-tinto-900"
              >
                {code}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                <li>
                  No envíes este código por mensaje: solo muéstralo a la autoridad que tienes
                  enfrente.
                </li>
                <li>No es tu contraseña. Tu contraseña la eliges después.</li>
                <li>Mantén esta página abierta. Si la cierras, tendrás que empezar de nuevo.</li>
              </ul>
              <p role="status" className="text-sm text-slate-700">
                Esperando la verificación… esta pantalla se actualiza sola.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void check()}
                  className="flex-1 rounded-md border border-slate-400 px-4 py-2 font-semibold hover:bg-slate-50"
                >
                  Comprobar ahora
                </button>
                <button
                  type="button"
                  onClick={() => reset(null)}
                  className="flex-1 rounded-md border border-tinto-700 px-4 py-2 font-semibold text-tinto-700 hover:bg-tinto-50"
                >
                  Empezar de nuevo
                </button>
              </div>
            </div>
          )}

          {step === 'password' && (
            <form onSubmit={complete} noValidate className="space-y-4">
              <h2 className="text-2xl font-bold text-tinto-700">Paso 3 · Elige tu contraseña</h2>
              <p className="text-slate-700">
                Tu identidad fue verificada. Elige una contraseña que solo tú conozcas: una frase
                larga es más segura y fácil de recordar.
              </p>
              <div>
                <label htmlFor={passId} className="block text-sm font-semibold text-slate-800">
                  Contraseña nueva
                </label>
                <input
                  id={passId}
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  aria-describedby={`${passId}-hint`}
                  className={input}
                />
                <p id={`${passId}-hint`} className="mt-1 text-xs text-slate-600">
                  Llevas {passwordLength(password)} caracteres (mínimo {PASSWORD_MIN_LENGTH}, máximo{' '}
                  {PASSWORD_MAX_LENGTH}).
                </p>
              </div>
              <div>
                <label htmlFor={confirmId} className="block text-sm font-semibold text-slate-800">
                  Confirma tu contraseña
                </label>
                <input
                  id={confirmId}
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  aria-invalid={mismatch ? true : undefined}
                  className={input}
                />
                {mismatch && (
                  <p className="mt-1 text-sm text-tinto-700">Las contraseñas no coinciden.</p>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
                Mostrar la contraseña
              </label>
              {password.length > 0 && reasons.length > 0 && (
                <ul
                  aria-label="Requisitos de la contraseña"
                  className="list-disc space-y-1 pl-5 text-sm text-tinto-900"
                >
                  {reasons.map((r) => (
                    <li key={r}>{PASSWORD_POLICY_MESSAGES[r]}</li>
                  ))}
                </ul>
              )}
              <button type="submit" disabled={!canSubmit} aria-busy={busy} className={primary}>
                {busy ? 'Activando…' : 'Activar mi cuenta'}
              </button>
            </form>
          )}

          {step === 'done' && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-tinto-700">¡Tu cuenta está activa!</h2>
              <p role="status" className="text-slate-700">
                Ya puedes iniciar sesión con tu correo y la contraseña que acabas de elegir. Por
                seguridad no se abrió ninguna sesión automáticamente.
              </p>
              <button
                type="button"
                onClick={() => navigate('/login', { replace: true })}
                className={primary}
              >
                Ir a iniciar sesión
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
