package mx.edu.eta15.prefectura.domain

import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

/** Generador de identificadores locales (UUID aleatorios; inyectable para pruebas). */
fun interface IdGenerator {
    fun newId(): String

    companion object {
        val Random = IdGenerator { UUID.randomUUID().toString() }
    }
}

/**
 * Repositorio de captura local. La UI solo observa estos Flow (Room es la fuente local de verdad); ninguna operacion
 * depende de internet.
 */
interface AttendanceRepository {
    fun observeProfile(): Flow<Profile?>

    fun observeGroups(): Flow<List<Group>>

    fun observeRoster(groupId: String): Flow<List<Student>>

    fun observeGroupName(groupId: String): Flow<String?>

    /** Obtiene o crea el borrador de HOY del grupo (una sola vez por grupo y fecha); congela el padron local. */
    suspend fun openTodayDraft(groupId: String): OpenDraftResult

    fun observeTodayDraft(groupId: String): Flow<DraftState?>

    /** `mark == null` deja al alumno Pendiente. Se guarda en una transaccion de Room. */
    suspend fun setMark(draftId: String, studentId: String, mark: AttendanceMark?): SetMarkResult

    fun schoolToday(): LocalDate

    /** Autorizacion offline vigente (solo perfiles descargados; en la demostracion local es [OfflineAccess.NotApplicable]). */
    fun observeAccess(): Flow<OfflineAccess> = flowOf(OfflineAccess.NotApplicable)

    /** Ultima descarga y ultimo contacto con el servidor; `null` en la demostracion local. */
    fun observeSyncInfo(): Flow<SyncInfo?> = flowOf(null)

    /** Preparacion local de la sincronizacion del borrador de hoy del grupo (solo perfiles SANDBOX; `null` en la demostracion). */
    fun observeOutbox(groupId: String): Flow<OutboxSummary?> = flowOf(null)

    /** Sella los cambios locales en una operacion preparada. NO envia nada al servidor. */
    suspend fun prepareForSync(draftId: String): PrepareResult = PrepareResult.Refused(Refusal.NotSandbox)
}

/** Decide si las consultas escolares protegidas de un perfil descargado estan permitidas ahora (ver ProfileAccessGate). */
interface AccessGate {
    suspend fun current(): OfflineAccess

    fun observe(): Flow<OfflineAccess>

    /** Registra el instante visto (deteccion de retroceso del reloj). */
    suspend fun touch()
}

/**
 * Politica de vigencia offline de DEMOSTRACION. SANDBOX ONLY: la escuela NO ha aprobado ninguna vigencia de acceso offline,
 * ni capturas tardias, ni borrado remoto. Esta politica solo permite ensayar el comportamiento al vencerse (vigencia corta).
 */
data class OfflinePolicy(
    val validity: java.time.Duration,
    /** Retroceso de reloj tolerado antes de considerarlo manipulacion. */
    val clockTolerance: java.time.Duration = java.time.Duration.ofMinutes(2),
) {
    companion object {
        /** Por omision 30 minutos (configurable al compilar con -Peta15.offlineValidityMinutes). No es una decision institucional. */
        val SANDBOX_DEFAULT = OfflinePolicy(java.time.Duration.ofMinutes(30))
    }
}

/**
 * FUTURA fuente remota (autenticacion, grupos autorizados, envio de asistencia). En la etapa 1 NO existe ninguna
 * implementacion real: [UnavailableRemoteDataSource] solo declara que no hay sincronizacion.
 */
interface RemoteDataSource {
    val status: SyncStatus
}

/** Estado de sincronizacion mostrado al usuario. Hoy solo existe [NotImplemented]; no se simula ningun envio. */
enum class SyncStatus { NotImplemented }

object UnavailableRemoteDataSource : RemoteDataSource {
    override val status: SyncStatus = SyncStatus.NotImplemented
}
