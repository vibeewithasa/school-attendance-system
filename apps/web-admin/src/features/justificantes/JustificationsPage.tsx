import type {
  CreateJustificationReceiptResponse,
  JustificationReceiptList,
  JustificationStudentOptionDto,
  JustificationStudentSearch,
} from '@eta15/shared-contracts';
import { JUSTIFICATION_SEARCH_MIN } from '@eta15/shared-contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, FIELD } from '../../components/form';
import { ApiError, api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { groupLabel } from '../asistencia/shared';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice, adminErrorMessage } from '../personal/shared';

/**
 * Justificantes (Trabajo Social): registro de RECEPCION. Un registro dice "se recibio un justificante del alumno X para el dia
 * escolar D" (con folio, quien y cuando). NO aprueba nada, no justifica ninguna falta, no modifica la asistencia ni los reportes:
 * esa decision institucional (D-10) sigue pendiente, y esta pantalla jamas dice "justificada", "aprobado" ni "falta eliminada".
 * El servidor decide la hora de recepcion y el folio, autoriza cada llamada y valida la fecha; aqui solo se presenta.
 */
export const RECEIPT_NOTICE =
  'El registro de recepción no modifica la asistencia ni acredita la justificación de una falta.';

const TZ = 'America/Mazatlan';
/** Hoy en la escuela (solo ayuda de pantalla para `max`; el servidor decide). */
const schoolToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const isWeekend = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};
const newRequestId = () => globalThis.crypto.randomUUID();
const formatDay = (iso: string) => {
  const text = new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', { dateStyle: 'full' });
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const formatStamp = (iso: string) =>
  new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ });

/** Mensajes del registro: los motivos de negocio del servidor se redactan para la persona usuaria; el resto se resume. */
function receiptErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NOT_SCHOOL_DAY':
        return 'La fecha escolar debe ser de lunes a viernes.';
      case 'DATE_IN_FUTURE':
        return 'No se registran justificantes de fechas futuras.';
      case 'NOT_ENROLLED_ON_DATE':
        return 'El alumno no estaba inscrito en esa fecha.';
      case 'STUDENT_NOT_FOUND':
        return 'No se encontró al alumno.';
      case 'IDEMPOTENCY_MISMATCH':
        return 'Este envío ya se usó con otros datos. Revisa el alumno y la fecha e inténtalo de nuevo.';
      case 'JUSTIFICATIONS_UNAVAILABLE':
        return 'El registro de justificantes aún no está habilitado en la base de datos. Avisa a administración técnica.';
      default:
    }
    if (error.status === 401) return 'Tu sesión terminó. Inicia sesión de nuevo.';
    if (error.status === 403) return 'No tienes permiso para esta operación.';
  }
  return adminErrorMessage(error, fallback);
}

export function JustificationsPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const perms = me ? permissionsOf(me) : null;
  const [refresh, setRefresh] = useState(0);
  const [lastReceipt, setLastReceipt] = useState<CreateJustificationReceiptResponse | null>(null);

  if (!me || !perms) return null;
  if (!perms.canViewJustifications) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Justificantes</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para consultar justificantes.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Justificantes</h1>
      <p
        role="note"
        className="mt-3 max-w-prose rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-800"
      >
        <strong>{RECEIPT_NOTICE}</strong> Esta sección solo deja constancia de que se recibió un
        documento; la escuela aún no decide cómo se tratan los justificantes.
      </p>
      {perms.canRegisterJustifications ? (
        <RegisterForm
          onRegistered={(r) => {
            setLastReceipt(r);
            setRefresh((n) => n + 1);
          }}
          last={lastReceipt}
        />
      ) : (
        <p className="mt-4 text-sm text-slate-700">
          Consulta: tu cuenta puede ver los registros, pero no registrar recepciones.
        </p>
      )}
      <History refresh={refresh} />
    </section>
  );
}

/** Busqueda y eleccion del alumno (datos minimos; el servidor limita y audita la busqueda). */
function StudentPicker(props: {
  legend: string;
  selected: JustificationStudentOptionDto | null;
  onSelect: (s: JustificationStudentOptionDto) => void;
  onClear: () => void;
}) {
  const ids = { q: useId(), err: useId() };
  const [q, setQ] = useState('');
  const [found, setFound] = useState<JustificationStudentSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ticket = useRef(0);

  async function search() {
    const text = q.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (text.length < JUSTIFICATION_SEARCH_MIN) {
      setProblem(`Escribe al menos ${JUSTIFICATION_SEARCH_MIN} letras del nombre o el código.`);
      return;
    }
    setProblem(null);
    setSearching(true);
    const mine = ++ticket.current;
    try {
      const r = await api.searchJustificationStudents(text);
      if (mine === ticket.current) setFound(r);
    } catch (err) {
      if (mine === ticket.current) {
        setFound(null);
        setProblem(receiptErrorMessage(err, 'No se pudo buscar al alumno.'));
      }
    } finally {
      if (mine === ticket.current) setSearching(false);
    }
  }

  if (props.selected) {
    const s = props.selected;
    return (
      <div className="rounded-md border border-tinto-100 p-3">
        <p className="text-sm font-semibold text-slate-800">{props.legend}</p>
        <p className="mt-1">
          <strong>
            {s.givenNames} {s.familyName}
          </strong>
          {s.schoolCode ? <span className="text-slate-700"> · {s.schoolCode}</span> : null}
          {s.currentGroup ? (
            <span className="text-slate-700"> · {groupLabel(s.currentGroup)}</span>
          ) : null}
        </p>
        <button type="button" className={`${BTN_SMALL} mt-2`} onClick={props.onClear}>
          Cambiar alumno
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* NO es un <form>: este selector vive DENTRO del formulario de registro (y del filtro) y un <form> anidado es HTML invalido:
          el navegador enviaria el formulario externo. Enter y el boton buscan sin enviar nada. */}
      <div role="search" aria-label={props.legend}>
        <label htmlFor={ids.q} className="block text-sm font-semibold text-slate-800">
          {props.legend}
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id={ids.q}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? ids.err : undefined}
            placeholder="Nombre, apellido o código"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
            className={`${FIELD} max-w-xs`}
          />
          <button
            type="button"
            onClick={() => void search()}
            className={`${BTN_SECONDARY} mt-1`}
            disabled={searching}
          >
            {searching ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
        {problem && (
          <p id={ids.err} role="alert" className="mt-1 text-sm text-tinto-700">
            {problem}
          </p>
        )}
      </div>
      {found && found.items.length === 0 && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          No se encontraron alumnos con ese dato.
        </p>
      )}
      {found && found.items.length > 0 && (
        <>
          <ul
            className="mt-2 divide-y divide-slate-200 border-y border-slate-200"
            aria-label="Resultados de la búsqueda de alumnos"
          >
            {found.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {s.givenNames} {s.familyName}
                  {s.schoolCode ? <span className="text-slate-700"> · {s.schoolCode}</span> : null}
                  {s.currentGroup ? (
                    <span className="text-slate-700"> · {groupLabel(s.currentGroup)}</span>
                  ) : null}
                </span>
                <button type="button" className={BTN_SMALL} onClick={() => props.onSelect(s)}>
                  Elegir{' '}
                  <span className="sr-only">
                    a {s.givenNames} {s.familyName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {found.truncated && (
            <p role="status" className="mt-1 text-sm text-slate-700">
              Hay más coincidencias: escribe más letras para precisar la búsqueda.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RegisterForm(props: {
  onRegistered: (r: CreateJustificationReceiptResponse) => void;
  last: CreateJustificationReceiptResponse | null;
}) {
  const ids = { date: useId(), err: useId() };
  const [student, setStudent] = useState<JustificationStudentOptionDto | null>(null);
  const [date, setDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  // La clave de envio (requestId) se conserva mientras no cambien el alumno ni la fecha: un reintento tras un fallo de red o un
  // doble clic NO crea otro registro. Tras un registro exitoso se renueva (un segundo documento es un registro distinto).
  const key = useRef<{ k: string; id: string } | null>(null);
  const today = schoolToday();

  function clearOutcome() {
    setProblem(null);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return; // doble clic: el primer envio sigue en curso
    clearOutcome();
    if (!student) {
      setProblem('Elige al alumno.');
      return;
    }
    if (!date) {
      setProblem('Indica la fecha escolar del justificante.');
      return;
    }
    if (isWeekend(date)) {
      setProblem('La fecha escolar debe ser de lunes a viernes.');
      return;
    }
    if (date > today) {
      setProblem('No se registran justificantes de fechas futuras.');
      return;
    }
    const k = `${student.id}|${date}`;
    if (!key.current || key.current.k !== k) key.current = { k, id: newRequestId() };
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await api.createJustificationReceipt({
        requestId: key.current.id,
        studentId: student.id,
        schoolDate: date,
      });
      key.current = null;
      props.onRegistered(r);
      setStudent(null);
      setDate('');
    } catch (err) {
      setError(receiptErrorMessage(err, 'No se pudo registrar la recepción.'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="mt-6">
      <h2 className="text-xl font-semibold text-tinto-900">
        Registrar la recepción de un justificante
      </h2>
      {props.last && (
        <div
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-4 py-3 text-green-900"
        >
          <p className="font-semibold">
            {props.last.replayed ? 'Ya estaba registrado.' : 'Recepción registrada.'} Folio{' '}
            <span className="font-mono">{props.last.receipt.folio}</span>
          </p>
          <p className="mt-1 text-sm">
            {props.last.receipt.student.givenNames} {props.last.receipt.student.familyName} ·
            justificante del {formatDay(props.last.receipt.schoolDate)} · Recibido por{' '}
            {props.last.receipt.receivedBy.displayName} el{' '}
            {formatStamp(props.last.receipt.receivedAt)}.
          </p>
          <p className="mt-1 text-sm">{RECEIPT_NOTICE}</p>
        </div>
      )}
      <form
        onSubmit={(e) => void submit(e)}
        aria-label="Registro de recepción de justificante"
        noValidate
        className="mt-3 grid max-w-xl gap-4"
      >
        <StudentPicker
          legend="Alumno"
          selected={student}
          onSelect={(s) => {
            setStudent(s);
            clearOutcome();
          }}
          onClear={() => {
            setStudent(null);
            clearOutcome();
          }}
        />
        <div>
          <label htmlFor={ids.date} className="block text-sm font-semibold text-slate-800">
            Fecha escolar del justificante
          </label>
          <input
            id={ids.date}
            type="date"
            value={date}
            max={today}
            onChange={(e) => {
              setDate(e.target.value);
              clearOutcome();
            }}
            aria-invalid={problem && /fecha|Indica/.test(problem) ? true : undefined}
            aria-describedby={problem ? ids.err : undefined}
            className={`${FIELD} max-w-xs`}
          />
          <p className="mt-1 text-xs text-slate-600">
            Solo lunes a viernes, sin fechas futuras. La hora de recepción la fija el servidor.
          </p>
        </div>
        {problem && (
          <p id={ids.err} role="alert" className="text-sm text-tinto-700">
            {problem}
          </p>
        )}
        {error && <ErrorNotice message={error} />}
        <div>
          <button type="submit" className={BTN_PRIMARY} disabled={saving} aria-busy={saving}>
            {saving ? 'Registrando…' : 'Registrar recepción'}
          </button>
        </div>
      </form>
    </div>
  );
}

const PAGE_SIZE = 10;

function History({ refresh }: { refresh: number }) {
  const ids = { from: useId(), to: useId() };
  const [student, setStudent] = useState<JustificationStudentOptionDto | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<JustificationReceiptList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rangeProblem = from && to && from > to ? 'El inicio no puede ser posterior al fin.' : null;

  useEffect(() => {
    if (rangeProblem) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listJustificationReceipts({
        page,
        pageSize: PAGE_SIZE,
        studentId: student?.id,
        from: from || undefined,
        to: to || undefined,
      })
      .then((r) => !cancelled && setData(r))
      .catch(
        (e: unknown) =>
          !cancelled && setError(receiptErrorMessage(e, 'No se pudo cargar el historial.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page, student, from, to, refresh, attempt, rangeProblem]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mt-10">
      <h2 className="text-xl font-semibold text-tinto-900">Historial de recepciones</h2>
      <div
        className="mt-3 grid gap-3 sm:grid-cols-2"
        role="group"
        aria-label="Filtros del historial"
      >
        <div className="sm:col-span-2">
          <StudentPicker
            legend="Filtrar por alumno"
            selected={student}
            onSelect={(s) => {
              setStudent(s);
              setPage(1);
            }}
            onClear={() => {
              setStudent(null);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor={ids.from} className="block text-sm font-semibold text-slate-800">
            Fecha escolar desde
          </label>
          <input
            id={ids.from}
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor={ids.to} className="block text-sm font-semibold text-slate-800">
            Fecha escolar hasta
          </label>
          <input
            id={ids.to}
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            aria-invalid={rangeProblem ? true : undefined}
            className={FIELD}
          />
        </div>
      </div>
      {rangeProblem && (
        <p role="alert" className="mt-2 text-sm text-tinto-700">
          {rangeProblem}
        </p>
      )}
      {error && (
        <div className="mt-4">
          <ErrorNotice message={error} onRetry={retry} />
        </div>
      )}
      {loading && !data && !error && (
        <p role="status" className="mt-4 text-slate-700">
          Cargando…
        </p>
      )}
      {data && !error && (
        <>
          {data.items.length === 0 ? (
            <p role="status" className="mt-4 text-slate-700">
              No hay recepciones registradas con esos filtros.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto" aria-busy={loading}>
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">Recepciones de justificantes registradas</caption>
                <thead>
                  <tr className="border-b border-slate-300">
                    <th scope="col" className="py-2 pr-4">
                      Folio
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Alumno
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Fecha escolar
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Recibido el
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Recibió
                    </th>
                    <th scope="col" className="py-2">
                      Estado
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id} className="border-b border-slate-200">
                      <th scope="row" className="py-2 pr-4 font-mono font-normal">
                        {r.folio}
                      </th>
                      <td className="py-2 pr-4">
                        {r.student.givenNames} {r.student.familyName}
                      </td>
                      <td className="py-2 pr-4">{r.schoolDate}</td>
                      <td className="py-2 pr-4">{formatStamp(r.receivedAt)}</td>
                      <td className="py-2 pr-4">{r.receivedBy.displayName}</td>
                      <td className="py-2">
                        <span className="inline-block rounded-full border border-slate-500 bg-white px-2 py-0.5 text-xs font-semibold text-slate-800">
                          Recibido
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <nav
              aria-label="Paginación del historial"
              className="mt-3 flex items-center gap-3 text-sm"
            >
              <button
                type="button"
                className={BTN_SMALL}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Anterior
              </button>
              <span>
                Página {page} de {pages}
              </span>
              <button
                type="button"
                className={BTN_SMALL}
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
