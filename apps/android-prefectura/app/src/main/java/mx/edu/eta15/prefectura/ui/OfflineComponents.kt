package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
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
import mx.edu.eta15.prefectura.domain.AccessBlock
import mx.edu.eta15.prefectura.domain.OfflineAccess
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
