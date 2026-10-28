package mx.edu.eta15.prefectura.mobile

import android.content.Context
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import mx.edu.eta15.prefectura.BuildConfig
import mx.edu.eta15.prefectura.R
import mx.edu.eta15.prefectura.data.OfflineSink
import mx.edu.eta15.prefectura.data.SandboxIds
import mx.edu.eta15.prefectura.ui.EtaScaffold
import mx.edu.eta15.prefectura.ui.InfoNotice

/**
 * SOLO debug (en release existe un objeto con el mismo nombre que no incluye nada de esto). Punto de entrada de la vinculacion
 * experimental del dispositivo con el servidor de PRUEBAS. Nada de lo que hay aqui esta aprobado para uso real (ADR 0005).
 */
object MobileFeature {
    const val AVAILABLE = true

    /**
     * Sincronizacion MANUAL de asistencia de un perfil descargado (SANDBOX). Solo existe si el dispositivo esta vinculado, su clave
     * sigue en el Keystore y el perfil es el de ESE dispositivo (la identidad sale del registro local, no de la interfaz).
     */
    fun manualSync(
        context: Context,
        db: mx.edu.eta15.prefectura.data.local.EtaDatabase,
        clock: java.time.Clock,
        ids: mx.edu.eta15.prefectura.domain.IdGenerator,
        profileId: String,
        policy: mx.edu.eta15.prefectura.domain.OfflinePolicy,
        scope: kotlinx.coroutines.CoroutineScope,
    ): mx.edu.eta15.prefectura.domain.ManualSync {
        val linkStore = FileLinkStore(context.applicationContext.noBackupFilesDir)
        val deviceId = linkStore.load()?.deviceId ?: return mx.edu.eta15.prefectura.domain.NoManualSync
        if (SandboxIds.profile(deviceId) != profileId) return mx.edu.eta15.prefectura.domain.NoManualSync
        val key = AndroidDeviceKey()
        val jwk = try {
            if (!key.exists()) return mx.edu.eta15.prefectura.domain.NoManualSync
            key.publicJwk()
        } catch (_: DeviceKeyException) {
            return mx.edu.eta15.prefectura.domain.NoManualSync
        }
        val repo = mx.edu.eta15.prefectura.data.LocalAttendanceRepository(
            db, profileId, clock, ids,
            access = mx.edu.eta15.prefectura.data.ProfileAccessGate(db, profileId, clock, policy),
        )
        val http = HttpMobileApi(BuildConfig.MOBILE_BASE_URL, DpopProofBuilder(jwk, key::signDer), jwk)
        val store = RoomSyncStore(
            store = mx.edu.eta15.prefectura.data.OutboxStore(db, clock, ids),
            profileId = profileId,
            deviceId = deviceId,
            cache = mx.edu.eta15.prefectura.data.OfflineCacheStore(db, clock, policy),
            schoolToday = repo::schoolToday,
            prepare = { draftId -> repo.prepareForSync(draftId) },
        )
        val identity = SyncIdentity { linkStore.load()?.deviceId?.takeIf { runCatching { key.exists() }.getOrDefault(false) } }
        return DebugManualSync(scope, ManualSyncEngine(profileId, store, http, DeviceSyncSessions(http, clock), identity))
    }

    @Composable
    fun HomeEntry(onOpen: () -> Unit) {
        OutlinedButton(
            onClick = onOpen,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .testTag("home-mobile"),
        ) { Text(stringResource(R.string.mobile_home_button)) }
    }

    /** Perfil local de la cache descargada de ESTE dispositivo vinculado (`null` si aun no hay identificador de dispositivo). */
    fun sandboxProfileId(context: Context): String? =
        FileLinkStore(context.applicationContext.noBackupFilesDir).load()?.deviceId?.let(SandboxIds::profile)

    @Composable
    fun Screen(onBack: () -> Unit, cache: OfflineSink? = null, onOpenOffline: () -> Unit = {}) {
        val context = LocalContext.current.applicationContext
        val vm: MobileLinkViewModel = viewModel(factory = viewModelFactory { initializer { MobileLinkViewModel(context, cache) } })
        val state by vm.controller.state.collectAsStateWithLifecycle()
        DisposableEffect(vm) {
            vm.controller.start()
            onDispose { vm.controller.stop() }
        }
        EtaScaffold(title = stringResource(R.string.mobile_title), onBack = onBack) { padding ->
            MobileLinkScreen(state, vm.controller, padding, onOpenOffline)
        }
    }
}

class MobileLinkViewModel(context: Context, cache: OfflineSink? = null) : ViewModel() {
    val controller: MobileLinkController

    init {
        val key = AndroidDeviceKey()
        controller = MobileLinkController(
            key = key,
            store = FileLinkStore(context.noBackupFilesDir),
            apiFor = { jwk -> HttpMobileApi(BuildConfig.MOBILE_BASE_URL, DpopProofBuilder(jwk, key::signDer), jwk) },
            scope = viewModelScope,
            cache = cache,
        )
    }

    override fun onCleared() {
        controller.stop()
    }
}

private val ScreenPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)
private val Mono = FontFamily.Monospace

/** Contenido de la pantalla; recibe el estado y el controlador para poder probarse con controladores falsos. */
@Composable
fun MobileLinkScreen(
    state: MobileUiState,
    controller: MobileLinkController,
    contentPadding: PaddingValues,
    onOpenOffline: () -> Unit = {},
) {
    Column(
        Modifier
            .padding(contentPadding)
            .padding(ScreenPadding)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        TestEnvironmentBanner()
        InfoNotice(stringResource(R.string.mobile_separate_notice))
        state.issue?.let { IssueNotice(it) }
        when (state.stage) {
            Stage.LOADING -> Text(stringResource(R.string.mobile_loading))
            Stage.NOT_LINKED -> NotLinked(state, controller)
            Stage.KEY_LOST -> KeyLost(controller)
            Stage.PAIRING -> Pairing(state, controller)
            Stage.LINKED -> Linked(state, controller, onOpenOffline)
        }
    }
}

@Composable
fun TestEnvironmentBanner() {
    Surface(color = Color(0xFFFFE0B2), modifier = Modifier.fillMaxWidth().testTag("mobile-banner")) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
            Text(
                stringResource(R.string.mobile_banner_title),
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF5D2E00),
            )
            Text(
                stringResource(R.string.mobile_banner_detail),
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF5D2E00),
            )
        }
    }
}

@Composable
private fun IssueNotice(issue: LinkIssue) {
    val text = stringResource(
        when (issue) {
            LinkIssue.NETWORK -> R.string.mobile_issue_network
            LinkIssue.UNAVAILABLE -> R.string.mobile_issue_unavailable
            LinkIssue.RATE_LIMITED -> R.string.mobile_issue_rate
            LinkIssue.REQUEST_EXPIRED -> R.string.mobile_issue_expired
            LinkIssue.REQUEST_CLOSED -> R.string.mobile_issue_closed
            LinkIssue.KEY_ALREADY_REGISTERED -> R.string.mobile_issue_key_registered
            LinkIssue.NOT_ELIGIBLE -> R.string.mobile_issue_not_eligible
            LinkIssue.DEVICE_REVOKED -> R.string.mobile_issue_revoked
            LinkIssue.SESSION_ENDED -> R.string.mobile_issue_session_ended
            LinkIssue.KEY_ERROR -> R.string.mobile_issue_key
            LinkIssue.UNEXPECTED -> R.string.mobile_issue_unexpected
        },
    )
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().testTag("mobile-issue"),
    ) {
        Text(text, color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.padding(12.dp))
    }
}

@Composable
private fun NotLinked(state: MobileUiState, controller: MobileLinkController) {
    var label by remember { mutableStateOf(Build.MODEL.take(60).ifBlank { "Dispositivo de pruebas" }) }
    Text(stringResource(R.string.mobile_unlinked_title), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.mobile_unlinked_detail))
    if (state.fingerprint != null) {
        Text(stringResource(R.string.mobile_key_present))
        Fingerprint(state.fingerprint)
    }
    OutlinedTextField(
        value = label,
        onValueChange = { label = it.take(60) },
        label = { Text(stringResource(R.string.mobile_label_field)) },
        singleLine = true,
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth().testTag("mobile-label"),
    )
    Button(
        onClick = { controller.startLinking(label.trim()) },
        enabled = !state.busy && label.isNotBlank(),
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("mobile-start"),
    ) { Text(stringResource(R.string.mobile_start)) }
    if (state.fingerprint != null) ForgetButton(controller, enabled = !state.busy)
}

@Composable
private fun Fingerprint(value: String) {
    Column {
        Text(stringResource(R.string.mobile_fingerprint_label), style = MaterialTheme.typography.labelLarge)
        Text(value, style = MaterialTheme.typography.headlineSmall, fontFamily = Mono, modifier = Modifier.testTag("mobile-fingerprint"))
    }
}

@Composable
private fun Pairing(state: MobileUiState, controller: MobileLinkController) {
    val pairing = state.pairing ?: return
    Text(stringResource(R.string.mobile_pairing_title), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.mobile_pairing_steps))
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.mobile_request_label), style = MaterialTheme.typography.labelLarge)
            Text(pairing.requestId, fontFamily = Mono, modifier = Modifier.testTag("mobile-request-id"))
            Text(stringResource(R.string.mobile_code_label), style = MaterialTheme.typography.labelLarge)
            if (pairing.pairingCode != null) {
                Text(
                    pairing.pairingCode,
                    style = MaterialTheme.typography.headlineMedium,
                    fontFamily = Mono,
                    modifier = Modifier.testTag("mobile-pairing-code"),
                )
            } else {
                Text(stringResource(R.string.mobile_code_lost))
            }
            Fingerprint(pairing.fingerprint)
        }
    }
    Text(
        when (pairing.status) {
            "claimed" ->
                if (pairing.claimedBy != null) stringResource(R.string.mobile_status_claimed, pairing.claimedBy)
                else stringResource(R.string.mobile_status_claimed_unknown)
            "approved" -> stringResource(R.string.mobile_status_approved)
            else -> stringResource(R.string.mobile_status_pending)
        },
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.testTag("mobile-pairing-status"),
    )
    OutlinedButton(
        onClick = controller::cancelLinking,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("mobile-cancel"),
    ) { Text(stringResource(R.string.mobile_cancel)) }
}

@Composable
private fun KeyLost(controller: MobileLinkController) {
    Text(stringResource(R.string.mobile_key_lost_title), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.mobile_key_lost_detail))
    ForgetButton(controller, enabled = true)
}

@Composable
private fun Linked(state: MobileUiState, controller: MobileLinkController, onOpenOffline: () -> Unit) {
    Text(stringResource(R.string.mobile_linked_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("mobile-linked"))
    Text(if (state.owner != null) stringResource(R.string.mobile_owner, state.owner) else stringResource(R.string.mobile_owner_unknown))
    state.label?.let { Text(stringResource(R.string.mobile_device_label, it)) }
    state.deviceId?.let { Text(stringResource(R.string.mobile_device_id, it.take(8)), fontFamily = Mono) }
    state.fingerprint?.let { Fingerprint(it) }
    Text(
        stringResource(
            when (state.protection) {
                KeyProtection.STRONGBOX -> R.string.mobile_protection_strongbox
                KeyProtection.TRUSTED_ENVIRONMENT -> R.string.mobile_protection_tee
                KeyProtection.SOFTWARE -> R.string.mobile_protection_software
                else -> R.string.mobile_protection_unknown
            },
        ),
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.testTag("mobile-protection"),
    )
    HorizontalDivider()
    val session = state.session
    if (session == null) {
        Text(stringResource(R.string.mobile_session_none), modifier = Modifier.testTag("mobile-session-status"))
        Button(
            onClick = controller::openSession,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("mobile-open-session"),
        ) { Text(stringResource(R.string.mobile_open_session)) }
    } else {
        Text(
            stringResource(R.string.mobile_session_open, formatTime(session.sessionExpiresAt)),
            modifier = Modifier.testTag("mobile-session-status"),
        )
        Button(
            onClick = controller::loadGroups,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("mobile-load-groups"),
        ) { Text(stringResource(R.string.mobile_load_groups)) }
        OutlinedButton(
            onClick = controller::closeSession,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("mobile-close-session"),
        ) { Text(stringResource(R.string.mobile_close_session)) }
    }
    if (session != null) {
        // Descarga autorizada hacia la cache CIFRADA: solo mis grupos y el padron de cada uno (nada de grupos ajenos).
        Button(
            onClick = controller::downloadAuthorized,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("mobile-download"),
        ) { Text(stringResource(R.string.mobile_download_button)) }
    }
    DownloadStatus(state)
    OutlinedButton(
        onClick = onOpenOffline,
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("mobile-open-offline"),
    ) { Text(stringResource(R.string.mobile_open_offline_button)) }
    state.groups?.let { groups ->
        Text(stringResource(R.string.mobile_groups_title), style = MaterialTheme.typography.titleMedium)
        InfoNotice(stringResource(R.string.mobile_readonly_notice))
        if (groups.isEmpty()) Text(stringResource(R.string.mobile_groups_empty))
        groups.forEach { g ->
            OutlinedButton(
                onClick = { controller.loadRoster(g.groupId) },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("mobile-group-${g.label}"),
            ) { Text(g.label) }
        }
    }
    state.roster?.let { roster ->
        Text(stringResource(R.string.mobile_roster_title, roster.groupLabel), style = MaterialTheme.typography.titleMedium)
        if (roster.students.isEmpty()) Text(stringResource(R.string.mobile_roster_empty), modifier = Modifier.testTag("mobile-roster-empty"))
        roster.students.forEach { Text(it.name, modifier = Modifier.testTag("mobile-student")) }
        TextButton(onClick = controller::closeRoster) { Text(stringResource(R.string.mobile_roster_close)) }
    }
    HorizontalDivider()
    PurgeButton(controller, enabled = !state.busy)
    ForgetButton(controller, enabled = !state.busy)
}

@Composable
private fun PurgeButton(controller: MobileLinkController, enabled: Boolean) {
    var confirm by remember { mutableStateOf(false) }
    OutlinedButton(
        onClick = { confirm = true },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("mobile-purge"),
    ) { Text(stringResource(R.string.mobile_purge_button)) }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.mobile_purge_title)) },
            text = { Text(stringResource(R.string.mobile_purge_text)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        controller.purgeCache()
                    },
                    modifier = Modifier.testTag("mobile-purge-confirm"),
                ) { Text(stringResource(R.string.mobile_purge_yes)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@Composable
private fun DownloadStatus(state: MobileUiState) {
    val text = when (val d = state.download) {
        null -> if (state.busy) stringResource(R.string.mobile_download_busy) else stringResource(R.string.mobile_download_none)
        is DownloadOutcome.Complete -> stringResource(R.string.mobile_download_ok, d.groups, d.revoked)
        DownloadOutcome.Incomplete -> stringResource(R.string.mobile_download_incomplete)
        DownloadOutcome.Invalid -> stringResource(R.string.mobile_download_invalid)
        is DownloadOutcome.Blocked -> stringResource(R.string.mobile_download_incomplete)
        DownloadOutcome.NoDevice -> stringResource(R.string.mobile_download_incomplete)
    }
    Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("mobile-download-status"))
}

@Composable
private fun ForgetButton(controller: MobileLinkController, enabled: Boolean) {
    var confirm by remember { mutableStateOf(false) }
    OutlinedButton(
        onClick = { confirm = true },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("mobile-forget"),
    ) { Text(stringResource(R.string.mobile_forget)) }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.mobile_forget_title)) },
            text = { Text(stringResource(R.string.mobile_forget_text)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        controller.forgetDevice()
                    },
                    modifier = Modifier.testTag("mobile-forget-confirm"),
                ) { Text(stringResource(R.string.mobile_forget_yes)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

private val TimeFormat: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.forLanguageTag("es-MX")).withZone(ZoneId.of("America/Mazatlan"))

private fun formatTime(instant: java.time.Instant): String = TimeFormat.format(instant)
