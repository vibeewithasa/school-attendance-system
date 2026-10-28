package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHostState
import androidx.compose.ui.Modifier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import mx.edu.eta15.prefectura.AppContainer
import mx.edu.eta15.prefectura.R
import mx.edu.eta15.prefectura.StorageState
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.mobile.MobileFeature

object Routes {
    const val HOME = "home"
    const val GROUPS = "groups"
    const val CONNECTIVITY = "connectivity"
    const val MOBILE = "mobile"
    const val ROSTER = "roster/{groupId}"
    const val CAPTURE = "capture/{groupId}"
    const val SUMMARY = "summary/{groupId}"

    // Grupos DESCARGADOS del servidor de pruebas (SANDBOX): otro perfil y otro repositorio que la demostracion local.
    const val SBX_GROUPS = "sbx"
    const val SBX_ROSTER = "sbx/roster/{groupId}"
    const val SBX_CAPTURE = "sbx/capture/{groupId}"
    const val SBX_SUMMARY = "sbx/summary/{groupId}"

    fun sbxRoster(groupId: String) = "sbx/roster/$groupId"
    fun sbxCapture(groupId: String) = "sbx/capture/$groupId"
    fun sbxSummary(groupId: String) = "sbx/summary/$groupId"

    fun roster(groupId: String) = "roster/$groupId"
    fun capture(groupId: String) = "capture/$groupId"
    fun summary(groupId: String) = "summary/$groupId"
}

private inline fun <reified T : ViewModel> factory(crossinline create: () -> T) =
    viewModelFactory { initializer { create() } }

private val groupArg = listOf(navArgument("groupId") { type = NavType.StringType })

@Composable
fun EtaApp(container: AppContainer, navController: NavHostController = rememberNavController()) {
    val storage by container.storage.collectAsStateWithLifecycle()
    when (val s = storage) {
        StorageState.Opening ->
            EtaScaffold(title = stringResource(R.string.app_name)) { padding -> LoadingView(Modifier.padding(padding)) }
        // Fail closed: ningun dato ni base vacia de respaldo; solo se explica y se ofrece reintentar.
        is StorageState.Failed ->
            EtaScaffold(title = stringResource(R.string.app_name)) { padding ->
                StorageFailureScreen(
                    error = s.error,
                    onRetry = container::retryOpen,
                    onWipeDemo = container::wipeDemoStorageAndRestart,
                    contentPadding = padding,
                )
            }
        is StorageState.Ready -> EtaNavHost(container, s.repository, s.encryption, navController)
    }
}

@Composable
private fun EtaNavHost(
    container: AppContainer,
    repo: AttendanceRepository,
    encryption: String?,
    navController: NavHostController,
) {
    NavHost(navController = navController, startDestination = Routes.HOME) {
        composable(Routes.HOME) {
            val vm: HomeViewModel = viewModel(factory = factory { HomeViewModel(repo) })
            val state by vm.state.collectAsStateWithLifecycle()
            EtaScaffold(title = stringResource(R.string.app_name)) { padding ->
                HomeScreen(
                    state = state,
                    onGroups = { navController.navigate(Routes.GROUPS) },
                    onConnectivity = { navController.navigate(Routes.CONNECTIVITY) },
                    onMobile = { navController.navigate(Routes.MOBILE) },
                    contentPadding = padding,
                )
            }
        }
        composable(Routes.GROUPS) {
            val vm: GroupsViewModel = viewModel(factory = factory { GroupsViewModel(repo) })
            val state by vm.state.collectAsStateWithLifecycle()
            EtaScaffold(title = stringResource(R.string.groups_title), onBack = { navController.popBackStack() }) { padding ->
                GroupsScreen(state, onOpenGroup = { navController.navigate(Routes.roster(it)) }, contentPadding = padding)
            }
        }
        composable(Routes.ROSTER, arguments = groupArg) { entry ->
            val groupId = entry.arguments?.getString("groupId").orEmpty()
            val vm: RosterViewModel = viewModel(key = "roster-$groupId", factory = factory { RosterViewModel(repo, groupId) })
            val state by vm.state.collectAsStateWithLifecycle()
            EtaScaffold(title = state.groupName ?: stringResource(R.string.roster_title), onBack = { navController.popBackStack() }) { padding ->
                RosterScreen(state, onCapture = { navController.navigate(Routes.capture(groupId)) }, contentPadding = padding)
            }
        }
        composable(Routes.CAPTURE, arguments = groupArg) { entry ->
            val groupId = entry.arguments?.getString("groupId").orEmpty()
            CaptureRoute(
                repo = repo,
                groupId = groupId,
                keyPrefix = "capture",
                onSummary = { navController.navigate(Routes.summary(groupId)) },
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.SUMMARY, arguments = groupArg) { entry ->
            val groupId = entry.arguments?.getString("groupId").orEmpty()
            val vm: SummaryViewModel = viewModel(key = "summary-$groupId", factory = factory { SummaryViewModel(repo, groupId) })
            val state by vm.state.collectAsStateWithLifecycle()
            EtaScaffold(title = stringResource(R.string.summary_title), onBack = { navController.popBackStack() }) { padding ->
                SummaryScreen(state, onContinue = { navController.popBackStack() }, contentPadding = padding)
            }
        }
        // Vinculacion experimental con el servidor de pruebas: solo existe en debug (en release la ruta no se registra).
        if (MobileFeature.AVAILABLE) {
            composable(Routes.MOBILE) {
                MobileFeature.Screen(
                    onBack = { navController.popBackStack() },
                    cache = container.offlineCache,
                    onOpenOffline = { navController.navigate(Routes.SBX_GROUPS) },
                )
            }
            sandboxGraph(container, navController)
        }
        composable(Routes.CONNECTIVITY) {
            val vm: ConnectivityViewModel = viewModel(factory = factory { ConnectivityViewModel(container.networkMonitor, encryption) })
            val state by vm.state.collectAsStateWithLifecycle()
            EtaScaffold(title = stringResource(R.string.connectivity_title), onBack = { navController.popBackStack() }) { padding ->
                ConnectivityScreen(
                    state = state,
                    onCheckHealth = vm::checkHealth,
                    onResetDemo = {
                        container.resetDemo()
                        // Los identificadores cambian al reiniciar la demostracion: se vuelve al inicio.
                        navController.popBackStack(Routes.HOME, inclusive = false)
                    },
                    contentPadding = padding,
                )
            }
        }
    }
}

// ============================== Grupos descargados (SANDBOX) ==============================

/**
 * Pantallas de los grupos DESCARGADOS del servidor de pruebas. Reutilizan las mismas pantallas que la demostracion pero con el
 * repositorio del perfil SANDBOX del dispositivo vinculado (otro perfil, vigencia offline y revocaciones). Funcionan sin
 * internet: solo leen Room; ninguna llama al servidor.
 */
private fun NavGraphBuilder.sandboxGraph(container: AppContainer, navController: NavHostController) {
    composable(Routes.SBX_GROUPS) {
        WithSandboxRepo(container, navController, R.string.offline_groups_title) { repo, padding ->
            val vm: GroupsViewModel = viewModel(key = "sbx-groups", factory = factory { GroupsViewModel(repo) })
            val state by vm.state.collectAsStateWithLifecycle()
            GroupsScreen(state, onOpenGroup = { navController.navigate(Routes.sbxRoster(it)) }, contentPadding = padding)
        }
    }
    composable(Routes.SBX_ROSTER, arguments = groupArg) { entry ->
        val groupId = entry.arguments?.getString("groupId").orEmpty()
        WithSandboxRepo(container, navController, R.string.roster_title) { repo, padding ->
            val vm: RosterViewModel = viewModel(key = "sbx-roster-$groupId", factory = factory { RosterViewModel(repo, groupId) })
            val state by vm.state.collectAsStateWithLifecycle()
            RosterScreen(state, onCapture = { navController.navigate(Routes.sbxCapture(groupId)) }, contentPadding = padding)
        }
    }
    composable(Routes.SBX_CAPTURE, arguments = groupArg) { entry ->
        val groupId = entry.arguments?.getString("groupId").orEmpty()
        WithSandboxRepo(container, navController, R.string.capture_title, scaffold = false) { repo, _ ->
            CaptureRoute(
                repo = repo,
                groupId = groupId,
                keyPrefix = "sbx-capture",
                onSummary = { navController.navigate(Routes.sbxSummary(groupId)) },
                onBack = { navController.popBackStack() },
            )
        }
    }
    composable(Routes.SBX_SUMMARY, arguments = groupArg) { entry ->
        val groupId = entry.arguments?.getString("groupId").orEmpty()
        WithSandboxRepo(container, navController, R.string.summary_title) { repo, padding ->
            val vm: SummaryViewModel = viewModel(key = "sbx-summary-$groupId", factory = factory { SummaryViewModel(repo, groupId) })
            val state by vm.state.collectAsStateWithLifecycle()
            SummaryScreen(
                state,
                onContinue = { navController.popBackStack() },
                contentPadding = padding,
                onPrepare = vm::prepare,
            )
        }
    }
}

@Composable
private fun WithSandboxRepo(
    container: AppContainer,
    navController: NavHostController,
    title: Int,
    scaffold: Boolean = true,
    content: @Composable (AttendanceRepository, androidx.compose.foundation.layout.PaddingValues) -> Unit,
) {
    val context = LocalContext.current.applicationContext
    val repo = remember { MobileFeature.sandboxProfileId(context)?.let(container::sandboxRepository) }
    if (repo != null && !scaffold) {
        content(repo, androidx.compose.foundation.layout.PaddingValues())
        return
    }
    EtaScaffold(title = stringResource(title), onBack = { navController.popBackStack() }) { padding ->
        if (repo == null) {
            MessageView(
                title = stringResource(R.string.offline_none_title),
                detail = stringResource(R.string.offline_none_detail),
                modifier = Modifier.padding(padding),
            )
        } else {
            content(repo, padding)
        }
    }
}

/** Captura de un grupo (demostracion o descargado): el mismo flujo, con avisos de guardado, bloqueo y revocacion. */
@Composable
private fun CaptureRoute(repo: AttendanceRepository, groupId: String, keyPrefix: String, onSummary: () -> Unit, onBack: () -> Unit) {
    val vm: CaptureViewModel = viewModel(key = "$keyPrefix-$groupId", factory = factory { CaptureViewModel(repo, groupId) })
    val state by vm.state.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val text = when (message) {
        CaptureMessage.DraftNotEditable -> stringResource(R.string.capture_msg_not_editable)
        CaptureMessage.NotFound -> stringResource(R.string.capture_msg_not_found)
        CaptureMessage.SaveFailed -> stringResource(R.string.capture_msg_save_failed)
        CaptureMessage.AccessBlocked -> stringResource(R.string.capture_msg_access_blocked)
        CaptureMessage.GroupRevoked -> stringResource(R.string.capture_msg_group_revoked)
        CaptureMessage.CannotUnmark -> stringResource(R.string.capture_msg_cannot_unmark)
        null -> null
    }
    LaunchedEffect(message) {
        if (text != null) {
            snackbar.showSnackbar(text)
            vm.consumeMessage()
        }
    }
    val title = (state as? CaptureUiState.Ready)?.draft?.groupName ?: stringResource(R.string.capture_title)
    EtaScaffold(title = title, onBack = onBack, snackbarHostState = snackbar) { padding ->
        CaptureScreen(state = state, onMark = vm::setMark, onSummary = onSummary, onBack = onBack, contentPadding = padding)
    }
}
