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
import java.time.ZoneOffset
import kotlinx.coroutines.flow.emptyFlow
import mx.edu.eta15.prefectura.domain.AccessGate
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.SyncInfo
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.domain.CaptureRow
import mx.edu.eta15.prefectura.domain.DraftState
import mx.edu.eta15.prefectura.domain.Group
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.OutboxSummary
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.Refusal
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
    /** Perfiles descargados del servidor de pruebas: vigencia offline, revocaciones y reloj. `null` = demostracion local. */
    private val access: AccessGate? = null,
) : AttendanceRepository {
    private val catalog = db.catalogDao()
    private val drafts = db.draftDao()

    /** La outbox solo existe para perfiles descargados del servidor de pruebas (SANDBOX): la demostracion local no la tiene. */
    private val outbox: OutboxStore? = if (access != null) OutboxStore(db, clock, ids) else null

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
                        revoked = it.authState != "ACTIVE",
                        downloadedAt = it.downloadedAtEpochMs?.let(Instant::ofEpochMilli),
                        needsReview = it.needsReview > 0,
                    )
                }
            }
        }

    override fun observeRoster(groupId: String): Flow<List<Student>> {
        val students = catalog.observeStudents(profileId, groupId).map { list ->
            list.map { Student(it.id, it.givenNames, it.familyName) }
        }
        val gate = access ?: return students
        // Perfil descargado: sin autorizacion vigente (o con el grupo revocado) NO se entrega el padron.
        return combine(gate.observe(), catalog.observeGroupAuthState(profileId, groupId), students) { acc, auth, list ->
            if (acc is OfflineAccess.Blocked || auth != "ACTIVE") emptyList() else list
        }
    }

    override fun observeAccess(): Flow<OfflineAccess> = access?.observe() ?: super.observeAccess()

    override fun observeSyncInfo(): Flow<SyncInfo?> =
        if (access == null) {
            super.observeSyncInfo()
        } else {
            db.cacheDao().observeSync(profileId).map { s ->
                s?.let {
                    SyncInfo(
                        lastDownloadAt = Instant.ofEpochMilli(it.lastDownloadAtEpochMs),
                        lastContactAt = Instant.ofEpochMilli(it.lastServerContactEpochMs),
                        serverSchoolDate = LocalDate.parse(it.serverSchoolDate),
                    )
                }
            }
        }

    override fun observeGroupName(groupId: String): Flow<String?> = catalog.observeGroupName(profileId, groupId)

    override suspend fun openTodayDraft(groupId: String): OpenDraftResult {
        val today = schoolToday()
        if (!SchoolCalendar.isSchoolDay(today)) return OpenDraftResult.NotSchoolDay(today)
        (access?.current() as? OfflineAccess.Blocked)?.let { return OpenDraftResult.AccessBlocked(it.reason) }
        access?.touch()
        return db.withTransaction {
            if (catalog.groupExists(profileId, groupId) == 0) return@withTransaction OpenDraftResult.GroupNotFound
            if (catalog.groupAuthState(profileId, groupId) != "ACTIVE") return@withTransaction OpenDraftResult.GroupRevoked
            val date = today.toString()
            drafts.findDraftId(profileId, groupId, date)?.let {
                return@withTransaction OpenDraftResult.Ready(it, created = false)
            }
            val students = catalog.studentsOf(profileId, groupId)
            if (students.isEmpty()) return@withTransaction OpenDraftResult.EmptyRoster
            val now = clock.millis()
            val draftId = ids.newId()
            // El padron con el que nace el borrador queda como referencia historica (NULL en la demostracion).
            drafts.insertDraft(
                DraftEntity(draftId, profileId, groupId, date, ids.newId(), now, now, rosterDigest = catalog.rosterDigestOf(groupId)),
            )
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

    override suspend fun setMark(draftId: String, studentId: String, mark: AttendanceMark?): SetMarkResult {
        (access?.current() as? OfflineAccess.Blocked)?.let { return SetMarkResult.AccessBlocked(it.reason) }
        access?.touch()
        return db.withTransaction {
            val draft = drafts.findDraft(profileId, draftId) ?: return@withTransaction SetMarkResult.NotFound
            if (catalog.groupAuthState(profileId, draft.groupId) != "ACTIVE") return@withTransaction SetMarkResult.GroupRevoked
            // Un borrador de otra fecha escolar (p. ej. de ayer) ya no se modifica.
            if (draft.schoolDate != schoolToday().toString()) return@withTransaction SetMarkResult.DraftNotEditable
            // Una marca que el servidor ya confirmo solo cambia entre Presente y Ausente: Pendiente no es una orden de borrarla.
            if (mark == null && outbox?.isAcknowledgedStudent(draftId, studentId) == true) return@withTransaction SetMarkResult.UnmarkAfterAck
            val now = clock.millis()
            val changed = drafts.updateMark(draftId, studentId, mark?.name, if (mark == null) null else now)
            if (changed == 0) return@withTransaction SetMarkResult.NotFound
            drafts.touchDraft(draftId, now)
            // En la MISMA transaccion: la marca y el estado "cambios sin preparar" nunca quedan desalineados.
            outbox?.refreshIntent(profileId, draft)
            SetMarkResult.Saved
        }
    }

    override fun observeOutbox(groupId: String): Flow<OutboxSummary?> =
        outbox?.observeSummary(profileId, groupId, todayFlow()) ?: flowOf(null)

    override suspend fun prepareForSync(draftId: String): PrepareResult {
        val store = outbox ?: return PrepareResult.Refused(Refusal.NotSandbox)
        val gate = access?.current()
        if (gate is OfflineAccess.Blocked) return PrepareResult.AccessBlocked(gate.reason)
        access?.touch()
        // La fecha solo se considera confirmada si coincide con la ultima fecha escolar que informo el servidor.
        val confirmed = (gate as? OfflineAccess.Active)?.dateConfirmed ?: false
        return store.prepare(profileId, draftId, schoolToday(), confirmed)
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
        needsReview = needsReview > 0,
        reviewReason = reviewReason,
    )
}
