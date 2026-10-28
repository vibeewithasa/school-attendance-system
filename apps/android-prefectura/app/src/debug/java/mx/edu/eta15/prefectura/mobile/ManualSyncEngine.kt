package mx.edu.eta15.prefectura.mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.SandboxIds
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxReasons
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.Refusal
import mx.edu.eta15.prefectura.domain.SyncReport
import mx.edu.eta15.prefectura.domain.SyncResultKind

/** Sesion movil de PRUEBAS para un ciclo: se abre probando la posesion de la clave, vive en memoria y nunca se registra. */
interface SyncSessions {
    /** Ejecuta con una sesion vigente; si el acceso vencio, renueva UNA vez. Nunca en bucle. */
    suspend fun <T> authed(block: suspend (MobileSession) -> ApiResult<T>): ApiResult<T>

    suspend fun close()
}

/** Identidad del dispositivo vinculado AHORA (la fuente es el registro local de vinculacion, nunca un valor que ponga la interfaz). */
fun interface SyncIdentity {
    fun deviceId(): String?
}

/**
 * SOLO debug. Motor del CICLO MANUAL de sincronizacion de asistencia contra el servidor de PRUEBAS (ADR 0005 y 0006, propuestos).
 *
 * Que hace un ciclo (lo inicia una persona con "Sincronizar ahora"; nada mas):
 *  1. Comprueba identidad (el dispositivo vinculado es el del perfil) y trata como DESCONOCIDO cualquier envio que quedo a medias.
 *  2. Sella localmente los cambios pendientes del borrador de hoy (accion local, sin red).
 *  3. Pregunta al servidor "hoy" (fecha escolar, grupos asignados, lista existente): la autoridad es el servidor, no el telefono.
 *  4. OPEN: si la lista de hoy existe la reutiliza (sin escribir); si no, la abre (POST). Persiste dayId y revision.
 *  5. SAVE_MARKS: con la lista fresca valida fecha, padron, estado y revision; si todo coincide completa el contexto remoto, persiste
 *     SENDING y envia EXACTAMENTE la operacion sellada (mismo requestId y payload, prueba DPoP nueva en cada peticion).
 *  6. Solo tras PERSISTIR el recibo en Room (una sentencia atomica) la operacion pasa a ACKNOWLEDGED y se informa exito.
 *
 * Lo que NUNCA hace: resolver conflictos, descartar borradores, enviar fechas historicas por el flujo ordinario, reutilizar un
 * requestId con otro contenido, modificar una operacion sellada, reintentar sin limite, cambiar de cuenta a mitad del ciclo ni
 * limpiar un NEEDS_REVIEW. Un solo ciclo a la vez.
 */
class ManualSyncEngine(
    private val profileId: String,
    private val store: SyncStore,
    private val api: AttendanceApi,
    private val sessions: SyncSessions,
    private val identity: SyncIdentity,
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    private val lock = Mutex()

    private class IdentityChanged : Exception()

    private sealed interface Call<out T> {
        data class Ok<T>(val value: T) : Call<T>

        data class Failed(val reaction: Reaction, val failure: ApiResult.Failure, val retriesUsed: Int) : Call<Nothing>
    }

    /** `null` si ya hay un ciclo en curso (solo uno a la vez). */
    suspend fun run(groupId: String): SyncReport? {
        if (!lock.tryLock()) return null
        try {
            return cycle(groupId)
        } finally {
            runCatching { withContext(NonCancellable) { sessions.close() } }
            lock.unlock()
        }
    }

    private suspend fun cycle(groupId: String): SyncReport {
        val device = identity.deviceId() ?: return SyncReport(SyncResultKind.NOT_ALLOWED)
        if (SandboxIds.profile(device) != profileId) return SyncReport(SyncResultKind.NOT_ALLOWED)
        var inFlight: String? = null
        try {
            return runCycle(groupId, device) { inFlight = it }
        } catch (e: CancellationException) {
            // Cancelado con una peticion en vuelo: el resultado es DESCONOCIDO (no se toma por exito ni por fallo). Se conserva.
            withContext(NonCancellable) {
                inFlight?.let { runCatching { store.move(it, OperationState.RETRYABLE_ERROR, OutboxReasons.CANCELLED_UNKNOWN) } }
            }
            throw e
        } catch (_: IdentityChanged) {
            inFlight?.let { runCatching { withContext(NonCancellable) { store.move(it, OperationState.RETRYABLE_ERROR, OutboxReasons.CANCELLED_UNKNOWN) } } }
            return SyncReport(SyncResultKind.NOT_ALLOWED)
        }
    }

    private suspend fun runCycle(groupId: String, device: String, setInFlight: (String?) -> Unit): SyncReport {
        store.recoverUnknown()
        when (val prepared = store.prepareDirty(groupId)) {
            is PrepareResult.AccessBlocked -> return SyncReport(SyncResultKind.SESSION_REQUIRED)
            is PrepareResult.Refused ->
                if (prepared.refusal == Refusal.GroupRevoked) return SyncReport(SyncResultKind.NEEDS_REVIEW)
            PrepareResult.LocalError -> return SyncReport(SyncResultKind.RESULT_UNKNOWN)
            else -> Unit
        }
        val sendable = store.active(groupId).filter { it.state != OperationState.LOCAL_ONLY }
        if (sendable.isEmpty()) return SyncReport(SyncResultKind.NOTHING_TO_SEND)

        fun checkIdentity() {
            if (identity.deviceId() != device) throw IdentityChanged()
        }

        // ---- 3. "hoy" segun el SERVIDOR
        val today = when (val r = call(write = false, check = ::checkIdentity) { api.today(it) }) {
            is Call.Ok -> r.value
            is Call.Failed -> return failedRead(r, null)
        }

        var confirmed = 0
        // Un NEEDS_REVIEW / CONFLICT de OTRA fecha (p. ej. la captura de ayer) sigue bloqueado y conservado, pero NO impide sincronizar
        // la lista de hoy: son listas distintas. Cualquier otro resultado (fallo temporal, sin sesion, desconocido...) detiene el ciclo.
        var carried: SyncResultKind? = null
        for ((date, dayOps) in sendable.groupBy { it.schoolDate }.toSortedMap()) {
            val isToday = date == today.schoolToday
            val report = if (!isToday) {
                historic(dayOps, today, ::checkIdentity, setInFlight)
            } else {
                currentDay(groupId, dayOps, today, ::checkIdentity, setInFlight)
            }
            confirmed += report.confirmed
            when {
                report.kind == SyncResultKind.CONFIRMED || report.kind == SyncResultKind.NOTHING_TO_SEND -> Unit
                !isToday && (report.kind == SyncResultKind.NEEDS_REVIEW || report.kind == SyncResultKind.CONFLICT) ->
                    carried = carried ?: report.kind
                else -> return SyncReport(report.kind, confirmed)
            }
        }
        return when {
            confirmed > 0 -> SyncReport(SyncResultKind.CONFIRMED, confirmed)
            carried != null -> SyncReport(carried)
            else -> SyncReport(SyncResultKind.NOTHING_TO_SEND)
        }
    }

    // ================================================================================================ llamadas

    /** Una llamada autenticada con reintentos ACOTADOS (mismo `requestId`, `jti` nuevo en cada intento). */
    private suspend fun <T> call(write: Boolean, check: () -> Unit, block: suspend (MobileSession) -> ApiResult<T>): Call<T> {
        var attempt = 0
        while (true) {
            check()
            when (val r = sessions.authed(block)) {
                is ApiResult.Ok -> return Call.Ok(r.value)
                is ApiResult.Failure -> {
                    val reaction = SyncPolicy.classify(r, attempt)
                    if (reaction is Reaction.Retry && attempt < SyncPolicy.MAX_RETRIES) {
                        pause(reaction.delayMs)
                        attempt++
                        continue
                    }
                    return Call.Failed(reaction, r, attempt)
                }
            }
        }
    }

    /** Fallo de una LECTURA (nada se escribio ni se cambio de estado). */
    private suspend fun failedRead(r: Call.Failed, op: SyncOp?): SyncReport = when (val reaction = r.reaction) {
        Reaction.Unknown -> SyncReport(SyncResultKind.OFFLINE)
        Reaction.Auth -> SyncReport(SyncResultKind.SESSION_REQUIRED)
        is Reaction.AuthBlocked -> {
            runCatching { store.blockProfile(authStateOf(reaction.code)) }
            SyncReport(SyncResultKind.SESSION_REQUIRED)
        }
        is Reaction.Retry -> SyncReport(SyncResultKind.TEMPORARY_ERROR)
        // Con la lectura habilitada pero el hoy/lista inexistente, el servidor de pruebas no tiene encendida la sincronizacion.
        is Reaction.Review -> if (op == null && r.failure.status == 404) SyncReport(SyncResultKind.NOT_ENABLED) else SyncReport(SyncResultKind.NEEDS_REVIEW)
        is Reaction.Conflict -> SyncReport(SyncResultKind.CONFLICT)
    }

    // ================================================================================================ otras fechas

    /**
     * Operaciones de una fecha que NO es el hoy del servidor. Nada historico se envia por el flujo ordinario: lo que no salio pasa a
     * revision. La unica excepcion es VERIFICAR un envio anterior de resultado desconocido (RETRYABLE_ERROR): se repite la MISMA
     * operacion y el servidor, por su `requestId`, o la reconoce (replay) o la rechaza (DAY_NOT_CURRENT): jamas crea nada nuevo.
     */
    private suspend fun historic(ops: List<SyncOp>, today: SrvToday, check: () -> Unit, setInFlight: (String?) -> Unit): SyncReport {
        var confirmed = 0
        for (op in ops.sortedBy { it.seq }) {
            when {
                op.state == OperationState.RETRYABLE_ERROR && op.kind == OperationKind.SAVE_MARKS && op.hasContext() -> {
                    val r = sendSave(op, validated = false, today = today, check = check, setInFlight = setInFlight)
                    confirmed += r.confirmed
                    if (r.kind != SyncResultKind.CONFIRMED) return SyncReport(r.kind, confirmed)
                }
                op.state == OperationState.NEEDS_REVIEW || op.state == OperationState.CONFLICT -> return SyncReport(kindOfBlocked(op), confirmed)
                else -> {
                    if (!store.move(op.id, OperationState.NEEDS_REVIEW, OutboxReasons.DATE_MISMATCH)) return SyncReport(SyncResultKind.RESULT_UNKNOWN, confirmed)
                    return SyncReport(SyncResultKind.NEEDS_REVIEW, confirmed)
                }
            }
        }
        return SyncReport(if (confirmed > 0) SyncResultKind.CONFIRMED else SyncResultKind.NOTHING_TO_SEND, confirmed)
    }

    private fun SyncOp.hasContext() = requestId != null && serverDayId != null && expectedRevision != null

    private fun kindOfBlocked(op: SyncOp) = if (op.state == OperationState.CONFLICT) SyncResultKind.CONFLICT else SyncResultKind.NEEDS_REVIEW

    // ================================================================================================ el dia de hoy

    private suspend fun currentDay(
        groupId: String,
        ops: List<SyncOp>,
        today: SrvToday,
        check: () -> Unit,
        setInFlight: (String?) -> Unit,
    ): SyncReport {
        val first = ops.first()
        val entry = today.groups.firstOrNull { it.groupId == first.remoteGroupId }
        // Un NEEDS_REVIEW o CONFLICT bloquea TODO envio de ese grupo y fecha: no se limpia, no se salta.
        ops.firstOrNull { it.state == OperationState.CONFLICT }?.let { return SyncReport(SyncResultKind.CONFLICT) }
        ops.firstOrNull { it.state == OperationState.NEEDS_REVIEW }?.let { return SyncReport(SyncResultKind.NEEDS_REVIEW) }
        if (!today.isSchoolDay || entry == null) {
            val reason = if (!today.isSchoolDay) OutboxReasons.NOT_SCHOOL_DAY else OutboxReasons.GROUP_NOT_ASSIGNED
            for (op in ops) if (!store.move(op.id, OperationState.NEEDS_REVIEW, reason)) return SyncReport(SyncResultKind.RESULT_UNKNOWN)
            return SyncReport(SyncResultKind.NEEDS_REVIEW)
        }

        var confirmed = 0
        // ---- OPEN
        ops.firstOrNull { it.kind == OperationKind.OPEN }?.let { open ->
            val r = resolveOpen(open, ops, entry.day, today, check, setInFlight)
            if (r != null) return SyncReport(r, confirmed)
        }
        // ---- SAVE_MARKS, en orden de secuencia (la dependencia con la anterior ya esta confirmada o se detiene el ciclo)
        for (op in ops.filter { it.kind == OperationKind.SAVE_MARKS }.sortedBy { it.seq }) {
            val dep = op.dependsOnId?.let { store.operation(it) }
            if (dep == null || dep.state != OperationState.ACKNOWLEDGED || dep.serverDayId == null || dep.ackRevision == null) {
                return SyncReport(if (confirmed > 0) SyncResultKind.CONFIRMED else SyncResultKind.NEEDS_REVIEW, confirmed)
            }
            val r = if (op.state == OperationState.RETRYABLE_ERROR && op.hasContext()) {
                sendSave(op, validated = false, today = today, check = check, setInFlight = setInFlight)
            } else {
                sendSave(op, validated = true, today = today, check = check, setInFlight = setInFlight, dependency = dep)
            }
            confirmed += r.confirmed
            if (r.kind != SyncResultKind.CONFIRMED) return SyncReport(r.kind, confirmed)
        }
        return SyncReport(if (confirmed > 0) SyncResultKind.CONFIRMED else SyncResultKind.NOTHING_TO_SEND, confirmed)
    }

    /** `null` si el padron vigente del servidor coincide con el de la captura; si no, el resultado del ciclo (nada se abrio ni se envio). */
    private suspend fun prevalidateRoster(open: SyncOp, dayOps: List<SyncOp>, check: () -> Unit): SyncResultKind? {
        suspend fun block(reason: String): SyncResultKind {
            for (op in dayOps) if (!store.move(op.id, OperationState.NEEDS_REVIEW, reason)) return SyncResultKind.RESULT_UNKNOWN
            return SyncResultKind.NEEDS_REVIEW
        }
        return when (val r = call(write = false, check = check) { api.groupRoster(it, open.remoteGroupId) }) {
            is Call.Ok -> {
                val remote = r.value.students.map { it.id.lowercase() }.toSet()
                val sameGroup = r.value.groupId.isEmpty() || r.value.groupId.lowercase() == open.remoteGroupId.lowercase()
                if (sameGroup && remote == store.localRoster(open.draftId)) null else block(OutboxReasons.ROSTER_CHANGED)
            }
            // 404 = el grupo ya no esta autorizado para esta persona (no se enumera nada mas)
            is Call.Failed -> if (r.failure.status == 404) block(OutboxReasons.GROUP_NOT_ASSIGNED) else failedRead(r, open).kind
        }
    }

    /**
     * OPEN del dia. Si la lista YA existe se reutiliza su `dayId` y su revision sin escribir nada (el servidor tiene una sola lista
     * por grupo y fecha). Si no, se abre. Si se pierde la respuesta, el siguiente ciclo consulta primero "hoy": no se abre dos veces.
     * Devuelve `null` si el OPEN quedo CONFIRMADO; si no, el motivo por el que el ciclo se detiene.
     */
    private suspend fun resolveOpen(
        open: SyncOp,
        dayOps: List<SyncOp>,
        existing: SrvDay?,
        today: SrvToday,
        check: () -> Unit,
        setInFlight: (String?) -> Unit,
    ): SyncResultKind? {
        // PADRON ANTES DE OPEN: si hay que ABRIR la lista (el servidor congelaria el padron vigente de hoy), se compara primero ese padron con
        // el de la captura. Si no coincide no se abre nada, no se envia ninguna marca y todo queda en NEEDS_REVIEW (no se aplica el padron
        // remoto). No es atomico con OPEN (son llamadas HTTP distintas; el contrato no ofrece una validacion dentro de OPEN): si el padron
        // cambia entre la comparacion y OPEN, la validacion posterior de SAVE_MARKS lo detecta igual y no se envia ninguna marca.
        if (existing == null) prevalidateRoster(open, dayOps, check)?.let { return it }
        if (open.state == OperationState.WAITING_REMOTE_CONTEXT) {
            // La fecha escolar la confirma ahora el servidor (la operacion nacio con la fecha sin confirmar).
            if (!store.setContext(open.id, null, null)) return SyncResultKind.RESULT_UNKNOWN
        }
        if (!store.begin(open.id)) return SyncResultKind.RESULT_UNKNOWN
        setInFlight(open.id)
        if (existing != null) {
            if (existing.groupId != open.remoteGroupId || existing.attendanceDate != today.schoolToday) {
                setInFlight(null)
                store.move(open.id, OperationState.NEEDS_REVIEW, OutboxReasons.DATE_MISMATCH)
                return SyncResultKind.NEEDS_REVIEW
            }
            val ok = try {
                store.acknowledge(open.id, existing.id, existing.revision, 0, true)
            } catch (_: Exception) {
                false
            }
            setInFlight(null)
            return if (ok) null else SyncResultKind.RESULT_UNKNOWN
        }
        return when (val r = call(write = true, check = check) { api.openDay(it, open.remoteGroupId, today.schoolToday) }) {
            is Call.Ok -> {
                val day = r.value.detail.day
                if (day.groupId != open.remoteGroupId || day.attendanceDate != today.schoolToday) {
                    setInFlight(null)
                    store.move(open.id, OperationState.NEEDS_REVIEW, OutboxReasons.ACK_MISMATCH)
                    SyncResultKind.NEEDS_REVIEW
                } else {
                    val ok = try {
                        store.acknowledge(open.id, day.id, day.revision, 0, !r.value.created)
                    } catch (_: Exception) {
                        false
                    }
                    setInFlight(null)
                    if (ok) null else SyncResultKind.RESULT_UNKNOWN
                }
            }
            is Call.Failed -> {
                setInFlight(null)
                settleFailure(open, r)
            }
        }
    }

    /**
     * Envia UNA operacion SAVE_MARKS. `validated = true`: operacion nueva, se valida con la lista fresca antes de enviar.
     * `validated = false`: reintento de una operacion ya enviada con resultado desconocido: se repite EXACTAMENTE (mismo
     * `requestId`, payload y `expectedRevision`); el servidor la reconoce antes de mirar la revision.
     */
    private suspend fun sendSave(
        op: SyncOp,
        validated: Boolean,
        today: SrvToday,
        check: () -> Unit,
        setInFlight: (String?) -> Unit,
        dependency: SyncOp? = null,
    ): SyncReport {
        val requestId = op.requestId ?: return SyncReport(SyncResultKind.NEEDS_REVIEW)
        val payload = store.payload(op.id)
        var dayId = op.serverDayId
        var revision = op.expectedRevision
        if (validated) {
            dayId = dependency?.serverDayId ?: return SyncReport(SyncResultKind.NEEDS_REVIEW)
            val detail = when (val r = call(write = false, check = check) { api.day(it, dayId) }) {
                is Call.Ok -> r.value
                is Call.Failed -> return failedWrite(op, r, wasSending = false)
            }
            // El contexto remoto se completa ahora (no es parte de la identidad sellada) y la operacion queda READY.
            if (!store.setContext(op.id, dayId, detail.day.revision)) return SyncReport(SyncResultKind.RESULT_UNKNOWN)
            revision = detail.day.revision
            val verdict = SyncPolicy.validateBeforeSend(
                op = op,
                payload = payload,
                detail = detail,
                serverToday = today.schoolToday,
                localRoster = store.localRoster(op.draftId),
                ackedStudents = store.ackedStudents(op.draftId),
                knownRevision = dependency.ackRevision,
            )
            when (verdict) {
                Verdict.Proceed -> Unit
                is Verdict.Review -> {
                    if (!store.move(op.id, OperationState.NEEDS_REVIEW, verdict.reason)) return SyncReport(SyncResultKind.RESULT_UNKNOWN)
                    return SyncReport(SyncResultKind.NEEDS_REVIEW)
                }
                is Verdict.Conflict -> {
                    if (!store.move(op.id, OperationState.CONFLICT, verdict.reason)) return SyncReport(SyncResultKind.RESULT_UNKNOWN)
                    return SyncReport(SyncResultKind.CONFLICT)
                }
            }
        }
        val sendDay = dayId ?: return SyncReport(SyncResultKind.NEEDS_REVIEW)
        val sendRevision = revision ?: return SyncReport(SyncResultKind.NEEDS_REVIEW)

        // SENDING se persiste ANTES de la peticion: si el proceso muere ahora, el resultado es desconocido (nunca exito).
        if (!store.begin(op.id)) return SyncReport(SyncResultKind.RESULT_UNKNOWN)
        setInFlight(op.id)
        val sent = op.copy(serverDayId = sendDay, expectedRevision = sendRevision)
        val result = call(write = true, check = check) { api.saveMarks(it, sendDay, sendRevision, requestId, payload) }
        return when (result) {
            is Call.Ok -> {
                val reason = SyncPolicy.verifyReceipt(sent, payload, result.value)
                if (reason != null) {
                    setInFlight(null)
                    store.move(op.id, OperationState.NEEDS_REVIEW, reason)
                    SyncReport(SyncResultKind.NEEDS_REVIEW)
                } else {
                    // Exito SOLO despues de persistir el recibo (una sentencia atomica). Si falla, la operacion queda SENDING =
                    // resultado desconocido y el proximo ciclo la recupera con el mismo requestId (el servidor responde replayed).
                    val day = result.value.detail.day
                    val persisted = try {
                        store.acknowledge(op.id, day.id, day.revision, result.value.changed, result.value.replayed)
                    } catch (_: Exception) {
                        false
                    }
                    setInFlight(null)
                    if (persisted) SyncReport(SyncResultKind.CONFIRMED, 1) else SyncReport(SyncResultKind.RESULT_UNKNOWN)
                }
            }
            is Call.Failed -> {
                setInFlight(null)
                failedWrite(op, result, wasSending = true)
            }
        }
    }

    /** Convierte un fallo en el estado de la operacion y en el resultado del ciclo. Nada se descarta; nada se reintenta sin limite. */
    private suspend fun failedWrite(op: SyncOp, r: Call.Failed, wasSending: Boolean): SyncReport {
        val kind = settleFailure(op, r, wasSending)
        return SyncReport(kind)
    }

    private suspend fun settleFailure(op: SyncOp, r: Call.Failed, wasSending: Boolean = true): SyncResultKind {
        val status = r.failure.status
        val code = r.failure.code
        // Una lectura previa al envio que falla NO cambia el estado de la operacion (nada salio todavia).
        if (!wasSending) {
            (r.reaction as? Reaction.AuthBlocked)?.let { runCatching { store.blockProfile(authStateOf(it.code)) } }
            return readOutcome(r)
        }
        suspend fun to(state: OperationState, reason: String): Boolean = try {
            store.move(op.id, state, reason, status, code)
        } catch (_: Exception) {
            false
        }
        return when (val reaction = r.reaction) {
            Reaction.Unknown -> {
                to(OperationState.RETRYABLE_ERROR, OutboxReasons.NETWORK)
                SyncResultKind.RESULT_UNKNOWN // se envio y no hay respuesta: puede estar aplicado
            }
            is Reaction.Retry -> if (to(OperationState.RETRYABLE_ERROR, reaction.reason)) SyncResultKind.TEMPORARY_ERROR else SyncResultKind.RESULT_UNKNOWN
            Reaction.Auth -> if (to(OperationState.AUTH_REQUIRED, OutboxReasons.SESSION_REQUIRED)) SyncResultKind.SESSION_REQUIRED else SyncResultKind.RESULT_UNKNOWN
            is Reaction.AuthBlocked -> {
                val moved = to(OperationState.AUTH_REQUIRED, reaction.code)
                runCatching { store.blockProfile(authStateOf(reaction.code)) }
                if (moved) SyncResultKind.SESSION_REQUIRED else SyncResultKind.RESULT_UNKNOWN
            }
            is Reaction.Review -> if (to(OperationState.NEEDS_REVIEW, reaction.reason)) SyncResultKind.NEEDS_REVIEW else SyncResultKind.RESULT_UNKNOWN
            is Reaction.Conflict -> if (to(OperationState.CONFLICT, reaction.reason)) SyncResultKind.CONFLICT else SyncResultKind.RESULT_UNKNOWN
        }
    }

    private fun authStateOf(code: String) =
        if (code == "DEVICE_REVOKED") OfflineCacheStore.AUTH_DEVICE_REVOKED else OfflineCacheStore.AUTH_ACCOUNT_BLOCKED

    private fun readOutcome(r: Call.Failed): SyncResultKind = when (r.reaction) {
        Reaction.Unknown -> SyncResultKind.OFFLINE
        Reaction.Auth, is Reaction.AuthBlocked -> SyncResultKind.SESSION_REQUIRED
        is Reaction.Retry -> SyncResultKind.TEMPORARY_ERROR
        is Reaction.Conflict -> SyncResultKind.CONFLICT
        is Reaction.Review -> SyncResultKind.NEEDS_REVIEW
    }
}
