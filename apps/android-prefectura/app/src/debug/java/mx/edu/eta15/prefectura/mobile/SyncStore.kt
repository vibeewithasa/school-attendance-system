package mx.edu.eta15.prefectura.mobile

import java.time.LocalDate
import mx.edu.eta15.prefectura.data.OfflineSink
import mx.edu.eta15.prefectura.data.OutboxStore
import mx.edu.eta15.prefectura.data.local.SyncOperationEntity
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.WireMark

/**
 * SOLO debug. Puerto del motor del ciclo manual hacia la outbox. Toda transicion pasa por la maquina de estados de la base (los
 * disparadores la imponen aunque el motor se equivoque). `acknowledge` es UNA sola sentencia atomica de Room.
 */
interface SyncStore {
    /** Un SENDING que quedo a medias (proceso muerto o ciclo cancelado) tiene resultado DESCONOCIDO: pasa a RETRYABLE_ERROR. */
    suspend fun recoverUnknown(): Int

    /** Sella los cambios locales del borrador de hoy del grupo (accion local; no envia nada). `null` si no hay borrador. */
    suspend fun prepareDirty(groupId: String): PrepareResult?

    /** Operaciones no terminales del grupo (cualquier fecha), por fecha y secuencia. */
    suspend fun active(groupId: String): List<SyncOp>

    suspend fun operation(id: String): SyncOp?

    /** Payload SELLADO de la operacion: nunca se reconstruye desde el borrador (que puede haber cambiado despues). */
    suspend fun payload(opId: String): List<WireMark>

    /** Padron congelado del borrador (ids del servidor, en minuscula). */
    suspend fun localRoster(draftId: String): Set<String>

    /** Alumnos que este dispositivo ya escribio y el servidor confirmo en este borrador. */
    suspend fun ackedStudents(draftId: String): Set<String>

    /** Completa el contexto remoto y deja la operacion en READY (no toca requestId, payload ni huella). */
    suspend fun setContext(opId: String, serverDayId: String?, expectedRevision: Int?): Boolean

    /** READY / RETRYABLE_ERROR / AUTH_REQUIRED -> SENDING (cuenta el intento). Se persiste ANTES de la peticion. */
    suspend fun begin(opId: String): Boolean

    /** Recibo del servidor: operacion ACKNOWLEDGED con revision, cambios y repeticion, en una sola sentencia atomica. */
    suspend fun acknowledge(opId: String, serverDayId: String?, revision: Int, changed: Int, replayed: Boolean): Boolean

    suspend fun move(opId: String, to: OperationState, reason: String?, httpStatus: Int? = null, serverCode: String? = null): Boolean

    /** El servidor informo dispositivo revocado o cuenta no elegible: se bloquea el acceso offline del perfil (todo se conserva). */
    suspend fun blockProfile(authState: String)
}

/** Implementacion con Room: delega en [OutboxStore] (el mismo que usa la interfaz) y en el sumidero de la cache. */
class RoomSyncStore(
    private val store: OutboxStore,
    private val profileId: String,
    private val deviceId: String,
    private val cache: OfflineSink,
    private val schoolToday: () -> LocalDate,
    private val prepare: suspend (draftId: String) -> PrepareResult,
) : SyncStore {
    private fun SyncOperationEntity.toOp() = SyncOp(
        id = id,
        kind = OperationKind.valueOf(kind),
        state = OperationState.valueOf(state),
        seq = seq,
        groupId = groupId,
        remoteGroupId = remoteGroupId,
        draftId = draftId,
        schoolDate = schoolDate,
        requestId = requestId,
        serverDayId = serverDayId,
        expectedRevision = expectedRevision,
        dependsOnId = dependsOnOperationId,
        ackRevision = ackRevision,
        markCount = markCount ?: 0,
        attempts = attempts,
    )

    override suspend fun recoverUnknown(): Int = store.recoverAfterRestart()

    override suspend fun prepareDirty(groupId: String): PrepareResult? {
        val draftId = store.draftIdFor(profileId, groupId, schoolToday().toString()) ?: return null
        return prepare(draftId)
    }

    override suspend fun active(groupId: String): List<SyncOp> = store.activeOperations(profileId, groupId).map { it.toOp() }

    override suspend fun operation(id: String): SyncOp? = store.operation(profileId, id)?.toOp()

    override suspend fun payload(opId: String): List<WireMark> = store.payloadOf(opId)

    override suspend fun localRoster(draftId: String): Set<String> = store.localRoster(draftId)

    override suspend fun ackedStudents(draftId: String): Set<String> = store.acknowledgedStudentIds(draftId)

    override suspend fun setContext(opId: String, serverDayId: String?, expectedRevision: Int?): Boolean =
        store.resolveContext(opId, serverDayId, expectedRevision)

    override suspend fun begin(opId: String): Boolean = store.beginSending(opId)

    override suspend fun acknowledge(opId: String, serverDayId: String?, revision: Int, changed: Int, replayed: Boolean): Boolean =
        store.acknowledge(opId, serverDayId, revision, changed, replayed)

    override suspend fun move(opId: String, to: OperationState, reason: String?, httpStatus: Int?, serverCode: String?): Boolean =
        store.fail(opId, to, reason, httpStatus, serverCode)

    override suspend fun blockProfile(authState: String) {
        cache.markAuthState(deviceId, authState)
    }
}
