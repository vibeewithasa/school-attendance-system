package mx.edu.eta15.prefectura.domain

import java.security.MessageDigest
import java.time.LocalDate

/*
 * OUTBOX local de asistencia (esquema Room v3; SANDBOX ONLY; la escuela no aprobo ninguna politica de sincronizacion).
 *
 * Esta fase PREPARA operaciones para una futura sincronizacion y NO las envia: aqui no hay cliente HTTP, programador de trabajos
 * en segundo plano ni reintentos. Cuatro cosas distintas, que no se confunden:
 *   1. BORRADOR LOCAL editable: `attendance_drafts` y `attendance_marks` (la captura de la prefecta; siempre se puede cambiar).
 *   2. INTENCION persistente: una operacion SAVE_MARKS en [OperationState.LOCAL_ONLY], sin payload ni requestId. Solo dice "este
 *      borrador tiene cambios sin preparar". Es desechable y no tiene identidad de red.
 *   3. OPERACION sellada (la intencion ya con payload logico, huella y requestId): inmutable. Aun sellada puede faltarle el CONTEXTO
 *      REMOTO (dayId de la lista del servidor y revision esperada): entonces espera en [OperationState.WAITING_REMOTE_CONTEXT] y NO
 *      se marca READY. La identidad (requestId, payload, huella) NO depende de ese contexto: el servidor calcula la huella solo con
 *      las marcas y trata `expectedRevision` como parametro de transporte; por eso el contexto se agrega despues sin alterar la
 *      identidad.
 *   4. RECIBO del servidor (ack): columnas reservadas; solo se llenan en una fase de transporte futura.
 */

enum class OperationKind { OPEN, SAVE_MARKS }

enum class OperationState {
    /** Intencion sin sellar: hay cambios locales sin preparar. Sin payload, sin requestId. */
    LOCAL_ONLY,

    /** Sellada, pero falta el contexto remoto (lista del servidor, revision esperada, fecha confirmada): no puede transmitirse. */
    WAITING_REMOTE_CONTEXT,

    /** Operacion HTTP completa e inmutable, lista para una futura transmision. */
    READY,

    /** Entregada al transporte (futuro). Un SENDING persistido tras un reinicio NUNCA se toma como exito. */
    SENDING,

    ACKNOWLEDGED,
    RETRYABLE_ERROR,
    AUTH_REQUIRED,
    CONFLICT,
    NEEDS_REVIEW,
    SUPERSEDED,
    DISCARDED,
    ;

    val isTerminal: Boolean get() = this == ACKNOWLEDGED || this == SUPERSEDED || this == DISCARDED

    /** Nunca llego (ni pudo llegar) al servidor: se puede reemplazar sin riesgo de contradecir algo ya enviado. */
    val isUnsent: Boolean get() = this == LOCAL_ONLY || this == WAITING_REMOTE_CONTEXT || this == READY || this == NEEDS_REVIEW

    /** Pudo haber llegado al servidor (o llego): sus marcas cuentan como "posiblemente aplicadas". */
    val mayHaveReachedServer: Boolean
        get() = this == SENDING || this == RETRYABLE_ERROR || this == AUTH_REQUIRED || this == CONFLICT || this == ACKNOWLEDGED

    fun canTransitionTo(next: OperationState): Boolean = next in OutboxTransitions.ALLOWED.getValue(this)
}

/** Maquina de estados. La misma tabla se impone en la base con un disparador (ver EtaDatabase): ninguna ruta puede saltarla. */
object OutboxTransitions {
    val ALLOWED: Map<OperationState, Set<OperationState>> = mapOf(
        OperationState.LOCAL_ONLY to setOf(
            OperationState.WAITING_REMOTE_CONTEXT, OperationState.READY, OperationState.NEEDS_REVIEW,
            OperationState.SUPERSEDED, OperationState.DISCARDED,
        ),
        // CONFLICT desde WAITING_REMOTE_CONTEXT y READY: el transporte manual detecta ANTES de enviar que la lista del servidor cambio
        // (revision distinta, marcas de otra persona, lista finalizada). No se resuelve solo: se conserva hasta una decision de la persona.
        OperationState.WAITING_REMOTE_CONTEXT to setOf(
            OperationState.READY, OperationState.NEEDS_REVIEW, OperationState.CONFLICT, OperationState.SUPERSEDED,
            OperationState.DISCARDED,
        ),
        OperationState.READY to setOf(
            OperationState.SENDING, OperationState.WAITING_REMOTE_CONTEXT, OperationState.AUTH_REQUIRED,
            OperationState.NEEDS_REVIEW, OperationState.CONFLICT, OperationState.SUPERSEDED, OperationState.DISCARDED,
        ),
        OperationState.SENDING to setOf(
            OperationState.ACKNOWLEDGED, OperationState.RETRYABLE_ERROR, OperationState.AUTH_REQUIRED,
            OperationState.CONFLICT, OperationState.NEEDS_REVIEW,
        ),
        // Tras un error con resultado desconocido NO se descarta (podria haberse aplicado): solo se reintenta o se revisa.
        OperationState.RETRYABLE_ERROR to setOf(
            OperationState.SENDING, OperationState.READY, OperationState.AUTH_REQUIRED, OperationState.CONFLICT,
            OperationState.NEEDS_REVIEW, OperationState.ACKNOWLEDGED,
        ),
        OperationState.AUTH_REQUIRED to setOf(OperationState.READY, OperationState.NEEDS_REVIEW, OperationState.SENDING),
        OperationState.CONFLICT to setOf(OperationState.READY, OperationState.NEEDS_REVIEW, OperationState.SUPERSEDED),
        OperationState.NEEDS_REVIEW to setOf(
            OperationState.READY, OperationState.WAITING_REMOTE_CONTEXT, OperationState.SUPERSEDED, OperationState.DISCARDED,
        ),
        OperationState.ACKNOWLEDGED to emptySet(),
        OperationState.SUPERSEDED to emptySet(),
        OperationState.DISCARDED to emptySet(),
    )

    /** Pares "ORIGEN>DESTINO" validos, para el disparador de la base. */
    fun sqlPairs(): List<String> = ALLOWED.flatMap { (from, tos) -> tos.map { "${from.name}>${it.name}" } }
}

/** Motivos estables (en la base y en las pruebas). Nunca contienen datos de alumnos ni mensajes del servidor. */
object OutboxReasons {
    const val DATE_HISTORIC = "DATE_HISTORIC"
    const val DATE_UNCONFIRMED = "DATE_UNCONFIRMED"
    const val ROSTER_CHANGED = "ROSTER_CHANGED"
    const val STUDENT_INACTIVE = "STUDENT_INACTIVE"
    const val GROUP_REVOKED = "GROUP_REVOKED"
    const val WAITING_OPEN = "WAITING_OPEN"
    const val WAITING_PREVIOUS = "WAITING_PREVIOUS"
    const val RESULT_UNKNOWN_AFTER_RESTART = "RESULT_UNKNOWN_AFTER_RESTART"
    const val DEVICE_REVOKED = "DEVICE_REVOKED"
    const val ACCOUNT_BLOCKED = "ACCOUNT_BLOCKED"

    // ------------------------------------------------------------------------------ transporte manual (sandbox)
    /** La fecha escolar del servidor no es la de la operacion (el telefono o la captura estan en otro dia). */
    const val DATE_MISMATCH = "DATE_MISMATCH"
    const val NOT_SCHOOL_DAY = "NOT_SCHOOL_DAY"

    /** El servidor ya no lista el grupo entre los asignados de hoy. */
    const val GROUP_NOT_ASSIGNED = "GROUP_NOT_ASSIGNED"
    const val DAY_FINALIZED = "DAY_FINALIZED"

    /** La lista del servidor cambio desde lo ultimo que este dispositivo confirmo. */
    const val REVISION_CHANGED = "REVISION_CHANGED"

    /** El servidor ya tiene otra marca (de otra persona) para un alumno que este dispositivo nunca escribio. */
    const val DIVERGENT_MARKS = "DIVERGENT_MARKS"
    const val IDEMPOTENCY_MISMATCH = "IDEMPOTENCY_MISMATCH"

    /** La respuesta del servidor no corresponde a lo que se envio. */
    const val ACK_MISMATCH = "ACK_MISMATCH"
    const val FORBIDDEN = "FORBIDDEN"
    const val NOT_FOUND = "NOT_FOUND"
    const val INVALID_REQUEST = "INVALID_REQUEST"
    const val RATE_LIMITED = "RATE_LIMITED"
    const val UNAVAILABLE = "UNAVAILABLE"
    const val NETWORK = "NETWORK"
    const val SESSION_REQUIRED = "SESSION_REQUIRED"

    /** El ciclo se cancelo con una peticion en vuelo: el resultado es desconocido. */
    const val CANCELLED_UNKNOWN = "CANCELLED_UNKNOWN"
}

/** De donde salio la certeza de la fecha del borrador al sellar la operacion. El reloj del telefono NO es autoridad escolar. */
enum class DateProvenance { SERVER_CONFIRMED, DEVICE_UNCONFIRMED }

/** Una marca en el formato del servidor: `studentId` en minuscula y `status` `present` o `absent` (nunca "pending"). */
data class WireMark(val studentId: String, val status: String) {
    companion object {
        fun statusOf(mark: AttendanceMark): String = when (mark) {
            AttendanceMark.PRESENT -> "present"
            AttendanceMark.ABSENT -> "absent"
        }

        fun markOf(status: String): AttendanceMark? = when (status) {
            "present" -> AttendanceMark.PRESENT
            "absent" -> AttendanceMark.ABSENT
            else -> null
        }
    }
}

/** Contrato canonico con el servidor (backend `marksHash` y `saveAttendanceMarksBody`): una sola fuente para el cliente. */
object OutboxCanonical {
    /** Version del formato del payload sellado: si cambia el contrato, las operaciones ya selladas conservan la suya. */
    const val SCHEMA_VERSION = 1

    /** Maximo de marcas por operacion (el servidor rechaza mas de 200 por peticion). */
    const val MAX_MARKS = 200

    private val UUID_LOWER = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    /** Minusculas, y solo si es un UUID: cualquier otra cosa no es un identificador de alumno del servidor. */
    fun normalizeStudentId(raw: String?): String? = raw?.lowercase()?.takeIf { UUID_LOWER.matches(it) }

    /**
     * SHA-256 hexadecimal de `studentId:status` ordenado por `studentId` y unido con `|` (identico a `marksHash` del backend).
     * No incluye `dayId`, `groupId` ni `expectedRevision`: la identidad de la operacion no depende del contexto remoto.
     */
    fun marksHash(marks: List<WireMark>): String {
        val canonical = marks.sortedBy { it.studentId }.joinToString("|") { "${it.studentId}:${it.status}" }
        return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}

// ------------------------------------------------------------------------------------------------------ planificador (puro)

data class PlanMark(val remoteStudentId: String, val mark: AttendanceMark, val studentActive: Boolean)

/** Una operacion ya existente del mismo borrador, vista por el planificador. */
data class PriorOperation(
    val id: String,
    val kind: OperationKind,
    val state: OperationState,
    val seq: Int,
    /** Payload sellado (`studentId` -> `present|absent`); `null` en OPEN y en intenciones sin sellar. */
    val marks: Map<String, String>?,
    val serverDayId: String? = null,
    val ackRevision: Int? = null,
)

data class SealInput(
    val profileIsSandbox: Boolean,
    val groupRevoked: Boolean,
    val draftDate: LocalDate,
    val today: LocalDate,
    /** La fecha de hoy del telefono coincide con la ultima fecha escolar confirmada por el servidor. */
    val dateConfirmed: Boolean,
    val draftNeedsReview: Boolean,
    val draftReviewReason: String?,
    /** Marcas explicitas del borrador (los Pendientes NO aparecen: no son una orden). */
    val marks: List<PlanMark>,
    /** Alumnos del borrador SIN marca (Pendiente): solo sirve para detectar des-marcas respecto de operaciones ya enviadas. */
    val priorOperations: List<PriorOperation>,
)

sealed interface Refusal {
    data object NotSandbox : Refusal
    data object GroupRevoked : Refusal
    data object NothingToPrepare : Refusal
    data class TooManyMarks(val count: Int) : Refusal
    data class InvalidIdentifier(val count: Int) : Refusal

    /** Alumnos con marca en una operacion que pudo llegar al servidor y que ahora estan Pendientes: no se les puede "quitar" la marca. */
    data class UnmarkAfterSend(val students: Int) : Refusal
}

data class SealPlan(
    val wire: List<WireMark>,
    val hash: String,
    val state: OperationState,
    val reason: String?,
    val provenance: DateProvenance,
    /** Operacion previa de la que depende (la ultima que pudo llegar al servidor o, si no hay, la de OPEN). `null` = la OPEN por crear. */
    val dependsOnId: String?,
    /** Operaciones SAVE_MARKS sin enviar que esta reemplaza (siguen conservadas, como SUPERSEDED). */
    val supersede: List<String>,
    /** Contexto remoto ya conocido (solo si la dependencia fue confirmada por el servidor). */
    val serverDayId: String?,
    val expectedRevision: Int?,
    /** Estado con el que debe crearse la operacion OPEN si aun no existe. */
    val openState: OperationState,
    val openReason: String?,
)

/** Resultado puro del planificador: o se sella con este plan, o se rechaza, o ya estaba preparado. */
sealed interface PlanOutcome {
    data class Seal(val plan: SealPlan) : PlanOutcome
    data class Refuse(val refusal: Refusal) : PlanOutcome
    data class AlreadyPrepared(val operationId: String) : PlanOutcome
}

object OutboxPlanner {
    /** Hay cambios locales sin preparar: las marcas explicitas difieren del payload de la ultima operacion sellada vigente. */
    fun isDirty(local: Map<String, String>, latestSealedPayload: Map<String, String>?): Boolean =
        if (latestSealedPayload == null) local.isNotEmpty() else local != latestSealedPayload

    /** La ultima operacion SAVE_MARKS sellada y vigente (ni reemplazada ni descartada): la que describe lo ya preparado. */
    fun latestActiveSealed(prior: List<PriorOperation>): PriorOperation? =
        prior.filter { it.kind == OperationKind.SAVE_MARKS && it.marks != null && it.state != OperationState.SUPERSEDED && it.state != OperationState.DISCARDED }
            .maxByOrNull { it.seq }

    fun plan(input: SealInput): PlanOutcome {
        if (!input.profileIsSandbox) return PlanOutcome.Refuse(Refusal.NotSandbox)
        if (input.groupRevoked) return PlanOutcome.Refuse(Refusal.GroupRevoked)
        if (input.marks.isEmpty()) return PlanOutcome.Refuse(Refusal.NothingToPrepare)
        if (input.marks.size > OutboxCanonical.MAX_MARKS) return PlanOutcome.Refuse(Refusal.TooManyMarks(input.marks.size))
        val invalid = input.marks.count { OutboxCanonical.normalizeStudentId(it.remoteStudentId) == null }
        if (invalid > 0) return PlanOutcome.Refuse(Refusal.InvalidIdentifier(invalid))
        val wire = input.marks
            .map { WireMark(OutboxCanonical.normalizeStudentId(it.remoteStudentId)!!, WireMark.statusOf(it.mark)) }
            .sortedBy { it.studentId }
        val local = wire.associate { it.studentId to it.status }

        val latest = latestActiveSealed(input.priorOperations)
        if (latest != null && !isDirty(local, latest.marks)) return PlanOutcome.AlreadyPrepared(latest.id)

        // Una marca que una operacion PUDO dejar en el servidor no se puede convertir en "pendiente": Pendiente no es una orden de borrar.
        val maybeApplied = input.priorOperations
            .filter { it.kind == OperationKind.SAVE_MARKS && it.state.mayHaveReachedServer }
            .flatMap { it.marks?.keys.orEmpty() }
            .toSet()
        val unmarked = maybeApplied.count { it !in local }
        if (unmarked > 0) return PlanOutcome.Refuse(Refusal.UnmarkAfterSend(unmarked))

        val supersede = input.priorOperations
            .filter { it.kind == OperationKind.SAVE_MARKS && it.state != OperationState.LOCAL_ONLY && it.state.isUnsent }
            .map { it.id }
        val dependency = input.priorOperations
            .filter { it.kind == OperationKind.SAVE_MARKS && it.state.mayHaveReachedServer }
            .maxByOrNull { it.seq }

        val historic = input.draftDate != input.today
        val provenance = if (input.dateConfirmed) DateProvenance.SERVER_CONFIRMED else DateProvenance.DEVICE_UNCONFIRMED
        val inactive = input.marks.any { !it.studentActive }

        var state = OperationState.WAITING_REMOTE_CONTEXT
        var reason: String? = if (dependency != null) OutboxReasons.WAITING_PREVIOUS else OutboxReasons.WAITING_OPEN
        var dayId: String? = null
        var revision: Int? = null
        when {
            historic -> { state = OperationState.NEEDS_REVIEW; reason = OutboxReasons.DATE_HISTORIC }
            input.draftNeedsReview -> { state = OperationState.NEEDS_REVIEW; reason = input.draftReviewReason ?: OutboxReasons.ROSTER_CHANGED }
            inactive -> { state = OperationState.NEEDS_REVIEW; reason = OutboxReasons.STUDENT_INACTIVE }
            !input.dateConfirmed -> { reason = OutboxReasons.DATE_UNCONFIRMED }
            dependency != null && dependency.state == OperationState.ACKNOWLEDGED && dependency.serverDayId != null && dependency.ackRevision != null -> {
                state = OperationState.READY
                reason = null
                dayId = dependency.serverDayId
                revision = dependency.ackRevision
            }
        }
        val (openState, openReason) = when {
            historic -> OperationState.NEEDS_REVIEW to OutboxReasons.DATE_HISTORIC
            !input.dateConfirmed -> OperationState.WAITING_REMOTE_CONTEXT to OutboxReasons.DATE_UNCONFIRMED
            else -> OperationState.READY to null
        }
        return PlanOutcome.Seal(
            SealPlan(
                wire = wire,
                hash = OutboxCanonical.marksHash(wire),
                state = state,
                reason = reason,
                provenance = provenance,
                dependsOnId = dependency?.id,
                supersede = supersede,
                serverDayId = dayId,
                expectedRevision = revision,
                openState = openState,
                openReason = openReason,
            ),
        )
    }
}

// ----------------------------------------------------------------------------------------------------------- UI / resultados

data class OperationInfo(
    val id: String,
    val kind: OperationKind,
    val state: OperationState,
    val reason: String?,
    val markCount: Int,
)

/** Estado de la preparacion de un borrador (solo perfiles SANDBOX). No dice nada del servidor: nada se ha enviado. */
data class OutboxSummary(
    val draftId: String,
    val schoolDate: LocalDate,
    val localMarks: Int,
    /** Hay marcas locales que ninguna operacion sellada refleja todavia. */
    val unsealedChanges: Boolean,
    val operations: List<OperationInfo>,
) {
    val preparedOperations: Int get() = operations.count { it.kind == OperationKind.SAVE_MARKS && !it.state.isTerminal }
    val needsReview: Boolean get() = operations.any { it.state == OperationState.NEEDS_REVIEW }
    val waitingContext: Boolean get() = operations.any { it.state == OperationState.WAITING_REMOTE_CONTEXT }
    val readyForFutureSend: Boolean get() = operations.any { it.kind == OperationKind.SAVE_MARKS && it.state == OperationState.READY }
}

sealed interface PrepareResult {
    data class Prepared(
        val operationId: String,
        val requestId: String,
        val state: OperationState,
        val reason: String?,
        val markCount: Int,
    ) : PrepareResult

    /** Ya estaba preparado y no hay cambios nuevos: no se crea otra operacion ni otro requestId. */
    data class AlreadyPrepared(val operationId: String) : PrepareResult

    data class Refused(val refusal: Refusal) : PrepareResult
    data class AccessBlocked(val reason: AccessBlock) : PrepareResult
    data object DraftNotFound : PrepareResult

    /** Fallo local de persistencia: no se creo nada y el borrador no se toco. */
    data object LocalError : PrepareResult
}
