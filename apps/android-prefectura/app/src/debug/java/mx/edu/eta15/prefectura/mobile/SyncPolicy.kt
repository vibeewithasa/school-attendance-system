package mx.edu.eta15.prefectura.mobile

import java.security.MessageDigest
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxReasons
import mx.edu.eta15.prefectura.domain.WireMark

/**
 * SOLO debug. Una operacion de la outbox tal como la ve el motor del ciclo manual (sin entidades de Room: el motor se prueba en la
 * JVM con un almacen falso). `requestId`, el payload y el hash son los SELLADOS al preparar y no cambian nunca; `serverDayId` y
 * `expectedRevision` son el contexto remoto, que se completa justo antes de enviar y no es parte de la identidad.
 */
data class SyncOp(
    val id: String,
    val kind: OperationKind,
    val state: OperationState,
    val seq: Int,
    val groupId: String,
    val remoteGroupId: String,
    val draftId: String,
    val schoolDate: String,
    val requestId: String?,
    val serverDayId: String?,
    val expectedRevision: Int?,
    val dependsOnId: String?,
    val ackRevision: Int?,
    val markCount: Int,
    val attempts: Int,
)

/** Lo que el motor decide ANTES de enviar con lo que el servidor dice ahora. La autoridad es siempre el servidor. */
sealed interface Verdict {
    data object Proceed : Verdict

    /** Algo exige a una persona: el envio queda bloqueado (NEEDS_REVIEW) y no se limpia solo. */
    data class Review(val reason: String) : Verdict

    /** La lista del servidor cambio o esta finalizada: CONFLICT; no se resuelve solo y no se sobrescribe nada. */
    data class Conflict(val reason: String) : Verdict
}

/** Que hacer ante un fallo HTTP. Los codigos son los del backend real; ningun mensaje del servidor se interpreta. */
sealed interface Reaction {
    /** Reintento temporal ACOTADO (mismo `requestId`, `jti` nuevo). */
    data class Retry(val delayMs: Long, val reason: String) : Reaction

    /** Sin respuesta (red, tiempo agotado) o respuesta ilegible: si era una escritura el resultado es DESCONOCIDO. */
    data object Unknown : Reaction

    /** La sesion no sirve: hay que volver a autenticar. No se repite en bucle. */
    data object Auth : Reaction

    /** El servidor informo dispositivo revocado o cuenta no elegible: se bloquea el perfil y se conserva todo. */
    data class AuthBlocked(val code: String) : Reaction

    data class Review(val reason: String) : Reaction

    data class Conflict(val reason: String) : Reaction
}

object SyncPolicy {
    const val MAX_RETRIES = 2
    private const val DEFAULT_RETRY_MS = 1_000L
    private const val MAX_RETRY_MS = 10_000L

    /** Huella v1 del padron: `v1:` + SHA-256 hex de los ids en minuscula, ordenados por cadena y unidos con salto de linea. */
    fun rosterDigestV1(studentIds: Collection<String>): String {
        val canonical = studentIds.map { it.lowercase() }.sorted().joinToString("\n")
        val hex = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        return "v1:$hex"
    }

    /**
     * Validacion previa al envio de una operacion NUEVA (nunca de un reintento de una ya enviada: esa la reconoce el servidor por su
     * `requestId`). `knownRevision` es la revision que ESTE dispositivo confirmo por ultima vez (recibo de OPEN o de la operacion
     * anterior); `ackedStudents`, los alumnos que este dispositivo ya escribio en esa lista.
     */
    fun validateBeforeSend(
        op: SyncOp,
        payload: List<WireMark>,
        detail: SrvDetail,
        serverToday: String,
        localRoster: Set<String>,
        ackedStudents: Set<String>,
        knownRevision: Int?,
    ): Verdict {
        val day = detail.day
        if (day.groupId != op.remoteGroupId) return Verdict.Review(OutboxReasons.INVALID_REQUEST)
        if (day.attendanceDate != serverToday || op.schoolDate != serverToday) return Verdict.Review(OutboxReasons.DATE_MISMATCH)
        if (day.isFinalized) return Verdict.Conflict(OutboxReasons.DAY_FINALIZED)
        val serverIds = detail.records.map { it.studentId }.toSet()
        if (serverIds != localRoster || detail.rosterDigest != rosterDigestV1(localRoster) || payload.any { it.studentId !in serverIds }) {
            return Verdict.Review(OutboxReasons.ROSTER_CHANGED)
        }
        if (knownRevision != null && day.revision != knownRevision) return Verdict.Conflict(OutboxReasons.REVISION_CHANGED)
        val byStudent = detail.records.associate { it.studentId to it.status }
        // Una marca de OTRA persona en un alumno que este dispositivo nunca escribio no se sobrescribe (nada de "ultimo gana").
        val divergent = payload.any { p ->
            val remote = byStudent[p.studentId]
            remote != null && remote != "pending" && remote != p.status && p.studentId !in ackedStudents
        }
        if (divergent) return Verdict.Conflict(OutboxReasons.DIVERGENT_MARKS)
        return Verdict.Proceed
    }

    /**
     * El recibo corresponde a LO ENVIADO? `null` = si. Se comprueba la lista (id, grupo y fecha), la revision y, si fue una aplicacion
     * nueva, que cada marca enviada quedo con ese estado. Una repeticion (`replayed`) ya fue verificada por el servidor con el
     * `requestId` y la huella de la operacion; otras personas pudieron cambiar la lista despues, asi que no se exige igualdad de marcas.
     */
    fun verifyReceipt(op: SyncOp, payload: List<WireMark>, response: SrvSave): String? {
        val day = response.detail.day
        if (day.id != op.serverDayId || day.groupId != op.remoteGroupId || day.attendanceDate != op.schoolDate) return OutboxReasons.ACK_MISMATCH
        if (response.changed !in 0..payload.size) return OutboxReasons.ACK_MISMATCH
        val expected = op.expectedRevision ?: return OutboxReasons.ACK_MISMATCH
        if (day.revision < (if (response.replayed) 1 else expected)) return OutboxReasons.ACK_MISMATCH
        if (!response.replayed) {
            val byStudent = response.detail.records.associate { it.studentId to it.status }
            if (payload.any { byStudent[it.studentId] != it.status }) return OutboxReasons.ACK_MISMATCH
        }
        return null
    }

    /** Tratamiento explicito de cada fallo (ver docs del protocolo §22). No todo error es un reintento. */
    fun classify(f: ApiResult.Failure, attempt: Int = 0): Reaction = when {
        f.isNetwork -> Reaction.Unknown
        f.code == "BAD_RESPONSE" -> Reaction.Unknown
        f.status == 401 -> Reaction.Auth
        f.status == 403 ->
            if (f.code == "DEVICE_REVOKED" || f.code == "NOT_ELIGIBLE") Reaction.AuthBlocked(f.code) else Reaction.Review(OutboxReasons.FORBIDDEN)
        f.status == 404 -> Reaction.Review(OutboxReasons.NOT_FOUND)
        f.status == 400 -> Reaction.Review(
            when (f.code) {
                "DATE_NOT_TODAY" -> OutboxReasons.DATE_MISMATCH
                "STUDENT_NOT_IN_LIST" -> OutboxReasons.ROSTER_CHANGED
                else -> OutboxReasons.INVALID_REQUEST
            },
        )
        f.status == 409 -> when (f.code) {
            "REVISION_CONFLICT" -> Reaction.Conflict(OutboxReasons.REVISION_CHANGED)
            "DAY_FINALIZED" -> Reaction.Conflict(OutboxReasons.DAY_FINALIZED)
            "IDEMPOTENCY_MISMATCH" -> Reaction.Review(OutboxReasons.IDEMPOTENCY_MISMATCH)
            "NOT_SCHOOL_DAY" -> Reaction.Review(OutboxReasons.NOT_SCHOOL_DAY)
            "DAY_NOT_CURRENT" -> Reaction.Review(OutboxReasons.DATE_MISMATCH)
            "GROUP_INACTIVE", "OUT_OF_YEAR", "EMPTY_ROSTER" -> Reaction.Review(OutboxReasons.GROUP_NOT_ASSIGNED)
            "ROSTER_CHANGED" -> Reaction.Review(OutboxReasons.ROSTER_CHANGED)
            "CONCURRENT" -> Reaction.Retry(backoff(attempt), OutboxReasons.UNAVAILABLE)
            else -> Reaction.Review(OutboxReasons.INVALID_REQUEST)
        }
        f.status == 429 -> Reaction.Retry(
            ((f.retryAfterSeconds?.toLong()?.times(1_000)) ?: backoff(attempt)).coerceIn(DEFAULT_RETRY_MS, MAX_RETRY_MS),
            OutboxReasons.RATE_LIMITED,
        )
        f.status >= 500 -> Reaction.Retry(backoff(attempt), OutboxReasons.UNAVAILABLE)
        else -> Reaction.Review(OutboxReasons.INVALID_REQUEST)
    }

    private fun backoff(attempt: Int): Long = (DEFAULT_RETRY_MS shl attempt.coerceIn(0, 3)).coerceAtMost(MAX_RETRY_MS)
}
