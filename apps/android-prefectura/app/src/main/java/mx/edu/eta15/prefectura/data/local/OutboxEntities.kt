package mx.edu.eta15.prefectura.data.local

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

/*
 * Esquema Room v3: OUTBOX de asistencia (ver domain/Outbox.kt para el modelo y la diferencia entre intencion, operacion sellada y
 * recibo). Solo perfiles SANDBOX. Nada de esto se transmite todavia.
 *
 * La base impone (disparadores en EtaDatabase, ademas del codigo): perfil SANDBOX y `profileId = sbx.<deviceId>`; el borrador, el
 * grupo y la fecha coinciden; el payload (solo alumnos del padron del borrador, minuscula, present/absent) solo se inserta antes de
 * sellar y despues es inmutable; la identidad sellada no cambia; la maquina de estados; ninguna operacion se borra (salvo una
 * intencion sin sellar o el borrado explicito de todo el perfil); a lo mas una operacion READY o SENDING por grupo y fecha, y READY
 * exige que la operacion de la que depende ya este confirmada.
 */

@Entity(
    tableName = "sync_operations",
    foreignKeys = [
        ForeignKey(
            entity = GroupEntity::class,
            parentColumns = ["id", "profileId"],
            childColumns = ["groupId", "profileId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = DraftEntity::class,
            parentColumns = ["id", "groupId"],
            childColumns = ["draftId", "groupId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = SyncOperationEntity::class,
            parentColumns = ["id"],
            childColumns = ["dependsOnOperationId"],
            onDelete = ForeignKey.SET_NULL,
        ),
        ForeignKey(
            entity = SyncOperationEntity::class,
            parentColumns = ["id"],
            childColumns = ["supersededByOperationId"],
            onDelete = ForeignKey.SET_NULL,
        ),
    ],
    indices = [
        Index(value = ["requestId"], unique = true),
        Index(value = ["profileId", "groupId", "schoolDate", "seq"], unique = true),
        Index(value = ["profileId", "state"]),
        Index(value = ["draftId", "groupId"]),
        Index(value = ["groupId", "profileId"]),
        Index(value = ["dependsOnOperationId"]),
        Index(value = ["supersededByOperationId"]),
    ],
)
data class SyncOperationEntity(
    /** Identificador LOCAL de la operacion (no es el requestId del servidor). */
    @PrimaryKey val id: String,
    val profileId: String,
    /** Dispositivo del servidor al que pertenece el perfil (`profileId = sbx.<deviceId>`). */
    val deviceId: String,
    val groupId: String,
    /** Grupo del servidor (el que viajaria en el cuerpo). Coincide con `school_groups.remoteId`. */
    val remoteGroupId: String,
    val schoolDate: String,
    val draftId: String,
    /** OPEN o SAVE_MARKS. */
    val kind: String,
    /** Orden local por perfil + grupo + fecha. */
    val seq: Int,
    val state: String,
    val reasonCode: String? = null,
    val dependsOnOperationId: String? = null,
    val supersededByOperationId: String? = null,
    // ---- identidad SELLADA (inmutable una vez fijada) ----
    /** requestId de la operacion de asistencia (UUID en minuscula). NULL en OPEN y en intenciones sin sellar. */
    val requestId: String? = null,
    /** Huella canonica del payload (identica a `marksHash` del servidor). */
    val contentHash: String? = null,
    val markCount: Int? = null,
    val sealedAtEpochMs: Long? = null,
    val schemaVersion: Int? = null,
    /** Huella del padron del borrador al sellar (referencia historica; el padron cambiado se marca NEEDS_REVIEW). */
    val rosterDigestAtSeal: String? = null,
    /** SERVER_CONFIRMED o DEVICE_UNCONFIRMED: certeza de la fecha al sellar. */
    val dateProvenance: String? = null,
    // ---- contexto remoto (se completa con la lista del servidor; NO forma parte de la identidad) ----
    val serverDayId: String? = null,
    val expectedRevision: Int? = null,
    // ---- ciclo de vida ----
    @ColumnInfo(defaultValue = "0") val attempts: Int = 0,
    val lastAttemptAtEpochMs: Long? = null,
    val nextAttemptAtEpochMs: Long? = null,
    val lastHttpStatus: Int? = null,
    /** Codigo estable del servidor (nunca un mensaje con datos). */
    val lastServerCode: String? = null,
    // ---- recibo del servidor (reservado para la fase de transporte) ----
    val ackRevision: Int? = null,
    val ackedAtEpochMs: Long? = null,
    val ackChanged: Int? = null,
    val ackReplayed: Int? = null,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
)

/** Payload logico de una operacion sellada: una fila por alumno con marca explicita (los Pendientes no se guardan: no son una orden). */
@Entity(
    tableName = "sync_operation_marks",
    primaryKeys = ["operationId", "studentRemoteId"],
    foreignKeys = [
        ForeignKey(
            entity = SyncOperationEntity::class,
            parentColumns = ["id"],
            childColumns = ["operationId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
)
data class SyncOperationMarkEntity(
    val operationId: String,
    /** Identificador del alumno en el servidor, en minuscula. */
    val studentRemoteId: String,
    /** `present` o `absent`, tal como viaja al servidor. */
    val status: String,
)

data class RemoteMarkRow(val studentRemoteId: String, val status: String)

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOperation(op: SyncOperationEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertMarks(marks: List<SyncOperationMarkEntity>)

    @Query("SELECT * FROM sync_operations WHERE id = :id AND profileId = :profileId")
    suspend fun find(profileId: String, id: String): SyncOperationEntity?

    @Query(
        "SELECT * FROM sync_operations WHERE profileId = :profileId AND groupId = :groupId AND schoolDate = :date ORDER BY seq",
    )
    suspend fun operationsOf(profileId: String, groupId: String, date: String): List<SyncOperationEntity>

    @Query(
        "SELECT * FROM sync_operations WHERE profileId = :profileId AND groupId = :groupId AND schoolDate = :date ORDER BY seq",
    )
    fun observeOperations(profileId: String, groupId: String, date: String): Flow<List<SyncOperationEntity>>

    @Query("SELECT * FROM sync_operations WHERE profileId = :profileId ORDER BY groupId, schoolDate, seq")
    suspend fun allOf(profileId: String): List<SyncOperationEntity>

    @Query("SELECT studentRemoteId, status FROM sync_operation_marks WHERE operationId = :operationId ORDER BY studentRemoteId")
    suspend fun payloadOf(operationId: String): List<RemoteMarkRow>

    @Query("SELECT COALESCE(MAX(seq), 0) FROM sync_operations WHERE profileId = :profileId AND groupId = :groupId AND schoolDate = :date")
    suspend fun maxSeq(profileId: String, groupId: String, date: String): Int

    /** Marcas EXPLICITAS del borrador con el identificador del alumno en el servidor (los Pendientes no aparecen). */
    @Query(
        """
        SELECT s.remoteId AS studentRemoteId, lower(m.status) AS status
          FROM attendance_marks m JOIN students s ON s.id = m.studentId
         WHERE m.draftId = :draftId AND m.status IS NOT NULL AND s.remoteId IS NOT NULL
        """,
    )
    suspend fun explicitMarks(draftId: String): List<RemoteMarkRow>

    @Query(
        """
        SELECT s.remoteId AS studentRemoteId, s.active AS active, m.status AS status
          FROM attendance_marks m JOIN students s ON s.id = m.studentId
         WHERE m.draftId = :draftId AND m.status IS NOT NULL
        """,
    )
    suspend fun explicitMarksWithActivity(draftId: String): List<ExplicitMarkRow>

    @Query("SELECT * FROM sync_operations WHERE draftId = :draftId AND kind = 'SAVE_MARKS' AND state = 'LOCAL_ONLY' LIMIT 1")
    suspend fun intentOf(draftId: String): SyncOperationEntity?

    @Query("DELETE FROM sync_operations WHERE id = :id AND state = 'LOCAL_ONLY'")
    suspend fun deleteIntent(id: String): Int

    @Query("UPDATE sync_operations SET state = :state, reasonCode = :reason, updatedAtEpochMs = :now WHERE id = :id")
    suspend fun setState(id: String, state: String, reason: String?, now: Long): Int

    @Query(
        "UPDATE sync_operations SET state = 'SUPERSEDED', reasonCode = NULL, supersededByOperationId = :by, updatedAtEpochMs = :now WHERE id = :id",
    )
    suspend fun supersede(id: String, by: String, now: Long): Int

    @Query(
        """
        UPDATE sync_operations
           SET requestId = :requestId, contentHash = :hash, markCount = :count, sealedAtEpochMs = :now, schemaVersion = :schema,
               rosterDigestAtSeal = :digest, dateProvenance = :provenance, dependsOnOperationId = :dependsOn,
               serverDayId = :dayId, expectedRevision = :revision, updatedAtEpochMs = :now
         WHERE id = :id AND state = 'LOCAL_ONLY' AND requestId IS NULL
        """,
    )
    suspend fun seal(
        id: String,
        requestId: String,
        hash: String,
        count: Int,
        schema: Int,
        digest: String?,
        provenance: String,
        dependsOn: String?,
        dayId: String?,
        revision: Int?,
        now: Long,
    ): Int

    @Query(
        """
        UPDATE sync_operations
           SET state = 'SENDING', attempts = attempts + 1, lastAttemptAtEpochMs = :now, reasonCode = NULL, updatedAtEpochMs = :now
         WHERE id = :id
        """,
    )
    suspend fun markSending(id: String, now: Long): Int

    @Query(
        """
        UPDATE sync_operations
           SET state = 'READY', reasonCode = NULL, serverDayId = :dayId, expectedRevision = :revision, updatedAtEpochMs = :now
         WHERE id = :id
        """,
    )
    suspend fun markReadyWithContext(id: String, dayId: String?, revision: Int?, now: Long): Int

    @Query(
        """
        UPDATE sync_operations
           SET state = 'ACKNOWLEDGED', reasonCode = NULL, serverDayId = COALESCE(:dayId, serverDayId), ackRevision = :revision,
               ackedAtEpochMs = :now, ackChanged = :changed, ackReplayed = :replayed, updatedAtEpochMs = :now
         WHERE id = :id
        """,
    )
    suspend fun markAcknowledged(id: String, dayId: String?, revision: Int, changed: Int, replayed: Int, now: Long): Int

    @Query(
        """
        UPDATE sync_operations
           SET state = :state, reasonCode = :reason, lastHttpStatus = :httpStatus, lastServerCode = :serverCode, updatedAtEpochMs = :now
         WHERE id = :id
        """,
    )
    suspend fun markFailed(id: String, state: String, reason: String?, httpStatus: Int?, serverCode: String?, now: Long): Int

    /** Un SENDING persistido tras un reinicio es un resultado DESCONOCIDO, nunca un exito. */
    @Query(
        """
        UPDATE sync_operations SET state = 'RETRYABLE_ERROR', reasonCode = 'RESULT_UNKNOWN_AFTER_RESTART', updatedAtEpochMs = :now
         WHERE state = 'SENDING'
        """,
    )
    suspend fun recoverSending(now: Long): Int

    @Query(
        """
        UPDATE sync_operations SET state = 'NEEDS_REVIEW', reasonCode = :reason, updatedAtEpochMs = :now
         WHERE profileId = :profileId AND groupId = :groupId AND state IN ('WAITING_REMOTE_CONTEXT', 'READY')
        """,
    )
    suspend fun reviewUnsentOfGroup(profileId: String, groupId: String, reason: String, now: Long): Int

    @Query(
        """
        UPDATE sync_operations SET state = 'NEEDS_REVIEW', reasonCode = :reason, updatedAtEpochMs = :now
         WHERE profileId = :profileId AND groupId = :groupId AND state IN ('WAITING_REMOTE_CONTEXT', 'READY')
           AND draftId IN (SELECT id FROM attendance_drafts WHERE profileId = :profileId AND groupId = :groupId AND needsReview = 1)
        """,
    )
    suspend fun reviewUnsentOfFlaggedDrafts(profileId: String, groupId: String, reason: String, now: Long): Int

    @Query(
        """
        UPDATE sync_operations SET state = 'AUTH_REQUIRED', reasonCode = :reason, updatedAtEpochMs = :now
         WHERE profileId = :profileId AND state = 'READY'
        """,
    )
    suspend fun requireAuthForReady(profileId: String, reason: String, now: Long): Int

    @Query("SELECT remoteId FROM school_groups WHERE id = :groupId AND profileId = :profileId")
    suspend fun remoteGroupIdOf(profileId: String, groupId: String): String?

    @Query("SELECT remoteId FROM students WHERE id = :studentId")
    suspend fun remoteStudentId(studentId: String): String?

    @Query("SELECT COUNT(*) FROM sync_operations WHERE profileId = :profileId")
    suspend fun count(profileId: String): Int

    /** Alumnos (identificador del servidor) con marca en operaciones CONFIRMADAS por el servidor: ya no pueden quedar Pendientes. */
    @Query(
        """
        SELECT DISTINCT p.studentRemoteId FROM sync_operation_marks p JOIN sync_operations o ON o.id = p.operationId
         WHERE o.draftId = :draftId AND o.state = 'ACKNOWLEDGED'
        """,
    )
    suspend fun acknowledgedStudents(draftId: String): List<String>
}

data class ExplicitMarkRow(val studentRemoteId: String?, val active: Int, val status: String)
