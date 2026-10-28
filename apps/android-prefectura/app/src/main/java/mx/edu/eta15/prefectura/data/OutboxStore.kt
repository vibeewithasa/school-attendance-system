package mx.edu.eta15.prefectura.data

import androidx.room.withTransaction
import java.time.Clock
import java.time.LocalDate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import mx.edu.eta15.prefectura.data.local.DraftEntity
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.local.SyncOperationEntity
import mx.edu.eta15.prefectura.data.local.SyncOperationMarkEntity
import mx.edu.eta15.prefectura.domain.DateProvenance
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OperationInfo
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxCanonical
import mx.edu.eta15.prefectura.domain.OutboxPlanner
import mx.edu.eta15.prefectura.domain.OutboxReasons
import mx.edu.eta15.prefectura.domain.OutboxSummary
import mx.edu.eta15.prefectura.domain.PlanMark
import mx.edu.eta15.prefectura.domain.PlanOutcome
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.PriorOperation
import mx.edu.eta15.prefectura.domain.Refusal
import mx.edu.eta15.prefectura.domain.SealInput
import mx.edu.eta15.prefectura.domain.WireMark

/**
 * OUTBOX local (esquema Room v3). SANDBOX ONLY. PREPARA operaciones; NO las transmite: esta clase no usa red y ningun codigo de
 * produccion llama a las transiciones de la seccion "transporte futuro" (lo verifica una prueba estatica); solo las pruebas.
 *
 * Todo cambio es una transaccion de Room (todo o nada). Aislamiento: cada metodo recibe el `profileId` y toda consulta lo filtra;
 * ademas la base impone (disparadores) que una operacion pertenece a un perfil SANDBOX, a su dispositivo, a su borrador y a su grupo.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OutboxStore(
    private val db: EtaDatabase,
    private val clock: Clock,
    private val ids: IdGenerator = IdGenerator.Random,
) {
    private val outbox = db.outboxDao()
    private val drafts = db.draftDao()
    private val catalog = db.catalogDao()
    private val cache = db.cacheDao()

    // ------------------------------------------------------------------------------------------------------ intencion

    /**
     * Mantiene la INTENCION del borrador: si las marcas locales difieren de lo ya sellado hay una operacion LOCAL_ONLY; si ya no,
     * se retira (es desechable: no tiene identidad de red). Debe llamarse DENTRO de la misma transaccion que cambia la marca.
     */
    suspend fun refreshIntent(profileId: String, draft: DraftEntity) {
        val sync = cache.syncOf(profileId) ?: return // solo perfiles descargados del servidor de pruebas
        val remoteGroupId = outbox.remoteGroupIdOf(profileId, draft.groupId) ?: return
        val local = outbox.explicitMarks(draft.id).associate { it.studentRemoteId to it.status }
        val prior = priorOperations(profileId, draft.groupId, draft.schoolDate)
        val dirty = OutboxPlanner.isDirty(local, OutboxPlanner.latestActiveSealed(prior)?.marks)
        val intent = outbox.intentOf(draft.id)
        when {
            dirty && intent == null -> insertIntent(profileId, sync.deviceId, remoteGroupId, draft)
            !dirty && intent != null -> outbox.deleteIntent(intent.id)
        }
    }

    private suspend fun insertIntent(profileId: String, deviceId: String, remoteGroupId: String, draft: DraftEntity): String {
        val now = clock.millis()
        val id = ids.newId()
        outbox.insertOperation(
            SyncOperationEntity(
                id = id, profileId = profileId, deviceId = deviceId, groupId = draft.groupId, remoteGroupId = remoteGroupId,
                schoolDate = draft.schoolDate, draftId = draft.id, kind = OperationKind.SAVE_MARKS.name,
                seq = outbox.maxSeq(profileId, draft.groupId, draft.schoolDate) + 1, state = OperationState.LOCAL_ONLY.name,
                createdAtEpochMs = now, updatedAtEpochMs = now,
            ),
        )
        return id
    }

    /** Alumnos (identificador del servidor) con marca ya CONFIRMADA por el servidor: no pueden volver a Pendiente. */
    suspend fun isAcknowledgedStudent(draftId: String, localStudentId: String): Boolean {
        val remote = outbox.remoteStudentId(localStudentId) ?: return false
        return remote in outbox.acknowledgedStudents(draftId)
    }

    // ------------------------------------------------------------------------------------------------------- preparar

    /**
     * Sella la intencion en una operacion completa. TODO o NADA: si algo falla, no queda ni payload parcial ni operacion a medias y el
     * borrador no se toca. No transmite nada.
     *
     * - `today` y `dateConfirmed` los decide el llamador (reloj escolar y ultima fecha confirmada por el servidor): el reloj del
     *   telefono por si solo NO es autoridad.
     * - Un borrador de otra fecha, con padron cambiado o con alumnos inactivos se sella pero queda en NEEDS_REVIEW (se conserva).
     * - Sin contexto remoto (lista del servidor, revision esperada) queda en WAITING_REMOTE_CONTEXT: nunca READY con datos inventados.
     */
    suspend fun prepare(profileId: String, draftId: String, today: LocalDate, dateConfirmed: Boolean): PrepareResult =
        try {
            db.withTransaction { prepareInTransaction(profileId, draftId, today, dateConfirmed) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            PrepareResult.LocalError
        }

    private suspend fun prepareInTransaction(profileId: String, draftId: String, today: LocalDate, dateConfirmed: Boolean): PrepareResult {
        val draft = drafts.findDraft(profileId, draftId) ?: return PrepareResult.DraftNotFound
        val sync = cache.syncOf(profileId)
        val remoteGroupId = outbox.remoteGroupIdOf(profileId, draft.groupId)
        val rows = outbox.explicitMarksWithActivity(draft.id)
        val prior = priorOperations(profileId, draft.groupId, draft.schoolDate)
        val outcome = OutboxPlanner.plan(
            SealInput(
                profileIsSandbox = sync != null && remoteGroupId != null,
                groupRevoked = catalog.groupAuthState(profileId, draft.groupId) != "ACTIVE",
                draftDate = LocalDate.parse(draft.schoolDate),
                today = today,
                dateConfirmed = dateConfirmed,
                draftNeedsReview = draft.needsReview > 0,
                draftReviewReason = draft.reviewReason,
                marks = rows.map { PlanMark(it.studentRemoteId.orEmpty(), markOf(it.status), it.active > 0) },
                priorOperations = prior,
            ),
        )
        when (outcome) {
            is PlanOutcome.Refuse -> return PrepareResult.Refused(outcome.refusal)
            is PlanOutcome.AlreadyPrepared -> {
                outbox.intentOf(draft.id)?.let { outbox.deleteIntent(it.id) }
                return PrepareResult.AlreadyPrepared(outcome.operationId)
            }
            is PlanOutcome.Seal -> Unit
        }
        val plan = (outcome as PlanOutcome.Seal).plan
        val now = clock.millis()
        val deviceId = sync!!.deviceId
        val intentId = outbox.intentOf(draft.id)?.id ?: insertIntent(profileId, deviceId, remoteGroupId!!, draft)

        // Payload logico: solo marcas explicitas (los Pendientes no son una orden), identificadores en minuscula.
        outbox.insertMarks(plan.wire.map { SyncOperationMarkEntity(intentId, it.studentId, it.status) })

        // La operacion OPEN del grupo y fecha (una sola): se identifica localmente por grupo y fecha; no tiene requestId.
        val open = prior.firstOrNull { it.kind == OperationKind.OPEN }?.id ?: run {
            val id = ids.newId()
            outbox.insertOperation(
                SyncOperationEntity(
                    id = id, profileId = profileId, deviceId = deviceId, groupId = draft.groupId, remoteGroupId = remoteGroupId!!,
                    schoolDate = draft.schoolDate, draftId = draft.id, kind = OperationKind.OPEN.name,
                    seq = outbox.maxSeq(profileId, draft.groupId, draft.schoolDate) + 1, state = plan.openState.name,
                    reasonCode = plan.openReason, sealedAtEpochMs = now, schemaVersion = OutboxCanonical.SCHEMA_VERSION,
                    rosterDigestAtSeal = draft.rosterDigest, dateProvenance = plan.provenance.name,
                    createdAtEpochMs = now, updatedAtEpochMs = now,
                ),
            )
            id
        }

        // Las operaciones sin enviar de este borrador quedan reemplazadas (se CONSERVAN como SUPERSEDED; nunca se borran).
        plan.supersede.forEach { outbox.supersede(it, intentId, now) }

        val requestId = ids.newId().lowercase()
        val sealed = outbox.seal(
            id = intentId, requestId = requestId, hash = plan.hash, count = plan.wire.size, schema = OutboxCanonical.SCHEMA_VERSION,
            digest = draft.rosterDigest, provenance = plan.provenance.name, dependsOn = plan.dependsOnId ?: open,
            dayId = plan.serverDayId, revision = plan.expectedRevision, now = now,
        )
        check(sealed == 1) { "no se pudo sellar la intencion" }
        outbox.setState(intentId, plan.state.name, plan.reason, now)
        return PrepareResult.Prepared(intentId, requestId, plan.state, plan.reason, plan.wire.size)
    }

    private fun markOf(status: String) =
        WireMark.markOf(status.lowercase()) ?: error("estado de marca local desconocido")

    private suspend fun priorOperations(profileId: String, groupId: String, date: String): List<PriorOperation> =
        outbox.operationsOf(profileId, groupId, date).map { op ->
            PriorOperation(
                id = op.id,
                kind = OperationKind.valueOf(op.kind),
                state = OperationState.valueOf(op.state),
                seq = op.seq,
                marks = if (op.kind == OperationKind.SAVE_MARKS.name && op.sealedAtEpochMs != null) {
                    outbox.payloadOf(op.id).associate { it.studentRemoteId to it.status }
                } else {
                    null
                },
                serverDayId = op.serverDayId,
                ackRevision = op.ackRevision,
            )
        }

    // ---------------------------------------------------------------------------------------------------------- lectura

    /** Resumen de la preparacion del borrador de `date` (solo perfiles SANDBOX; `null` si no hay borrador o no hay outbox). */
    fun observeSummary(profileId: String, groupId: String, today: Flow<LocalDate>): Flow<OutboxSummary?> =
        today.flatMapLatest { date ->
            drafts.observeDraft(profileId, groupId, date.toString()).flatMapLatest { draft ->
                if (draft == null) {
                    flowOf(null)
                } else {
                    combine(outbox.observeOperations(profileId, groupId, date.toString()), drafts.observeRows(draft.id)) { ops, _ ->
                        summaryOf(profileId, draft, ops)
                    }
                }
            }
        }

    private suspend fun summaryOf(profileId: String, draft: DraftEntity, ops: List<SyncOperationEntity>): OutboxSummary? {
        if (cache.syncOf(profileId) == null) return null
        val local = outbox.explicitMarks(draft.id).associate { it.studentRemoteId to it.status }
        val prior = priorOperations(profileId, draft.groupId, draft.schoolDate)
        return OutboxSummary(
            draftId = draft.id,
            schoolDate = LocalDate.parse(draft.schoolDate),
            localMarks = local.size,
            unsealedChanges = OutboxPlanner.isDirty(local, OutboxPlanner.latestActiveSealed(prior)?.marks),
            operations = ops.filter { it.state != OperationState.LOCAL_ONLY.name }.map {
                OperationInfo(it.id, OperationKind.valueOf(it.kind), OperationState.valueOf(it.state), it.reasonCode, it.markCount ?: 0)
            },
        )
    }

    suspend fun operationsOf(profileId: String, groupId: String, date: String): List<SyncOperationEntity> =
        outbox.operationsOf(profileId, groupId, date)

    /** Operaciones no terminales del grupo (cualquier fecha). */
    suspend fun activeOperations(profileId: String, groupId: String): List<SyncOperationEntity> = outbox.activeOf(profileId, groupId)

    suspend fun operation(profileId: String, id: String): SyncOperationEntity? = outbox.find(profileId, id)

    /** Padron congelado del borrador (identificadores del servidor, en minuscula). */
    suspend fun localRoster(draftId: String): Set<String> = outbox.rosterRemoteIds(draftId).map { it.lowercase() }.toSet()

    /** Alumnos con marca ya CONFIRMADA por el servidor para este borrador. */
    suspend fun acknowledgedStudentIds(draftId: String): Set<String> = outbox.acknowledgedStudents(draftId).map { it.lowercase() }.toSet()

    suspend fun draftIdFor(profileId: String, groupId: String, date: String): String? = drafts.findDraftId(profileId, groupId, date)

    suspend fun payloadOf(operationId: String): List<WireMark> =
        outbox.payloadOf(operationId).map { WireMark(it.studentRemoteId, it.status) }

    // ------------------------------------------------------------------------------------------------------ recuperacion

    /**
     * Al abrir la base: una operacion que quedo SENDING (el proceso murio) tiene resultado DESCONOCIDO. Pasa a RETRYABLE_ERROR; jamas
     * se toma como confirmada. Con el contrato idempotente (mismo requestId) reenviarla sera seguro en la fase de transporte.
     */
    suspend fun recoverAfterRestart(): Int = outbox.recoverSending(clock.millis())

    // ----------------------------------------------------------------------------------- cambios de autorizacion del perfil

    /** El grupo dejo de estar autorizado: lo que no se envio queda para revision. Los borradores y las operaciones se conservan. */
    suspend fun reviewGroupRevoked(profileId: String, groupId: String): Int =
        outbox.reviewUnsentOfGroup(profileId, groupId, OutboxReasons.GROUP_REVOKED, clock.millis())

    /** El padron cambio: lo que no se envio de los borradores marcados queda para revision. Las marcas no se tocan. */
    suspend fun reviewRosterChanged(profileId: String, groupId: String): Int =
        outbox.reviewUnsentOfFlaggedDrafts(profileId, groupId, OutboxReasons.ROSTER_CHANGED, clock.millis())

    /** El servidor informo que el dispositivo o la cuenta ya no pueden operar: lo que estaba listo exige volver a autenticarse. */
    suspend fun requireAuth(profileId: String, reason: String): Int = outbox.requireAuthForReady(profileId, reason, clock.millis())

    // ========================================================================================== TRANSPORTE FUTURO
    // Las siguientes transiciones representan lo que hara la fase de transporte. NINGUN codigo de produccion las invoca: en esta fase
    // solo existen en pruebas (simulacion controlada). Cada una pasa por la maquina de estados de la base.

    /** Completa el contexto remoto (lista del servidor y revision esperada) y deja la operacion READY. No cambia su identidad. */
    suspend fun resolveContext(operationId: String, serverDayId: String?, expectedRevision: Int?): Boolean =
        db.withTransaction { outbox.markReadyWithContext(operationId, serverDayId, expectedRevision, clock.millis()) == 1 }

    suspend fun beginSending(operationId: String): Boolean =
        db.withTransaction { outbox.markSending(operationId, clock.millis()) == 1 }

    suspend fun acknowledge(operationId: String, serverDayId: String?, revision: Int, changed: Int, replayed: Boolean): Boolean =
        db.withTransaction { outbox.markAcknowledged(operationId, serverDayId, revision, changed, if (replayed) 1 else 0, clock.millis()) == 1 }

    suspend fun fail(operationId: String, state: OperationState, reason: String?, httpStatus: Int? = null, serverCode: String? = null): Boolean =
        db.withTransaction { outbox.markFailed(operationId, state.name, reason, httpStatus, serverCode, clock.millis()) == 1 }

    /** Decision EXPLICITA de la persona (no hay politica aprobada ni interfaz que la invoque todavia). La fila se conserva. */
    suspend fun discard(operationId: String, confirmedByPerson: Boolean): Boolean {
        require(confirmedByPerson) { "descartar exige la confirmacion explicita de la persona" }
        return db.withTransaction { outbox.setState(operationId, OperationState.DISCARDED.name, null, clock.millis()) == 1 }
    }
}
