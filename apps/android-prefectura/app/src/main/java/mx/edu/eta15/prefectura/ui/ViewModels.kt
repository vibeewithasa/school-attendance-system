package mx.edu.eta15.prefectura.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.time.LocalDate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import mx.edu.eta15.prefectura.data.NetworkMonitor
import mx.edu.eta15.prefectura.dev.DevHealthCheck
import mx.edu.eta15.prefectura.dev.HealthResult
import mx.edu.eta15.prefectura.domain.AccessBlock
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.SyncInfo
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.domain.DraftState
import mx.edu.eta15.prefectura.domain.Group
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.Profile
import mx.edu.eta15.prefectura.domain.SchoolCalendar
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.domain.Student

private const val STOP_TIMEOUT_MS = 5_000L

// ---------- Grupos ----------

data class GroupsUiState(
    val loading: Boolean = true,
    val error: Boolean = false,
    val profile: Profile? = null,
    val groups: List<Group> = emptyList(),
    val date: LocalDate? = null,
    val isSchoolDay: Boolean = true,
    /** Autorizacion offline (perfiles descargados del servidor de pruebas); [OfflineAccess.NotApplicable] en la demostracion. */
    val access: OfflineAccess = OfflineAccess.NotApplicable,
    val sync: SyncInfo? = null,
)

class GroupsViewModel(repo: AttendanceRepository) : ViewModel() {
    val state: StateFlow<GroupsUiState> = combine(
        combine(repo.observeProfile(), repo.observeGroups()) { profile, groups -> profile to groups },
        repo.observeAccess(),
        repo.observeSyncInfo(),
    ) { (profile, groups), access, sync ->
        val date = repo.schoolToday()
        GroupsUiState(
            loading = false,
            profile = profile,
            groups = groups,
            date = date,
            isSchoolDay = SchoolCalendar.isSchoolDay(date),
            access = access,
            sync = sync,
        )
    }
        .catch { emit(GroupsUiState(loading = false, error = true)) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), GroupsUiState())
}

// ---------- Inicio ----------

data class HomeUiState(val profile: Profile? = null, val date: LocalDate? = null, val isSchoolDay: Boolean = true)

class HomeViewModel(repo: AttendanceRepository) : ViewModel() {
    val state: StateFlow<HomeUiState> = repo.observeProfile()
        .map { HomeUiState(it, repo.schoolToday(), SchoolCalendar.isSchoolDay(repo.schoolToday())) }
        .catch { emit(HomeUiState(date = repo.schoolToday())) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), HomeUiState())
}

// ---------- Padron del grupo ----------

data class RosterUiState(
    val loading: Boolean = true,
    val error: Boolean = false,
    val groupName: String? = null,
    val students: List<Student> = emptyList(),
    val isSchoolDay: Boolean = true,
    val access: OfflineAccess = OfflineAccess.NotApplicable,
)

class RosterViewModel(repo: AttendanceRepository, groupId: String) : ViewModel() {
    val state: StateFlow<RosterUiState> =
        combine(repo.observeGroupName(groupId), repo.observeRoster(groupId), repo.observeAccess()) { name, students, access ->
            RosterUiState(
                loading = false,
                groupName = name,
                students = students,
                isSchoolDay = SchoolCalendar.isSchoolDay(repo.schoolToday()),
                access = access,
            )
        }
            .catch { emit(RosterUiState(loading = false, error = true)) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), RosterUiState())
}

// ---------- Captura ----------

sealed interface CaptureUiState {
    data object Loading : CaptureUiState

    data class Ready(val draft: DraftState) : CaptureUiState

    data class NotSchoolDay(val date: LocalDate) : CaptureUiState

    data object GroupNotFound : CaptureUiState

    data object EmptyRoster : CaptureUiState

    data object Error : CaptureUiState

    /** Perfil descargado sin autorizacion offline vigente: la captura esta bloqueada y los borradores se conservan. */
    data class Blocked(val reason: AccessBlock) : CaptureUiState

    /** El grupo dejo de estar autorizado: captura bloqueada, borradores conservados. */
    data object GroupRevoked : CaptureUiState
}

enum class CaptureMessage { DraftNotEditable, NotFound, SaveFailed, AccessBlocked, GroupRevoked }

@OptIn(ExperimentalCoroutinesApi::class)
class CaptureViewModel(private val repo: AttendanceRepository, private val groupId: String) : ViewModel() {
    private sealed interface Opening {
        data object Pending : Opening

        data class Done(val result: OpenDraftResult) : Opening

        data object Failed : Opening
    }

    private val opening = MutableStateFlow<Opening>(Opening.Pending)
    private val _message = MutableStateFlow<CaptureMessage?>(null)

    /** Aviso transitorio (p. ej. el borrador ya no es de hoy). La UI lo muestra y llama a [consumeMessage]. */
    val message: StateFlow<CaptureMessage?> = _message

    val state: StateFlow<CaptureUiState> = opening
        .flatMapLatest { o ->
            when (o) {
                Opening.Pending -> flowOf(CaptureUiState.Loading)
                Opening.Failed -> flowOf(CaptureUiState.Error)
                is Opening.Done -> when (val r = o.result) {
                    is OpenDraftResult.Ready ->
                        combine(repo.observeTodayDraft(groupId), repo.observeAccess()) { d, access ->
                            when {
                                access is OfflineAccess.Blocked -> CaptureUiState.Blocked(access.reason)
                                d == null -> CaptureUiState.Loading
                                else -> CaptureUiState.Ready(d)
                            }
                        }
                    is OpenDraftResult.AccessBlocked -> flowOf(CaptureUiState.Blocked(r.reason))
                    OpenDraftResult.GroupRevoked -> flowOf(CaptureUiState.GroupRevoked)
                    is OpenDraftResult.NotSchoolDay -> flowOf(CaptureUiState.NotSchoolDay(r.date))
                    OpenDraftResult.GroupNotFound -> flowOf(CaptureUiState.GroupNotFound)
                    OpenDraftResult.EmptyRoster -> flowOf(CaptureUiState.EmptyRoster)
                }
            }
        }
        .catch { emit(CaptureUiState.Error) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), CaptureUiState.Loading)

    init {
        viewModelScope.launch {
            opening.value = try {
                Opening.Done(repo.openTodayDraft(groupId))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                Opening.Failed
            }
        }
    }

    fun setMark(draftId: String, studentId: String, mark: AttendanceMark?) {
        viewModelScope.launch {
            _message.value = try {
                when (repo.setMark(draftId, studentId, mark)) {
                    SetMarkResult.Saved -> null
                    SetMarkResult.DraftNotEditable -> CaptureMessage.DraftNotEditable
                    SetMarkResult.NotFound -> CaptureMessage.NotFound
                    is SetMarkResult.AccessBlocked -> CaptureMessage.AccessBlocked
                    SetMarkResult.GroupRevoked -> CaptureMessage.GroupRevoked
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                CaptureMessage.SaveFailed
            }
        }
    }

    fun consumeMessage() {
        _message.value = null
    }
}

// ---------- Resumen ----------

sealed interface SummaryUiState {
    data object Loading : SummaryUiState

    data object NoDraft : SummaryUiState

    data class Ready(val draft: DraftState) : SummaryUiState

    data object Error : SummaryUiState
}

class SummaryViewModel(repo: AttendanceRepository, groupId: String) : ViewModel() {
    val state: StateFlow<SummaryUiState> = repo.observeTodayDraft(groupId)
        .map { d -> if (d == null) SummaryUiState.NoDraft else SummaryUiState.Ready(d) }
        .catch { emit(SummaryUiState.Error) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), SummaryUiState.Loading)
}

// ---------- Conectividad y sincronizacion ----------

data class ConnectivityUiState(
    /** Version de SQLCipher que respondio; `null` = la base NO esta cifrada (solo posible en pruebas). */
    val encryption: String? = null,
    val online: Boolean = false,
    val health: HealthResult? = null,
    val checkingHealth: Boolean = false,
)

class ConnectivityViewModel(network: NetworkMonitor, private val encryption: String?) : ViewModel() {
    private val health = MutableStateFlow<HealthResult?>(null)
    private val checking = MutableStateFlow(false)

    val state: StateFlow<ConnectivityUiState> = combine(network.isOnline, health, checking) { online, h, c ->
        ConnectivityUiState(encryption, online, h, c)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), ConnectivityUiState(encryption))

    fun checkHealth() {
        if (!DevHealthCheck.AVAILABLE || checking.value) return
        viewModelScope.launch {
            checking.value = true
            health.value = try {
                DevHealthCheck.check()
            } finally {
                checking.value = false
            }
        }
    }
}
