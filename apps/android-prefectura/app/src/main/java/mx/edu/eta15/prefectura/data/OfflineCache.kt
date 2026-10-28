package mx.edu.eta15.prefectura.data

import androidx.room.withTransaction
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import kotlin.math.max
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.local.GroupEntity
import mx.edu.eta15.prefectura.data.local.ProfileEntity
import mx.edu.eta15.prefectura.data.local.ProfileSyncEntity
import mx.edu.eta15.prefectura.data.local.RosterSnapshotEntity
import mx.edu.eta15.prefectura.data.local.StudentEntity
import mx.edu.eta15.prefectura.domain.AccessBlock
import mx.edu.eta15.prefectura.domain.AccessGate
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.SchoolCalendar

/*
 * CACHE OFFLINE del servidor de PRUEBAS (SANDBOX ONLY; la escuela no aprobo nada de esto).
 *
 * Identidad: un perfil SANDBOX pertenece a UN dispositivo del servidor (`sbx.<deviceId>`); el identificador lo entrego el servidor al
 * aprobar y activar la vinculacion, nunca un dato aportado por la interfaz. Los datos de demostracion (perfil DEMO) y los
 * descargados nunca se mezclan: son perfiles distintos y todo se filtra por `profileId`.
 *
 * Integridad de la descarga: se guarda TODO o NADA. El llamador entrega el conjunto completo ya validado y [commit] lo escribe en
 * una sola transaccion de Room; si algo falla, la cache anterior queda exactamente como estaba.
 *
 * Nada se borra: un alumno que ya no figura en el padron queda inactivo (los borradores previos lo referencian) y un grupo que
 * dejo de estar autorizado queda REVOKED (bloqueado, con sus borradores conservados para una revision posterior).
 */

object SandboxIds {
    private const val SEP = "."

    fun profile(deviceId: String): String = "sbx$SEP$deviceId"

    fun group(profileId: String, remoteGroupId: String): String = "$profileId$SEP$remoteGroupId"

    fun student(localGroupId: String, remoteStudentId: String): String = "$localGroupId$SEP$remoteStudentId"
}

data class DownloadedStudent(val remoteId: String, val givenNames: String, val familyName: String)

data class DownloadedGroup(
    val remoteId: String,
    val label: String,
    val grade: Int,
    val code: String,
    val shift: String?,
    val schoolYearId: String,
    val schoolYearName: String,
    val students: List<DownloadedStudent>,
)

/** Conjunto COMPLETO de una descarga ya validada. */
data class DownloadSpec(
    val deviceId: String,
    val ownerName: String,
    /** "asOf" confirmado por el servidor (fecha escolar America/Mazatlan). */
    val serverSchoolDate: String,
    val groups: List<DownloadedGroup>,
    /** Grupos conocidos que el servidor informo como ya no autorizados durante esta descarga (404 del padron). */
    val revokedRemoteGroupIds: Set<String> = emptySet(),
)

data class CommitResult(
    val groupsStored: Int,
    val groupsRevoked: Int,
    /** Grupos cuyo padron descargado es distinto del descargado antes. */
    val changedRosters: Int,
    /** Borradores marcados para revision (padron distinto o grupo revocado); sus marcas no se modifican. */
    val draftsFlagged: Int,
)

object RosterDigest {
    /** SHA-256 hexadecimal del conjunto de alumnos (ordenado): detecta cambios; el servidor no entrega una version del padron. */
    fun of(students: List<DownloadedStudent>): String {
        val md = MessageDigest.getInstance("SHA-256")
        students.sortedBy { it.remoteId }.forEach {
            md.update("${it.remoteId}\u0001${it.givenNames}\u0001${it.familyName}\u0002".toByteArray(Charsets.UTF_8))
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

/** Destino de una descarga autorizada (la cache cifrada). Es una interfaz para poder probar la descarga sin Room. */
interface OfflineSink {
    suspend fun commit(spec: DownloadSpec): CommitResult

    suspend fun markAuthState(deviceId: String, state: String): Boolean

    suspend fun purge(deviceId: String): Boolean
}

class OfflineCacheStore(
    private val db: EtaDatabase,
    private val clock: Clock,
    private val policy: OfflinePolicy = OfflinePolicy.SANDBOX_DEFAULT,
) : OfflineSink {
    private val cache = db.cacheDao()
    private val outbox = OutboxStore(db, clock)

    /** Escribe una descarga COMPLETA en una sola transaccion (todo o nada). */
    override suspend fun commit(spec: DownloadSpec): CommitResult = db.withTransaction {
        val now = clock.millis()
        val profileId = SandboxIds.profile(spec.deviceId)
        require(spec.groups.map { it.remoteId }.toSet().size == spec.groups.size) { "grupo duplicado en la descarga" }
        spec.groups.forEach { g ->
            require(g.students.map { it.remoteId }.toSet().size == g.students.size) { "alumno duplicado en el padron" }
        }
        cache.upsertProfile(ProfileEntity(profileId, spec.ownerName, isDemo = false, source = ProfileEntity.SOURCE_SANDBOX))

        val known = cache.groupsOf(profileId).associateBy { it.id }
        var flagged = 0
        var changed = 0
        val downloadedLocal = HashSet<String>()
        spec.groups.forEachIndexed { index, g ->
            val localId = SandboxIds.group(profileId, g.remoteId)
            downloadedLocal += localId
            cache.upsertGroup(
                GroupEntity(
                    id = localId,
                    profileId = profileId,
                    name = g.label,
                    grade = g.grade,
                    sortOrder = index,
                    remoteId = g.remoteId,
                    schoolYearId = g.schoolYearId,
                    schoolYearName = g.schoolYearName,
                    shift = g.shift,
                    authState = GroupEntity.AUTH_ACTIVE,
                ),
            )
            val entities = g.students.map {
                StudentEntity(SandboxIds.student(localId, it.remoteId), localId, it.givenNames, it.familyName, it.remoteId, active = 1)
            }
            if (entities.isNotEmpty()) cache.upsertStudents(entities)
            if (entities.isEmpty()) cache.deactivateAll(localId) else cache.deactivateMissing(localId, entities.map { it.id })
            val digest = RosterDigest.of(g.students)
            val previous = db.catalogDao().rosterDigestOf(localId)
            if (previous != null && previous != digest) changed += 1
            flagged += cache.flagDraftsForReview(profileId, localId, digest, REASON_ROSTER_CHANGED)
            outbox.reviewRosterChanged(profileId, localId) // lo que aun no se envio de esos borradores queda para revision
            cache.upsertSnapshot(RosterSnapshotEntity(localId, now, spec.serverSchoolDate, digest, g.students.size))
        }
        // Grupos conocidos que el servidor ya no autoriza (no vinieron o su padron respondio "no encontrado"): bloqueados, nunca borrados.
        var revoked = 0
        known.values.forEach { k ->
            val gone = k.id !in downloadedLocal || (k.remoteId != null && k.remoteId in spec.revokedRemoteGroupIds)
            if (gone && k.authState != GroupEntity.AUTH_REVOKED) {
                cache.revokeGroup(profileId, k.id)
                flagged += cache.flagAllDraftsOfGroup(profileId, k.id, REASON_GROUP_REVOKED)
                outbox.reviewGroupRevoked(profileId, k.id) // las operaciones sin enviar se conservan, en revision
                revoked += 1
            }
        }
        val previousHigh = cache.syncOf(profileId)?.highWaterEpochMs ?: 0L
        cache.upsertSync(
            ProfileSyncEntity(
                profileId = profileId,
                deviceId = spec.deviceId,
                lastServerContactEpochMs = now,
                serverSchoolDate = spec.serverSchoolDate,
                lastDownloadAtEpochMs = now,
                authorizedUntilEpochMs = now + policy.validity.toMillis(),
                authState = AUTH_ACTIVE,
                highWaterEpochMs = max(now, previousHigh),
            ),
        )
        CommitResult(downloadedLocal.size, revoked, changed, flagged)
    }

    /** El servidor informo que el dispositivo fue revocado o la cuenta ya no es elegible: se bloquea todo, se conserva todo. */
    override suspend fun markAuthState(deviceId: String, state: String): Boolean = db.withTransaction {
        require(state == AUTH_DEVICE_REVOKED || state == AUTH_ACCOUNT_BLOCKED || state == AUTH_ACTIVE)
        val profileId = SandboxIds.profile(deviceId)
        if (state != AUTH_ACTIVE) outbox.requireAuth(profileId, state) // lo que estaba listo exige volver a autenticarse
        cache.setAuthState(profileId, state, clock.millis()) > 0
    }

    /** Borrado EXPLICITO (confirmado por la persona) de los datos descargados de un dispositivo, borradores incluidos. */
    override suspend fun purge(deviceId: String): Boolean = cache.purgeSandboxProfile(SandboxIds.profile(deviceId)) > 0

    suspend fun hasCache(deviceId: String): Boolean = cache.profileExists(SandboxIds.profile(deviceId)) > 0

    companion object {
        const val AUTH_ACTIVE = "ACTIVE"
        const val AUTH_DEVICE_REVOKED = "DEVICE_REVOKED"
        const val AUTH_ACCOUNT_BLOCKED = "ACCOUNT_BLOCKED"
        const val REASON_ROSTER_CHANGED = "ROSTER_CHANGED"
        const val REASON_GROUP_REVOKED = "GROUP_REVOKED"
    }
}

/**
 * Decide si las consultas escolares protegidas de un perfil descargado estan permitidas AHORA. No confunde una sesion movil
 * vencida con una concesion offline: aqui solo cuenta la ultima validacion del servidor y la vigencia de DEMOSTRACION.
 *  - El servidor informo revocacion o bloqueo -> bloqueado (offline no puede conocer un cambio posterior: limitacion documentada).
 *  - El reloj retrocedio mas de la tolerancia respecto al mayor instante visto -> CLOCK_SUSPECT hasta reconectar.
 *  - Vencio la vigencia -> EXPIRED (no se borra nada; el almacenamiento sigue cifrado y aislado).
 */
class ProfileAccessGate(
    private val db: EtaDatabase,
    private val profileId: String,
    private val clock: Clock,
    private val policy: OfflinePolicy = OfflinePolicy.SANDBOX_DEFAULT,
    private val refreshMs: Long = 15_000,
) : AccessGate {
    private val cache = db.cacheDao()

    override suspend fun current(): OfflineAccess = evaluate(cache.syncOf(profileId))

    override fun observe(): Flow<OfflineAccess> = flow {
        while (true) {
            emit(current())
            delay(refreshMs)
        }
    }.distinctUntilChanged()

    override suspend fun touch() {
        cache.raiseHighWater(profileId, clock.millis())
    }

    fun evaluate(sync: ProfileSyncEntity?): OfflineAccess {
        sync ?: return OfflineAccess.Blocked(AccessBlock.EXPIRED)
        val now = clock.millis()
        return when {
            sync.authState == OfflineCacheStore.AUTH_DEVICE_REVOKED -> OfflineAccess.Blocked(AccessBlock.DEVICE_REVOKED)
            sync.authState == OfflineCacheStore.AUTH_ACCOUNT_BLOCKED -> OfflineAccess.Blocked(AccessBlock.ACCOUNT_BLOCKED)
            now < sync.highWaterEpochMs - policy.clockTolerance.toMillis() -> OfflineAccess.Blocked(AccessBlock.CLOCK_SUSPECT)
            now >= sync.authorizedUntilEpochMs -> OfflineAccess.Blocked(AccessBlock.EXPIRED)
            else -> OfflineAccess.Active(
                until = Instant.ofEpochMilli(sync.authorizedUntilEpochMs),
                dateConfirmed = SchoolCalendar.today(clock) == LocalDate.parse(sync.serverSchoolDate),
            )
        }
    }
}
