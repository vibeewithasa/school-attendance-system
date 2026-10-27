package mx.edu.eta15.prefectura.domain

import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.flow.Flow

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
