package mx.edu.eta15.prefectura.data

import androidx.room.withTransaction
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import kotlinx.coroutines.delay
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.local.DraftEntity
import mx.edu.eta15.prefectura.data.local.MarkEntity
import mx.edu.eta15.prefectura.data.local.RosterRow
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.domain.CaptureRow
import mx.edu.eta15.prefectura.domain.DraftState
import mx.edu.eta15.prefectura.domain.Group
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.Profile
import mx.edu.eta15.prefectura.domain.SchoolCalendar
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.domain.Student

/**
 * Fuente LOCAL (Room). Todo se filtra por `profileId`: un perfil jamas ve ni modifica datos de otro. Las escrituras son
 * transacciones de Room. Esta clase no usa red.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LocalAttendanceRepository(
    private val db: EtaDatabase,
    private val profileId: String,
    private val clock: Clock,
    private val ids: IdGenerator = IdGenerator.Random,
    private val dateRefreshMs: Long = 30_000,
) : AttendanceRepository {
    private val catalog = db.catalogDao()
    private val drafts = db.draftDao()

    override fun schoolToday(): LocalDate = SchoolCalendar.today(clock)

    /** Fecha escolar vigente; se vuelve a evaluar para que una lista no siga "de hoy" despues de la medianoche. */
    private fun todayFlow(): Flow<LocalDate> = flow {
        while (true) {
            emit(schoolToday())
            delay(dateRefreshMs)
        }
    }.distinctUntilChanged()

    override fun observeProfile(): Flow<Profile?> =
        catalog.observeProfile(profileId).map { p -> p?.let { Profile(it.id, it.displayName, it.isDemo) } }

    override fun observeGroups(): Flow<List<Group>> =
        todayFlow().flatMapLatest { date ->
            catalog.observeGroups(profileId, date.toString()).map { rows ->
                rows.map {
                    Group(
                        id = it.id,
                        name = it.name,
                        grade = it.grade,
                        studentCount = it.studentCount,
                        markedToday = it.markedToday,
                        hasDraftToday = it.hasDraftToday > 0,
                    )
                }
            }
        }

    override fun observeRoster(groupId: String): Flow<List<Student>> =
        catalog.observeStudents(profileId, groupId).map { list ->
            list.map { Student(it.id, it.givenNames, it.familyName) }
        }

    override fun observeGroupName(groupId: String): Flow<String?> = catalog.observeGroupName(profileId, groupId)

    override suspend fun openTodayDraft(groupId: String): OpenDraftResult {
        val today = schoolToday()
        if (!SchoolCalendar.isSchoolDay(today)) return OpenDraftResult.NotSchoolDay(today)
        return db.withTransaction {
            if (catalog.groupExists(profileId, groupId) == 0) return@withTransaction OpenDraftResult.GroupNotFound
            val date = today.toString()
            drafts.findDraftId(profileId, groupId, date)?.let {
                return@withTransaction OpenDraftResult.Ready(it, created = false)
            }
            val students = catalog.studentsOf(profileId, groupId)
            if (students.isEmpty()) return@withTransaction OpenDraftResult.EmptyRoster
            val now = clock.millis()
            val draftId = ids.newId()
            drafts.insertDraft(DraftEntity(draftId, profileId, groupId, date, ids.newId(), now, now))
            // El padron del borrador se congela aqui: una marca pendiente por alumno del grupo.
            drafts.insertMarks(students.map { MarkEntity(draftId, groupId, it.id, status = null, markedAtEpochMs = null) })
            OpenDraftResult.Ready(draftId, created = true)
        }
    }

    override fun observeTodayDraft(groupId: String): Flow<DraftState?> =
        todayFlow().flatMapLatest { date ->
            drafts.observeDraft(profileId, groupId, date.toString()).flatMapLatest { draft ->
                if (draft == null) {
                    flowOf(null)
                } else {
                    combine(
                        drafts.observeRows(draft.id),
                        catalog.observeGroupName(profileId, groupId),
                    ) { rows, name -> draft.toState(name.orEmpty(), rows) }
                }
            }
        }

    override suspend fun setMark(draftId: String, studentId: String, mark: AttendanceMark?): SetMarkResult =
        db.withTransaction {
            val draft = drafts.findDraft(profileId, draftId) ?: return@withTransaction SetMarkResult.NotFound
            // Un borrador de otra fecha escolar (p. ej. de ayer) ya no se modifica.
            if (draft.schoolDate != schoolToday().toString()) return@withTransaction SetMarkResult.DraftNotEditable
            val now = clock.millis()
            val changed = drafts.updateMark(draftId, studentId, mark?.name, if (mark == null) null else now)
            if (changed == 0) return@withTransaction SetMarkResult.NotFound
            drafts.touchDraft(draftId, now)
            SetMarkResult.Saved
        }

    private fun DraftEntity.toState(groupName: String, rows: List<RosterRow>): DraftState = DraftState(
        draftId = id,
        groupId = groupId,
        groupName = groupName,
        schoolDate = LocalDate.parse(schoolDate),
        requestId = requestId,
        rows = rows.map { r ->
            CaptureRow(
                student = Student(r.studentId, r.givenNames, r.familyName),
                mark = r.status?.let { runCatching { AttendanceMark.valueOf(it) }.getOrNull() },
            )
        },
        updatedAt = Instant.ofEpochMilli(updatedAtEpochMs),
    )
}
