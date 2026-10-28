package mx.edu.eta15.prefectura.mobile

import java.time.Clock
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class Stage { LOADING, NOT_LINKED, KEY_LOST, PAIRING, LINKED }

/** Motivo (sin texto del servidor) por el que una accion no se completo. La interfaz lo traduce a un mensaje. */
enum class LinkIssue {
    NETWORK,
    UNAVAILABLE,
    RATE_LIMITED,
    REQUEST_EXPIRED,
    REQUEST_CLOSED,
    KEY_ALREADY_REGISTERED,
    NOT_ELIGIBLE,
    DEVICE_REVOKED,
    SESSION_ENDED,
    KEY_ERROR,
    UNEXPECTED,
}

data class PairingInfo(
    val requestId: String,
    /** Solo existe en memoria: si la aplicacion se reinicia durante la vinculacion hay que empezar de nuevo. */
    val pairingCode: String?,
    val fingerprint: String,
    val expiresAt: Instant?,
    val status: String,
    val claimedBy: String?,
)

data class SessionSummary(val accessExpiresAt: Instant, val sessionExpiresAt: Instant)

data class MobileUiState(
    val stage: Stage = Stage.LOADING,
    val busy: Boolean = false,
    val protection: KeyProtection? = null,
    val fingerprint: String? = null,
    val pairing: PairingInfo? = null,
    val deviceId: String? = null,
    val label: String? = null,
    /** Nombre de la persona titular que reclamo la vinculacion (solo para mostrarlo). */
    val owner: String? = null,
    val session: SessionSummary? = null,
    val groups: List<GroupItem>? = null,
    val roster: Roster? = null,
    val issue: LinkIssue? = null,
)

/**
 * SOLO debug. Maquina de estados de la vinculacion y la sesion movil de PRUEBAS. Garantias:
 *  - Una clave de dispositivo nueva solo se crea al pulsar "Vincular" (accion explicita); si existe se reutiliza y si falta
 *    (registro local sin clave) se pide decidir: jamas se regenera en silencio.
 *  - La sesion vive solo en memoria; no se guarda en disco ni en la base local.
 *  - Los datos escolares leidos en linea (grupos, padron) tampoco se guardan: solo se muestran.
 *  - No hay colas de envio, sincronizacion ni escritura de asistencia.
 */
class MobileLinkController(
    private val key: DeviceKey,
    private val store: LinkStore,
    private val apiFor: (EcJwk) -> MobileApi,
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.systemUTC(),
    private val pollMillis: Long = 3_000,
) {
    private val _state = MutableStateFlow(MobileUiState())
    val state: StateFlow<MobileUiState> = _state

    private var api: MobileApi? = null
    private var session: MobileSession? = null
    private var pollJob: Job? = null

    /** (Re)evalua el estado local; se llama al entrar a la pantalla. No cambia nada en el Keystore ni en el servidor. */
    fun start() {
        scope.launch { load() }
    }

    fun stop() {
        pollJob?.cancel()
        pollJob = null
    }

    private fun load() {
        stop()
        val hasKey = try {
            key.exists()
        } catch (_: DeviceKeyException) {
            _state.value = MobileUiState(stage = Stage.NOT_LINKED, issue = LinkIssue.KEY_ERROR)
            return
        }
        val record = store.load()
        when {
            record == null -> _state.value = MobileUiState(
                stage = Stage.NOT_LINKED,
                fingerprint = if (hasKey) fingerprintOrNull() else null,
                protection = if (hasKey) key.protection() else null,
            )
            !hasKey -> _state.value = MobileUiState(stage = Stage.KEY_LOST, label = record.label)
            record.deviceId != null -> enterLinked(record.deviceId, record.label, record.owner)
            else -> resumePairing(record)
        }
    }

    private fun fingerprintOrNull(): String? = try {
        key.publicJwk().shortFingerprint()
    } catch (_: DeviceKeyException) {
        null
    }

    private fun resumePairing(record: LinkRecord) {
        val jwk = try {
            key.publicJwk()
        } catch (_: DeviceKeyException) {
            _state.value = MobileUiState(stage = Stage.NOT_LINKED, issue = LinkIssue.KEY_ERROR)
            return
        }
        api = apiFor(jwk)
        _state.value = MobileUiState(
            stage = Stage.PAIRING,
            label = record.label,
            fingerprint = jwk.shortFingerprint(),
            protection = key.protection(),
            pairing = PairingInfo(record.requestId, null, jwk.shortFingerprint(), null, "pending", null),
        )
        poll(record.requestId)
    }

    private fun enterLinked(deviceId: String?, label: String?, owner: String?) {
        val jwk = try {
            key.publicJwk()
        } catch (_: DeviceKeyException) {
            _state.value = MobileUiState(stage = Stage.NOT_LINKED, issue = LinkIssue.KEY_ERROR)
            return
        }
        api = apiFor(jwk)
        _state.value = MobileUiState(
            stage = Stage.LINKED,
            deviceId = deviceId,
            label = label,
            owner = owner,
            fingerprint = jwk.shortFingerprint(),
            protection = key.protection(),
        )
    }

    // ================================================================================================ vinculacion

    fun startLinking(label: String) {
        val current = _state.value
        if (current.busy || current.stage != Stage.NOT_LINKED) return
        _state.update { it.copy(busy = true, issue = null) }
        scope.launch {
            val jwk = try {
                if (!key.exists()) key.create() // accion EXPLICITA de la persona: nunca ocurre sola
                key.publicJwk()
            } catch (_: DeviceKeyException) {
                _state.update { it.copy(busy = false, issue = LinkIssue.KEY_ERROR) }
                return@launch
            }
            val service = apiFor(jwk).also { api = it }
            when (val result = service.enroll(jwk, label)) {
                is ApiResult.Ok -> {
                    val created = result.value
                    try {
                        store.save(LinkRecord(created.requestId, null, label))
                    } catch (_: Exception) {
                        _state.update { it.copy(busy = false, issue = LinkIssue.UNEXPECTED) }
                        return@launch
                    }
                    _state.value = MobileUiState(
                        stage = Stage.PAIRING,
                        label = label,
                        fingerprint = created.fingerprint,
                        protection = key.protection(),
                        pairing = PairingInfo(
                            created.requestId,
                            created.pairingCode,
                            created.fingerprint,
                            created.expiresAt,
                            "pending",
                            null,
                        ),
                    )
                    poll(created.requestId)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(
                        busy = false,
                        fingerprint = jwk.shortFingerprint(),
                        protection = key.protection(),
                        issue = issueOf(result),
                    )
                }
            }
        }
    }

    private fun poll(requestId: String) {
        pollJob?.cancel()
        pollJob = scope.launch {
            val service = api ?: return@launch
            while (isActive) {
                val pairing = _state.value.pairing
                if (pairing?.expiresAt != null && clock.instant() > pairing.expiresAt) {
                    finishPairing(LinkIssue.REQUEST_EXPIRED)
                    return@launch
                }
                when (val result = service.enrollStatus(requestId)) {
                    is ApiResult.Ok -> {
                        val s = result.value
                        when (s.status) {
                            "pending", "claimed" -> _state.update { cur ->
                                cur.copy(
                                    issue = null,
                                    pairing = cur.pairing?.copy(
                                        status = s.status,
                                        claimedBy = s.claimedBy,
                                        expiresAt = s.expiresAt,
                                    ),
                                )
                            }
                            "approved" -> {
                                _state.update { cur ->
                                    cur.copy(pairing = cur.pairing?.copy(status = "approved", claimedBy = s.claimedBy), busy = true)
                                }
                                if (activate(requestId, service)) return@launch
                            }
                            "activated" -> {
                                // La activacion ya ocurrio (p. ej. se interrumpio la respuesta): se continua; el identificador
                                // del dispositivo llega con la primera sesion.
                                val saved = store.load()
                                val owner = s.claimedBy ?: saved?.owner
                                if (saved != null) runCatching { store.save(saved.copy(owner = owner)) }
                                enterLinked(null, saved?.label, owner)
                                return@launch
                            }
                            "rejected", "cancelled" -> {
                                finishPairing(LinkIssue.REQUEST_CLOSED)
                                return@launch
                            }
                            "expired" -> {
                                finishPairing(LinkIssue.REQUEST_EXPIRED)
                                return@launch
                            }
                            else -> {
                                finishPairing(LinkIssue.UNEXPECTED)
                                return@launch
                            }
                        }
                    }
                    is ApiResult.Failure -> {
                        if (result.status == 404) {
                            finishPairing(LinkIssue.REQUEST_CLOSED)
                            return@launch
                        }
                        _state.update { it.copy(issue = issueOf(result)) }
                    }
                }
                delay(pollMillis)
            }
        }
    }

    /** Devuelve true si el proceso de sondeo debe terminar (vinculado o error definitivo). */
    private suspend fun activate(requestId: String, service: MobileApi): Boolean {
        return when (val result = service.activate(requestId)) {
            is ApiResult.Ok -> {
                val label = _state.value.label ?: store.load()?.label ?: ""
                val owner = _state.value.pairing?.claimedBy
                runCatching { store.save(LinkRecord(requestId, result.value, label, owner)) }
                enterLinked(result.value, label, owner)
                true
            }
            is ApiResult.Failure -> {
                if (result.isNetwork) {
                    _state.update { it.copy(busy = false, issue = LinkIssue.NETWORK) }
                    false
                } else {
                    finishPairing(issueOf(result))
                    true
                }
            }
        }
    }

    private fun finishPairing(issue: LinkIssue?) {
        store.clear()
        val hasKey = runCatching { key.exists() }.getOrDefault(false)
        _state.value = MobileUiState(
            stage = Stage.NOT_LINKED,
            fingerprint = if (hasKey) fingerprintOrNull() else null,
            protection = if (hasKey) key.protection() else null,
            issue = issue,
        )
    }

    /** Abandona la vinculacion en curso (la solicitud caduca sola en el servidor; Direccion tambien puede rechazarla). */
    fun cancelLinking() {
        stop()
        finishPairing(null)
    }

    /**
     * Borra la clave de ESTE dispositivo y el registro local ("olvidar"). No revoca nada en el servidor: si el dispositivo estaba
     * vinculado, Direccion debe revocarlo desde el portal. Una clave nueva cambia la identidad: habra que vincular otra vez.
     */
    fun forgetDevice() {
        stop()
        session = null
        try {
            if (key.exists()) key.delete()
        } catch (_: DeviceKeyException) {
            _state.update { it.copy(issue = LinkIssue.KEY_ERROR) }
            return
        }
        store.clear()
        api = null
        _state.value = MobileUiState(stage = Stage.NOT_LINKED)
    }

    // ================================================================================================ sesion y lecturas

    fun openSession() {
        val current = _state.value
        if (current.busy || current.stage != Stage.LINKED) return
        _state.update { it.copy(busy = true, issue = null) }
        scope.launch {
            val service = api ?: return@launch
            when (val result = service.openSession()) {
                is ApiResult.Ok -> acceptSession(result.value)
                is ApiResult.Failure -> _state.update { it.copy(busy = false, issue = issueOf(result)) }
            }
        }
    }

    private fun acceptSession(s: MobileSession) {
        session = s
        store.load()?.let { saved -> if (saved.deviceId == null) runCatching { store.save(saved.copy(deviceId = s.deviceId)) } }
        _state.update {
            it.copy(
                busy = false,
                issue = null,
                deviceId = s.deviceId,
                session = SessionSummary(s.accessExpiresAt, s.sessionExpiresAt),
            )
        }
    }

    fun loadGroups() {
        val current = _state.value
        if (current.busy || current.stage != Stage.LINKED) return
        _state.update { it.copy(busy = true, issue = null, roster = null) }
        scope.launch {
            when (val result = authed { service, s -> service.myGroups(s) }) {
                is ApiResult.Ok -> _state.update { it.copy(busy = false, groups = result.value) }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, groups = null, issue = issueOf(result)) }
            }
        }
    }

    fun loadRoster(groupId: String) {
        val current = _state.value
        if (current.busy || current.stage != Stage.LINKED) return
        _state.update { it.copy(busy = true, issue = null) }
        scope.launch {
            when (val result = authed { service, s -> service.roster(s, groupId) }) {
                is ApiResult.Ok -> _state.update { it.copy(busy = false, roster = result.value) }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, roster = null, issue = issueOf(result)) }
            }
        }
    }

    fun closeRoster() {
        _state.update { it.copy(roster = null) }
    }

    fun closeSession() {
        val current = _state.value
        val open = session
        if (current.busy || current.stage != Stage.LINKED) return
        session = null
        _state.update { it.copy(busy = open != null, session = null, groups = null, roster = null, issue = null) }
        scope.launch {
            val service = api
            if (service != null && open != null) service.closeSession(open) // mejor esfuerzo: la sesion tambien caduca sola
            _state.update { it.copy(busy = false) }
        }
    }

    /** Ejecuta una lectura autenticada; si el acceso vencio, renueva una vez (o abre una sesion nueva) y reintenta. */
    private suspend fun <T> authed(block: suspend (MobileApi, MobileSession) -> ApiResult<T>): ApiResult<T> {
        val service = api ?: return ApiResult.Failure(0, null)
        var s = session
        if (s == null || s.accessExpiresAt <= clock.instant().plusSeconds(5)) {
            when (val renewed = renewOrOpen(service, s)) {
                is ApiResult.Ok -> s = renewed.value
                is ApiResult.Failure -> return renewed
            }
        }
        var result = block(service, s)
        if (result is ApiResult.Failure && result.status == 401 && result.code == "TOKEN_EXPIRED") {
            when (val renewed = renewOrOpen(service, s)) {
                is ApiResult.Ok -> result = block(service, renewed.value)
                is ApiResult.Failure -> return renewed
            }
        }
        return result
    }

    private suspend fun renewOrOpen(service: MobileApi, old: MobileSession?): ApiResult<MobileSession> {
        if (old != null) {
            val renewed = service.renew(old)
            if (renewed is ApiResult.Ok) {
                acceptSession(renewed.value)
                return renewed
            }
        }
        val opened = service.openSession()
        if (opened is ApiResult.Ok) acceptSession(opened.value) else session = null
        return opened
    }

    private fun issueOf(f: ApiResult.Failure): LinkIssue = when {
        f.isNetwork -> LinkIssue.NETWORK
        f.code == "DEVICE_REVOKED" -> LinkIssue.DEVICE_REVOKED
        f.code == "NOT_ELIGIBLE" -> LinkIssue.NOT_ELIGIBLE
        f.code == "REQUEST_EXPIRED" -> LinkIssue.REQUEST_EXPIRED
        f.code == "KEY_ALREADY_REGISTERED" -> LinkIssue.KEY_ALREADY_REGISTERED
        f.code == "SESSION_ENDED" || f.code == "TOKEN_EXPIRED" -> LinkIssue.SESSION_ENDED
        f.status == 429 -> LinkIssue.RATE_LIMITED
        f.status == 503 -> LinkIssue.UNAVAILABLE
        else -> LinkIssue.UNEXPECTED
    }
}
