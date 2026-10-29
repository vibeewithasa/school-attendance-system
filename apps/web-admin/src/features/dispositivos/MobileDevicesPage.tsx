import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  MOBILE_PAIRING_CODE_PATTERN,
  type MobileDeviceDto,
  type MobileDevicesListResponse,
  type MobileRequestDto,
} from '@eta15/shared-contracts';
import { Modal } from '../../components/Modal';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, FIELD } from '../../components/form';
import { api } from '../../lib/api';
import { permissionsOf } from '../../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { ErrorNotice } from '../personal/shared';
import { ApproveDialog } from './ApproveDialog';
import {
  DEVICE_LABELS,
  REQUEST_LABELS,
  REVOKE_REASON_LABELS,
  formatDate,
  mobileErrorMessage,
} from './shared';

const BADGE = 'inline-block rounded-full border px-2 py-0.5 text-xs font-semibold';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Dialog =
  | { kind: 'approve'; request: MobileRequestDto }
  | { kind: 'revoke'; device: MobileDeviceDto; as: 'authority' | 'titular' }
  | { kind: 'close'; request: MobileRequestDto; as: 'reject' | 'cancel' };

/**
 * Dispositivos moviles (PROTOTIPO de sandbox, ADR 0005 en estado "propuesta": nada de esto esta aprobado para uso real).
 *  - La persona titular (prefectura) liga la solicitud que muestra SU dispositivo con el codigo de la pantalla y puede revocar los suyos.
 *  - Direccion aprueba tecleando la huella que ve en el dispositivo, rechaza y revoca cualquier dispositivo.
 * Solo presentacion: el servidor autoriza cada llamada con la sesion web (cookie + CSRF); ninguna llamada envia un identificador
 * de persona. Los tokens moviles jamas pasan por esta pagina.
 */
export function MobileDevicesPage() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.me : null;
  const perms = me ? permissionsOf(me) : null;
  const canEnroll = perms?.canEnrollMobile ?? false;
  const canManage = perms?.canManageMobile ?? false;
  const allowed = canEnroll || canManage;
  const ids = { request: useId(), code: useId() };

  const [data, setData] = useState<MobileDevicesListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestId, setRequestId] = useState('');
  const [code, setCode] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // La autoridad ve todo; la persona titular solo lo suyo. Quien tiene ambos permisos usa la vista de autoridad.
    (canManage ? api.listMobileDevices() : api.listMyMobileDevices())
      .then((r) => !cancelled && setData(r))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(mobileErrorMessage(e, 'No se pudo cargar la lista de dispositivos.')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [allowed, canManage, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const changed = (text: string) => {
    setDialog(null);
    setNotice(text);
    reload();
  };

  async function onClaim(event: FormEvent) {
    event.preventDefault();
    if (claiming) return;
    setClaimError(null);
    setNotice(null);
    const id = requestId.trim();
    const pairing = code.trim().toUpperCase();
    if (!UUID.test(id) || !MOBILE_PAIRING_CODE_PATTERN.test(pairing)) {
      setClaimError(
        'Escribe la clave de solicitud y el código tal como los muestra el dispositivo.',
      );
      return;
    }
    setClaiming(true);
    try {
      await api.claimMobileDevice({ requestId: id, code: pairing });
      setRequestId('');
      setCode('');
      setNotice(
        'Solicitud ligada a tu cuenta. Falta que Dirección la apruebe comparando la huella en el dispositivo.',
      );
      reload();
    } catch (e) {
      setClaimError(mobileErrorMessage(e, 'No se pudo vincular el dispositivo.'));
    } finally {
      setClaiming(false);
    }
  }

  if (!me || !perms) return null;
  if (!allowed) {
    return (
      <section>
        <h1 className="text-3xl font-bold text-tinto-700">Dispositivos móviles</h1>
        <p
          role="alert"
          className="mt-4 rounded-md border border-tinto-700 bg-tinto-50 px-4 py-3 text-tinto-900"
        >
          No tienes permiso para administrar dispositivos móviles.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-tinto-700">Dispositivos móviles</h1>
      <p
        role="note"
        className="mt-2 max-w-prose rounded-md border border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        <strong>ENTORNO DE PRUEBAS.</strong> La vinculación de dispositivos es un prototipo que aún
        no está aprobado para uso real. Solo se usan cuentas y datos ficticios.
      </p>
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900"
        >
          {notice}
        </p>
      )}

      {canEnroll && (
        <form
          onSubmit={onClaim}
          noValidate
          className="mt-6 max-w-xl space-y-3"
          aria-label="Vincular un dispositivo"
        >
          <h2 className="text-xl font-semibold text-slate-900">Vincular mi dispositivo</h2>
          <p className="text-sm text-slate-700">
            Abre la aplicación en tu dispositivo, toca «Vincular dispositivo» y escribe aquí lo que
            muestra la pantalla. Después, Dirección debe aprobarla.
          </p>
          {claimError && (
            <p
              role="alert"
              className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
            >
              {claimError}
            </p>
          )}
          <div>
            <label htmlFor={ids.request} className="block text-sm font-semibold">
              Clave de solicitud
            </label>
            <input
              id={ids.request}
              value={requestId}
              onChange={(e) => setRequestId(e.target.value)}
              disabled={claiming}
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </div>
          <div>
            <label htmlFor={ids.code} className="block text-sm font-semibold">
              Código de emparejamiento
            </label>
            <input
              id={ids.code}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={claiming}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX"
              className={`${FIELD} font-mono tracking-wider`}
            />
          </div>
          <button type="submit" disabled={claiming} aria-busy={claiming} className={BTN_PRIMARY}>
            {claiming ? 'Vinculando…' : 'Vincular'}
          </button>
        </form>
      )}

      <div className="mt-8" aria-live="polite" aria-busy={loading}>
        {error ? (
          <ErrorNotice message={error} onRetry={reload} />
        ) : loading && !data ? (
          <p role="status" className="py-6 text-center text-slate-700">
            Cargando dispositivos…
          </p>
        ) : (
          data && (
            <>
              <h2 className="text-xl font-semibold text-slate-900">
                {canManage ? 'Solicitudes por aprobar' : 'Mis solicitudes en curso'}
              </h2>
              {data.requests.length === 0 ? (
                <p className="mt-2 rounded-md border border-dashed border-slate-400 px-4 py-6 text-center text-slate-700">
                  No hay solicitudes en curso.
                </p>
              ) : (
                <ul
                  className="mt-2 divide-y divide-tinto-100 rounded-md border border-tinto-100"
                  aria-label="Solicitudes de vinculación"
                >
                  {data.requests.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:justify-between"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {r.label} · {r.titular?.displayName ?? 'sin titular'}
                        </p>
                        <p className="text-sm text-slate-700">
                          Vence {formatDate(r.expiresAt)}
                          {canManage && <> · Huella en el dispositivo: compárala en su pantalla</>}
                        </p>
                        <p className="mt-1">
                          <span className={`${BADGE} ${REQUEST_LABELS[r.status]?.cls ?? ''}`}>
                            {REQUEST_LABELS[r.status]?.label ?? r.status}
                          </span>
                        </p>
                      </div>
                      <div className="flex flex-wrap items-start gap-2">
                        {canManage && r.status === 'claimed' && (
                          <button
                            type="button"
                            className={BTN_SMALL}
                            onClick={() => setDialog({ kind: 'approve', request: r })}
                            aria-label={`Aprobar el dispositivo ${r.label} de ${r.titular?.displayName ?? 'una persona'}`}
                          >
                            Aprobar
                          </button>
                        )}
                        <button
                          type="button"
                          className={BTN_SMALL}
                          onClick={() =>
                            setDialog({
                              kind: 'close',
                              request: r,
                              as: canManage ? 'reject' : 'cancel',
                            })
                          }
                          aria-label={`${canManage ? 'Rechazar' : 'Cancelar'} la solicitud ${r.label}`}
                        >
                          {canManage ? 'Rechazar' : 'Cancelar'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <h2 className="mt-8 text-xl font-semibold text-slate-900">
                {canManage ? 'Dispositivos registrados' : 'Mis dispositivos'}
              </h2>
              {data.devices.length === 0 ? (
                <p className="mt-2 rounded-md border border-dashed border-slate-400 px-4 py-6 text-center text-slate-700">
                  No hay dispositivos registrados.
                </p>
              ) : (
                <ul
                  className="mt-2 divide-y divide-tinto-100 rounded-md border border-tinto-100"
                  aria-label="Dispositivos registrados"
                >
                  {data.devices.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:justify-between"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {d.label} · {d.titular.displayName}
                        </p>
                        <p className="text-sm text-slate-700">
                          Huella {d.fingerprint} · vinculado {formatDate(d.registeredAt)}
                          {d.lastSeenAt ? ` · última actividad ${formatDate(d.lastSeenAt)}` : ''}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-2">
                          <span className={`${BADGE} ${DEVICE_LABELS[d.status].cls}`}>
                            {DEVICE_LABELS[d.status].label}
                          </span>
                          {d.status === 'revoked' && d.revokeReason && (
                            <span className="text-sm text-slate-700">
                              {REVOKE_REASON_LABELS[d.revokeReason] ?? d.revokeReason}
                              {d.revokedAt ? ` · ${formatDate(d.revokedAt)}` : ''}
                            </span>
                          )}
                        </p>
                      </div>
                      {d.status === 'active' && (
                        <div className="flex flex-wrap items-start gap-2">
                          <button
                            type="button"
                            className={BTN_SMALL}
                            onClick={() =>
                              setDialog({
                                kind: 'revoke',
                                device: d,
                                as: canManage ? 'authority' : 'titular',
                              })
                            }
                            aria-label={`Revocar el dispositivo ${d.label} de ${d.titular.displayName}`}
                          >
                            Revocar
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )
        )}
      </div>

      {dialog?.kind === 'approve' && (
        <ApproveDialog
          request={dialog.request}
          onClose={() => setDialog(null)}
          onDone={() => changed('Vinculación aprobada. Falta que el dispositivo la confirme.')}
        />
      )}
      {dialog?.kind === 'close' && (
        <ConfirmDialog
          title={dialog.as === 'reject' ? 'Rechazar solicitud' : 'Cancelar solicitud'}
          text={`La solicitud del dispositivo «${dialog.request.label}» se cerrará y ya no podrá usarse.`}
          confirm={dialog.as === 'reject' ? 'Rechazar' : 'Cancelar solicitud'}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (dialog.as === 'reject') await api.rejectMobileRequest(dialog.request.id);
            else await api.cancelMobileRequest(dialog.request.id);
            changed('Solicitud cerrada.');
          }}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <RevokeDeviceDialog
          device={dialog.device}
          as={dialog.as}
          onClose={() => setDialog(null)}
          onDone={() => changed('Dispositivo revocado: su sesión se cerró de inmediato.')}
        />
      )}
    </section>
  );
}

function ConfirmDialog({
  title,
  text,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(mobileErrorMessage(e, 'No se pudo completar la acción.'));
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose} closeDisabled={busy}>
      <div className="space-y-4">
        <p className="text-sm text-slate-700">{text}</p>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Volver
          </button>
          <button
            type="button"
            onClick={go}
            disabled={busy}
            aria-busy={busy}
            className={BTN_PRIMARY}
          >
            {busy ? 'Procesando…' : confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Revocar es inmediato e irreversible: la clave revocada no se vuelve a registrar; hay que vincular un dispositivo nuevo. */
function RevokeDeviceDialog({
  device,
  as,
  onDone,
  onClose,
}: {
  device: MobileDeviceDto;
  as: 'authority' | 'titular';
  onDone: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState<'authority' | 'lost'>('authority');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // La persona titular siempre revoca con el motivo fijo "titular" (lo fija el servidor); aqui solo elige la autoridad.
      if (as === 'titular') await api.revokeMyMobileDevice(device.id);
      else await api.revokeMobileDevice(device.id, { reason });
      onDone();
    } catch (e) {
      setError(mobileErrorMessage(e, 'No se pudo revocar el dispositivo.'));
      setBusy(false);
    }
  }

  return (
    <Modal title="Revocar dispositivo" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={go} className="space-y-4">
        <p className="text-sm text-slate-700">
          El dispositivo <strong>{device.label}</strong> de{' '}
          <strong>{device.titular.displayName}</strong> perderá el acceso{' '}
          <strong>de inmediato</strong> y su clave no podrá volver a registrarse. Para usar otro
          dispositivo habrá que vincularlo de nuevo.
        </p>
        {as === 'authority' && (
          <div>
            <label htmlFor={id} className="block text-sm font-semibold">
              Motivo
            </label>
            <select
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value as 'authority' | 'lost')}
              disabled={busy}
              className={FIELD}
            >
              <option value="authority">Decisión de Dirección</option>
              <option value="lost">Pérdida o robo</option>
            </select>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-tinto-700 bg-tinto-50 px-3 py-2 text-sm text-tinto-900"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={BTN_SECONDARY}>
            Volver
          </button>
          <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
            {busy ? 'Revocando…' : 'Revocar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
