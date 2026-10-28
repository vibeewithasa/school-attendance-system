package mx.edu.eta15.prefectura.ui

import java.time.Instant
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import mx.edu.eta15.prefectura.data.NetworkMonitor
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.domain.CaptureRow
import mx.edu.eta15.prefectura.domain.DraftState
import mx.edu.eta15.prefectura.domain.Group
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.Profile
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.domain.Student
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Repositorio en memoria para probar los ViewModel sin Android ni Room. */
private class FakeRepository(
    var today: LocalDate = LocalDate.of(2026, 10, 27), // martes
    var profile: Profile? = Profile("p", "Prefecta de demostración (ficticia)", true),
) : AttendanceRepository {
    val groups = MutableStateFlow<List<Group>>(emptyList())
    val roster = MutableStateFlow<Map<String, List<Student>>>(emptyMap())
    val draft = MutableStateFlow<DraftState?>(null)
    var openResult: OpenDraftResult = OpenDraftResult.Ready("d1", created = true)
    var setMarkResult: SetMarkResult = SetMarkResult.Saved
    var failGroups = false
    var failOpen = false
    val marks = mutableListOf<Triple<String, String, AttendanceMark?>>()

    override fun observeProfile(): Flow<Profile?> = MutableStateFlow(profile)

    override fun observeGroups(): Flow<List<Group>> =
        if (failGroups) flow { throw IllegalStateException("fallo local") } else groups

    override fun observeRoster(groupId: String): Flow<List<Student>> = roster.map { it[groupId].orEmpty() }

    override fun observeGroupName(groupId: String): Flow<String?> =
        groups.map { list -> list.firstOrNull { it.id == groupId }?.name }

    override suspend fun openTodayDraft(groupId: String): OpenDraftResult {
        if (failOpen) throw IllegalStateException("fallo local")
        return openResult
    }

    override fun observeTodayDraft(groupId: String): Flow<DraftState?> = draft

    override suspend fun setMark(draftId: String, studentId: String, mark: AttendanceMark?): SetMarkResult {
        marks += Triple(draftId, studentId, mark)
        return setMarkResult
    }

    override fun schoolToday(): LocalDate = today
}

private fun student(n: Int) = Student("s$n", "Alumno %02d".format(n), "Ficticio 1A")

private fun draftOf(vararg marks: AttendanceMark?) = DraftState(
    draftId = "d1",
    groupId = "g1",
    groupName = "1° A",
    schoolDate = LocalDate.of(2026, 10, 27),
    requestId = "r1",
    rows = marks.mapIndexed { i, m -> CaptureRow(student(i + 1), m) },
    updatedAt = Instant.EPOCH,
)

@OptIn(ExperimentalCoroutinesApi::class)
class ViewModelsTest {
    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `los grupos del perfil se muestran con su avance`() = runTest {
        val repo = FakeRepository()
        repo.groups.value = listOf(Group("g1", "1° A", 1, 12, markedToday = 3, hasDraftToday = true))
        val vm = GroupsViewModel(repo)
        val job = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        val s = vm.state.value
        assertFalse(s.loading)
        assertEquals(1, s.groups.size)
        assertEquals(3, s.groups[0].markedToday)
        assertTrue(s.isSchoolDay)
        job.cancel()
    }

    @Test
    fun `sin grupos el estado es vacio (no error)`() = runTest {
        val vm = GroupsViewModel(FakeRepository())
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertTrue(vm.state.value.groups.isEmpty())
        assertFalse(vm.state.value.loading)
        assertFalse(vm.state.value.error)
    }

    @Test
    fun `un fallo local se refleja como error y no como datos`() = runTest {
        val repo = FakeRepository().apply { failGroups = true }
        val vm = GroupsViewModel(repo)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertTrue(vm.state.value.error)
        assertTrue(vm.state.value.groups.isEmpty())
    }

    @Test
    fun `en fin de semana la lista de grupos lo advierte`() = runTest {
        val repo = FakeRepository(today = LocalDate.of(2026, 10, 31)) // sabado
        val vm = GroupsViewModel(repo)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertFalse(vm.state.value.isSchoolDay)
    }

    @Test
    fun `sin perfil (release) el inicio no ofrece grupos`() = runTest {
        val vm = HomeViewModel(FakeRepository(profile = null))
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertNull(vm.state.value.profile)
    }

    @Test
    fun `el padron del grupo se lista con el nombre del grupo`() = runTest {
        val repo = FakeRepository()
        repo.groups.value = listOf(Group("g1", "1° A", 1, 2, 0, false))
        repo.roster.value = mapOf("g1" to listOf(student(1), student(2)), "g2" to listOf(student(9)))
        val vm = RosterViewModel(repo, "g1")
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertEquals("1° A", vm.state.value.groupName)
        assertEquals(listOf("s1", "s2"), vm.state.value.students.map { it.id }) // aislamiento por grupo
    }

    @Test
    fun `captura lista - abre el borrador y expone el progreso`() = runTest {
        val repo = FakeRepository()
        repo.draft.value = draftOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT, null)
        val vm = CaptureViewModel(repo, "g1")
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        val ready = vm.state.value as CaptureUiState.Ready
        assertEquals(2, ready.draft.summary.marked)
        assertEquals(1, ready.draft.summary.pending)
    }

    @Test
    fun `captura - cambiar una marca llama al repositorio y el estado sigue al flujo`() = runTest {
        val repo = FakeRepository()
        repo.draft.value = draftOf(null, null)
        val vm = CaptureViewModel(repo, "g1")
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        vm.setMark("d1", "s1", AttendanceMark.PRESENT)
        assertEquals(listOf(Triple("d1", "s1", AttendanceMark.PRESENT)), repo.marks)
        assertNull(vm.message.value)
        repo.draft.value = draftOf(AttendanceMark.PRESENT, null)
        assertEquals(1, (vm.state.value as CaptureUiState.Ready).draft.summary.present)
    }

    @Test
    fun `captura - un borrador de otro dia produce aviso y no cambia el estado`() = runTest {
        val repo = FakeRepository().apply { setMarkResult = SetMarkResult.DraftNotEditable }
        repo.draft.value = draftOf(null)
        val vm = CaptureViewModel(repo, "g1")
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        vm.setMark("d1", "s1", AttendanceMark.ABSENT)
        assertEquals(CaptureMessage.DraftNotEditable, vm.message.value)
        vm.consumeMessage()
        assertNull(vm.message.value)
    }

    @Test
    fun `captura - estados de bloqueo y de error`() = runTest {
        suspend fun stateFor(configure: FakeRepository.() -> Unit): CaptureUiState {
            val repo = FakeRepository().apply(configure)
            val vm = CaptureViewModel(repo, "g1")
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
            return vm.state.value
        }
        val saturday = LocalDate.of(2026, 10, 31)
        assertEquals(CaptureUiState.NotSchoolDay(saturday), stateFor { openResult = OpenDraftResult.NotSchoolDay(saturday) })
        assertEquals(CaptureUiState.EmptyRoster, stateFor { openResult = OpenDraftResult.EmptyRoster })
        assertEquals(CaptureUiState.GroupNotFound, stateFor { openResult = OpenDraftResult.GroupNotFound })
        assertEquals(CaptureUiState.Error, stateFor { failOpen = true })
    }

    @Test
    fun `resumen - sin borrador, con borrador y pendientes`() = runTest {
        val repo = FakeRepository()
        val vm = SummaryViewModel(repo, "g1")
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertEquals(SummaryUiState.NoDraft, vm.state.value)
        repo.draft.value = draftOf(AttendanceMark.PRESENT, null)
        val ready = vm.state.value as SummaryUiState.Ready
        assertEquals(1, ready.draft.summary.pending)
    }

    @Test
    fun `conectividad - el estado de red es solo informativo`() = runTest {
        val network = NetworkMonitor.Fake(initial = false)
        val vm = ConnectivityViewModel(network, encryption = null)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.state.collect {} }
        assertFalse(vm.state.value.online)
        network.set(true)
        assertTrue(vm.state.value.online)
        assertNull(vm.state.value.health) // no se hizo ninguna comprobacion
        assertEquals(false, vm.state.first().checkingHealth)
    }

    @Test
    fun `ver el resumen, preparar, perder y recuperar la conexion o cambiar de estado NO inicia ninguna sincronizacion`() = runTest {
        val spy = SpyManualSync()
        val repo = FakeRepository()
        val network = NetworkMonitor.Fake(initial = true)
        val summary = SummaryViewModel(repo, "g1", spy)
        val connectivity = ConnectivityViewModel(network, encryption = null)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { summary.state.collect {} }
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { connectivity.state.collect {} }
        repo.draft.value = draftOf(AttendanceMark.PRESENT, null)
        summary.prepare("d1") // accion local
        network.set(false)
        network.set(true) // reconexion
        repo.draft.value = draftOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT) // cambio de estado de pantalla
        summary.consumePrepareMessage()
        assertEquals("ningun ciclo salvo la pulsacion", 0, spy.calls.size)
        assertTrue((summary.state.value as SummaryUiState.Ready).syncAvailable)
        summary.syncNow() // la UNICA via: la accion explicita de la persona
        assertEquals(listOf("g1"), spy.calls)
        summary.cancelSync()
        assertEquals(1, spy.cancels)
    }
}

/** Sincronizacion falsa que solo cuenta las pulsaciones. */
private class SpyManualSync : mx.edu.eta15.prefectura.domain.ManualSync {
    val calls = mutableListOf<String>()
    var cancels = 0
    override val available = true
    override val state = MutableStateFlow(mx.edu.eta15.prefectura.domain.ManualSyncState())

    override fun syncNow(groupId: String) {
        calls += groupId
    }

    override fun cancel() {
        cancels++
    }

    override fun consumeReport() = Unit
}
