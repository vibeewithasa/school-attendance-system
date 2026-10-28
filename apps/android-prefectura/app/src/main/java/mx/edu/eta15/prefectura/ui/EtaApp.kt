package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHostState
import androidx.compose.ui.Modifier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
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
            val vm: CaptureViewModel = viewModel(key = "capture-$groupId", factory = factory { CaptureViewModel(repo, groupId) })
            val state by vm.state.collectAsStateWithLifecycle()
            val message by vm.message.collectAsStateWithLifecycle()
            val snackbar = remember { SnackbarHostState() }
            val text = when (message) {
                CaptureMessage.DraftNotEditable -> stringResource(R.string.capture_msg_not_editable)
                CaptureMessage.NotFound -> stringResource(R.string.capture_msg_not_found)
                CaptureMessage.SaveFailed -> stringResource(R.string.capture_msg_save_failed)
                null -> null
            }
            LaunchedEffect(message) {
                if (text != null) {
                    snackbar.showSnackbar(text)
                    vm.consumeMessage()
                }
            }
            val title = (state as? CaptureUiState.Ready)?.draft?.groupName ?: stringResource(R.string.capture_title)
            EtaScaffold(title = title, onBack = { navController.popBackStack() }, snackbarHostState = snackbar) { padding ->
                CaptureScreen(
                    state = state,
                    onMark = vm::setMark,
                    onSummary = { navController.navigate(Routes.summary(groupId)) },
                    onBack = { navController.popBackStack() },
                    contentPadding = padding,
                )
            }
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
            composable(Routes.MOBILE) { MobileFeature.Screen(onBack = { navController.popBackStack() }) }
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
