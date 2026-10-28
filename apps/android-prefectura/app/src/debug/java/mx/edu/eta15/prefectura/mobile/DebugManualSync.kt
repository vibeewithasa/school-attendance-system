package mx.edu.eta15.prefectura.mobile

import java.time.Clock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import mx.edu.eta15.prefectura.domain.ManualSync
import mx.edu.eta15.prefectura.domain.ManualSyncState
import mx.edu.eta15.prefectura.domain.SyncReport
import mx.edu.eta15.prefectura.domain.SyncResultKind

/**
 * SOLO debug. Sesion movil de PRUEBAS de UN ciclo: se abre probando la posesion de la clave del dispositivo (DPoP con nonce de un solo
 * uso), vive solo en memoria y se cierra al terminar. Si el acceso vencio, renueva UNA vez y reintenta UNA vez (nunca en bucle).
 */
class DeviceSyncSessions(private val api: MobileApi, private val clock: Clock = Clock.systemUTC()) : SyncSessions {
    private var session: MobileSession? = null

    override suspend fun <T> authed(block: suspend (MobileSession) -> ApiResult<T>): ApiResult<T> {
        var s = session
        if (s == null || s.accessExpiresAt <= clock.instant().plusSeconds(5)) {
            when (val renewed = renewOrOpen(s)) {
                is ApiResult.Ok -> s = renewed.value
                is ApiResult.Failure -> return renewed
            }
        }
        val result = block(s)
        if (result is ApiResult.Failure && result.status == 401 && result.code == "TOKEN_EXPIRED") {
            return when (val renewed = renewOrOpen(s)) {
                is ApiResult.Ok -> block(renewed.value)
                is ApiResult.Failure -> renewed
            }
        }
        return result
    }

    private suspend fun renewOrOpen(old: MobileSession?): ApiResult<MobileSession> {
        if (old != null) {
            val renewed = api.renew(old)
            if (renewed is ApiResult.Ok) {
                session = renewed.value
                return renewed
            }
        }
        val opened = api.openSession()
        session = (opened as? ApiResult.Ok)?.value
        return opened
    }

    override suspend fun close() {
        val open = session ?: return
        session = null
        api.closeSession(open) // mejor esfuerzo: la sesion tambien caduca sola
    }
}

/**
 * SOLO debug. Un ciclo SOLO nace de [syncNow] (accion de la persona): nada en esta clase escucha la red, el arranque, el inicio de
 * sesion ni un temporizador. Un solo ciclo a la vez; es cancelable sin perder lo persistido.
 */
class DebugManualSync(
    private val scope: CoroutineScope,
    private val engine: ManualSyncEngine,
) : ManualSync {
    override val available: Boolean = true

    private val _state = MutableStateFlow(ManualSyncState())
    override val state: StateFlow<ManualSyncState> = _state

    private var job: Job? = null

    override fun syncNow(groupId: String) {
        var started = false
        _state.update { cur ->
            if (cur.running) {
                cur
            } else {
                started = true
                ManualSyncState(running = true, groupId = groupId, last = null)
            }
        }
        if (!started) return
        job = scope.launch {
            val report = try {
                engine.run(groupId)
            } catch (_: CancellationException) {
                SyncReport(SyncResultKind.CANCELLED)
            } catch (_: Exception) {
                SyncReport(SyncResultKind.RESULT_UNKNOWN)
            }
            _state.value = ManualSyncState(running = false, groupId = groupId, last = report ?: _state.value.last)
        }
    }

    override fun cancel() {
        job?.cancel()
    }

    override fun consumeReport() {
        _state.update { it.copy(last = null) }
    }
}
