package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import mx.edu.eta15.prefectura.R
import androidx.compose.material3.Button
import mx.edu.eta15.prefectura.domain.AccessBlock
import mx.edu.eta15.prefectura.domain.ManualSyncState
import mx.edu.eta15.prefectura.domain.SyncResultKind
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxSummary
import mx.edu.eta15.prefectura.domain.SyncInfo

private val StampFormat: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withLocale(Locale.forLanguageTag("es-MX")).withZone(ZoneId.of("America/Mazatlan"))

private fun stamp(instant: Instant): String = StampFormat.format(instant)

/**
 * Estado de la cache descargada (SANDBOX ONLY): aviso permanente de que son datos de prueba guardados solo en este dispositivo,
 * ultima descarga, fecha confirmada por el servidor y autorizacion offline. En la demostracion local no muestra nada.
 */
@Composable
fun OfflineStatusSection(access: OfflineAccess, sync: SyncInfo?) {
    if (access == OfflineAccess.NotApplicable && sync == null) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("offline-status")) {
        Surface(color = Color(0xFFFFE0B2), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                Text(stringResource(R.string.offline_banner_title), style = MaterialTheme.typography.titleMedium, color = Color(0xFF5D2E00))
                Text(stringResource(R.string.offline_banner_detail), style = MaterialTheme.typography.bodyMedium, color = Color(0xFF5D2E00))
            }
        }
        sync?.let {
            Text(stringResource(R.string.offline_last_update, stamp(it.lastDownloadAt)), modifier = Modifier.testTag("offline-last-update"))
            Text(stringResource(R.string.offline_server_date, it.serverSchoolDate.toString()), style = MaterialTheme.typography.bodyMedium)
        }
        when (access) {
            is OfflineAccess.Active -> {
                Text(
                    stringResource(R.string.offline_access_active, stamp(access.until)),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("offline-access-active"),
                )
                if (!access.dateConfirmed) {
                    InfoNotice(stringResource(R.string.offline_date_unconfirmed), Modifier.testTag("offline-date-unconfirmed"))
                }
            }
            is OfflineAccess.Blocked -> AccessBlockedNotice(access.reason)
            OfflineAccess.NotApplicable -> Unit
        }
    }
}

@Composable
private fun AccessBlockedNotice(reason: AccessBlock) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().testTag("offline-blocked-${reason.name}"),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(stringResource(blockedTitle(reason)), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            Text(stringResource(blockedDetail(reason)), color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}

/** Pantalla completa cuando una consulta escolar protegida esta bloqueada. */
@Composable
fun AccessBlockedView(reason: AccessBlock, onBack: (() -> Unit)?, modifier: Modifier = Modifier) {
    MessageView(
        title = stringResource(blockedTitle(reason)),
        detail = stringResource(blockedDetail(reason)),
        isError = true,
        modifier = modifier.testTag("offline-blocked-view-${reason.name}"),
        actions = { if (onBack != null) TextButton(onClick = onBack) { Text(stringResource(R.string.offline_blocked_back)) } },
    )
}

private fun blockedTitle(reason: AccessBlock): Int = when (reason) {
    AccessBlock.EXPIRED -> R.string.offline_blocked_expired_title
    AccessBlock.DEVICE_REVOKED -> R.string.offline_blocked_device_title
    AccessBlock.ACCOUNT_BLOCKED -> R.string.offline_blocked_account_title
    AccessBlock.CLOCK_SUSPECT -> R.string.offline_blocked_clock_title
}

private fun blockedDetail(reason: AccessBlock): Int = when (reason) {
    AccessBlock.EXPIRED -> R.string.offline_blocked_expired_detail
    AccessBlock.DEVICE_REVOKED -> R.string.offline_blocked_device_detail
    AccessBlock.ACCOUNT_BLOCKED -> R.string.offline_blocked_account_detail
    AccessBlock.CLOCK_SUSPECT -> R.string.offline_blocked_clock_detail
}

/**
 * Preparacion local para una FUTURA sincronizacion (solo perfiles descargados del servidor de pruebas). Todo lo que muestra es local:
 * nada se envia al servidor y no hay boton de envio. "Preparar" sella los cambios en una operacion guardada en este dispositivo.
 */
@Composable
fun OutboxSection(
    outbox: OutboxSummary,
    message: PrepareMessage?,
    enabled: Boolean,
    onPrepare: () -> Unit,
    modifier: Modifier = Modifier,
    /** Solo en el build de pruebas con el servidor de sandbox: estado del ciclo manual y su accion. */
    syncAvailable: Boolean = false,
    sync: ManualSyncState = ManualSyncState(),
    onSync: () -> Unit = {},
    onCancelSync: () -> Unit = {},
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = modifier.testTag("outbox-section")) {
        Text(stringResource(R.string.outbox_title), style = MaterialTheme.typography.titleMedium)
        InfoNotice(
            stringResource(if (syncAvailable) R.string.outbox_local_notice_sync else R.string.outbox_local_notice),
            Modifier.testTag("outbox-local-notice"),
        )
        Text(stringResource(R.string.outbox_marks, outbox.localMarks), modifier = Modifier.testTag("outbox-marks"))
        Text(
            stringResource(if (outbox.unsealedChanges) R.string.outbox_unsealed else R.string.outbox_all_prepared),
            modifier = Modifier.testTag(if (outbox.unsealedChanges) "outbox-unsealed" else "outbox-sealed"),
        )
        Text(stringResource(R.string.outbox_operations, outbox.preparedOperations), modifier = Modifier.testTag("outbox-operations"))
        outbox.operations.filter { !it.state.isTerminal || it.state == OperationState.ACKNOWLEDGED }.forEach { op ->
            val label = if (op.kind == OperationKind.OPEN) {
                stringResource(R.string.outbox_op_open)
            } else {
                stringResource(R.string.outbox_op_save, op.markCount)
            }
            val state = stringResource(
                when (op.state) {
                    OperationState.READY -> R.string.outbox_state_ready
                    OperationState.WAITING_REMOTE_CONTEXT -> R.string.outbox_state_waiting
                    OperationState.NEEDS_REVIEW -> R.string.outbox_state_review
                    OperationState.CONFLICT -> R.string.outbox_state_conflict
                    OperationState.AUTH_REQUIRED -> R.string.outbox_state_auth
                    OperationState.SENDING -> R.string.outbox_state_sending
                    OperationState.ACKNOWLEDGED -> R.string.outbox_state_acked
                    OperationState.RETRYABLE_ERROR -> R.string.outbox_state_retry
                    else -> R.string.outbox_state_other
                },
            )
            Text("$label: $state", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("outbox-op-${op.kind.name}-${op.state.name}"))
        }
        message?.let {
            InfoNotice(
                stringResource(
                    when (it) {
                        PrepareMessage.Prepared -> R.string.outbox_msg_prepared
                        PrepareMessage.AlreadyPrepared -> R.string.outbox_msg_already
                        PrepareMessage.NothingToPrepare -> R.string.outbox_msg_nothing
                        PrepareMessage.TooManyMarks -> R.string.outbox_msg_too_many
                        PrepareMessage.InvalidIdentifier -> R.string.outbox_msg_invalid
                        PrepareMessage.UnmarkAfterSend -> R.string.outbox_msg_unmark
                        PrepareMessage.GroupRevoked -> R.string.outbox_msg_revoked
                        PrepareMessage.AccessBlocked -> R.string.outbox_msg_blocked
                        PrepareMessage.LocalError -> R.string.outbox_msg_local_error
                        PrepareMessage.NotSandbox -> R.string.outbox_msg_not_sandbox
                        PrepareMessage.DraftNotFound -> R.string.outbox_msg_not_found
                    },
                ),
                Modifier.testTag("outbox-message"),
            )
        }
        OutlinedButton(
            onClick = onPrepare,
            enabled = enabled && outbox.unsealedChanges && !sync.running,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("outbox-prepare"),
        ) { Text(stringResource(R.string.outbox_prepare)) }
        if (syncAvailable) {
            sync.last?.let { report ->
                InfoNotice(
                    stringResource(
                        when (report.kind) {
                            SyncResultKind.CONFIRMED -> R.string.outbox_sync_confirmed
                            SyncResultKind.NOTHING_TO_SEND -> R.string.outbox_sync_nothing
                            SyncResultKind.OFFLINE -> R.string.outbox_sync_offline
                            SyncResultKind.SESSION_REQUIRED -> R.string.outbox_sync_session
                            SyncResultKind.TEMPORARY_ERROR -> R.string.outbox_sync_temporary
                            SyncResultKind.CONFLICT -> R.string.outbox_sync_conflict
                            SyncResultKind.NEEDS_REVIEW -> R.string.outbox_sync_review
                            SyncResultKind.RESULT_UNKNOWN -> R.string.outbox_sync_unknown
                            SyncResultKind.NOT_ENABLED -> R.string.outbox_sync_not_enabled
                            SyncResultKind.CANCELLED -> R.string.outbox_sync_cancelled
                            SyncResultKind.NOT_ALLOWED -> R.string.outbox_sync_not_allowed
                        },
                    ),
                    Modifier.testTag("outbox-sync-result-" + report.kind.name),
                )
            }
            if (sync.running) {
                InfoNotice(stringResource(R.string.outbox_sync_running), Modifier.testTag("outbox-sync-running"))
                OutlinedButton(
                    onClick = onCancelSync,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("outbox-sync-cancel"),
                ) { Text(stringResource(R.string.outbox_sync_cancel)) }
            }
            Button(
                onClick = onSync,
                enabled = enabled && !sync.running,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("outbox-sync-now"),
            ) { Text(stringResource(R.string.outbox_sync_now)) }
        }
    }
}
