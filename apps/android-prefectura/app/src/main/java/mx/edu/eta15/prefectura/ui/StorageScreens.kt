package mx.edu.eta15.prefectura.ui

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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import mx.edu.eta15.prefectura.BuildConfig
import mx.edu.eta15.prefectura.R
import mx.edu.eta15.prefectura.data.secure.StorageException

/**
 * Pantalla de FALLO CERRADO: el almacenamiento protegido no se pudo abrir. No hay datos, no se creo una base vacia y no se
 * borro nada. Solo se puede reintentar; el reinicio destructivo existe unicamente en debug (datos de demostracion) y pide
 * confirmacion.
 */
@Composable
fun StorageFailureScreen(
    error: StorageException,
    onRetry: () -> Unit,
    onWipeDemo: () -> Unit,
    contentPadding: PaddingValues,
) {
    var confirm by remember { mutableStateOf(false) }
    Column(
        Modifier
            .padding(contentPadding)
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            stringResource(R.string.storage_failed_title),
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.testTag("storage-failed-title"),
        )
        Text(stringResource(failureReason(error)), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("storage-failed-reason"))
        InfoNotice(stringResource(R.string.storage_failed_guarantee))
        Button(
            onClick = onRetry,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .testTag("storage-retry"),
        ) { Text(stringResource(R.string.storage_retry)) }

        if (BuildConfig.DEMO_MODE) {
            HorizontalDivider()
            Text(stringResource(R.string.storage_wipe_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.storage_wipe_detail), style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(
                onClick = { confirm = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .testTag("storage-wipe"),
            ) { Text(stringResource(R.string.storage_wipe_button)) }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.storage_wipe_confirm_title)) },
            text = { Text(stringResource(R.string.storage_wipe_confirm_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    onWipeDemo()
                }) { Text(stringResource(R.string.storage_wipe_confirm_yes)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

private fun failureReason(error: StorageException): Int = when (error) {
    is StorageException.KeyMissing -> R.string.storage_reason_key_missing
    is StorageException.KeyInvalidated -> R.string.storage_reason_key_invalidated
    is StorageException.KeyCorrupt -> R.string.storage_reason_key_corrupt
    is StorageException.KeystoreUnavailable -> R.string.storage_reason_keystore
    is StorageException.DatabaseUnreadable -> R.string.storage_reason_unreadable
    is StorageException.UnknownLegacyFormat -> R.string.storage_reason_legacy_unknown
    is StorageException.ConversionFailed -> R.string.storage_reason_conversion
}

/** Estado del cifrado y aviso de licencia de SQLCipher (la licencia BSD exige mostrarlo en un lugar accesible). */
@Composable
fun EncryptionSection(encryption: String?) {
    var showLicense by remember { mutableStateOf(false) }
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.encryption_title), style = MaterialTheme.typography.titleMedium)
        Text(
            if (encryption != null) stringResource(R.string.encryption_active, encryption) else stringResource(R.string.encryption_inactive),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.testTag("encryption-status"),
        )
        Text(stringResource(R.string.encryption_caveat), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.license_notice), style = MaterialTheme.typography.labelMedium)
        OutlinedButton(
            onClick = { showLicense = !showLicense },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .testTag("license-toggle"),
        ) { Text(stringResource(if (showLicense) R.string.license_hide else R.string.license_show)) }
        if (showLicense) {
            val text = remember {
                context.resources.openRawResource(R.raw.license_sqlcipher).bufferedReader().use { it.readText() }
            }
            Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("license-text"))
        }
    }
}
