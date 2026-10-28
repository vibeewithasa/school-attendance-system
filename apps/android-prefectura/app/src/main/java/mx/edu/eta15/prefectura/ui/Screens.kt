package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import mx.edu.eta15.prefectura.BuildConfig
import mx.edu.eta15.prefectura.R
import mx.edu.eta15.prefectura.dev.DevHealthCheck
import mx.edu.eta15.prefectura.dev.HealthResult
import mx.edu.eta15.prefectura.domain.Group
import mx.edu.eta15.prefectura.domain.Student
import mx.edu.eta15.prefectura.mobile.MobileFeature

private val ScreenPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)

// ============================== Inicio ==============================

@Composable
fun HomeScreen(
    state: HomeUiState,
    onGroups: () -> Unit,
    onConnectivity: () -> Unit,
    contentPadding: PaddingValues,
    onMobile: () -> Unit = {},
) {
    Column(
        Modifier
            .padding(contentPadding)
            .padding(ScreenPadding)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        BrandMarkPlaceholder()
        Text(stringResource(R.string.home_title), style = MaterialTheme.typography.headlineMedium)
        Text(stringResource(R.string.home_subtitle), style = MaterialTheme.typography.bodyLarge)

        val profile = state.profile
        if (profile != null) {
            Text(
                stringResource(R.string.home_profile, profile.displayName),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.testTag("home-profile"),
            )
        } else {
            InfoNotice(stringResource(R.string.home_no_session))
        }

        state.date?.let { date ->
            Text(
                stringResource(
                    if (BuildConfig.DEMO_MODE) R.string.home_date_demo else R.string.home_date_device,
                    formatSchoolDate(date),
                ),
                style = MaterialTheme.typography.bodyLarge,
            )
            if (!state.isSchoolDay) InfoNotice(stringResource(R.string.weekend_notice))
        }

        InfoNotice(stringResource(R.string.home_local_notice))

        Button(
            onClick = onGroups,
            enabled = profile != null,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .testTag("home-groups"),
        ) { Text(stringResource(R.string.home_button_groups)) }
        OutlinedButton(
            onClick = onConnectivity,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .testTag("home-connectivity"),
        ) { Text(stringResource(R.string.home_button_connectivity)) }
        if (MobileFeature.AVAILABLE) MobileFeature.HomeEntry(onMobile)
    }
}

// ============================== Grupos ==============================

@Composable
fun GroupsScreen(state: GroupsUiState, onOpenGroup: (String) -> Unit, contentPadding: PaddingValues) {
    when {
        state.loading -> LoadingView(Modifier.padding(contentPadding))
        state.error -> MessageView(
            title = stringResource(R.string.groups_error),
            detail = stringResource(R.string.error_local_detail),
            isError = true,
            modifier = Modifier.padding(contentPadding),
        )
        state.groups.isEmpty() -> MessageView(
            title = stringResource(R.string.groups_empty_title),
            detail = stringResource(R.string.groups_empty_detail),
            modifier = Modifier.padding(contentPadding),
        )
        else -> LazyColumn(
            modifier = Modifier.padding(contentPadding),
            contentPadding = ScreenPadding,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { OfflineStatusSection(state.access, state.sync) }
            if (!state.isSchoolDay) item { InfoNotice(stringResource(R.string.weekend_notice)) }
            items(state.groups, key = { it.id }) { group -> GroupCard(group) { onOpenGroup(group.id) } }
        }
    }
}

@Composable
private fun GroupCard(group: Group, onClick: () -> Unit) {
    val students = pluralStringResource(R.plurals.students_count, group.studentCount, group.studentCount)
    val progress = when {
        !group.hasDraftToday -> stringResource(R.string.group_no_draft)
        else -> stringResource(R.string.group_progress, group.markedToday, group.studentCount)
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .clickable(onClick = onClick)
            .testTag("group-${group.id}")
            .semantics(mergeDescendants = true) { contentDescription = "${group.name}. $students. $progress" },
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(group.name, style = MaterialTheme.typography.titleLarge)
            Text(students, style = MaterialTheme.typography.bodyMedium)
            Text(progress, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            if (group.hasDraftToday && group.studentCount > 0) {
                LinearProgressIndicator(
                    progress = { group.markedToday.toFloat() / group.studentCount },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (group.revoked) {
                Text(
                    stringResource(R.string.offline_group_revoked_chip),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.testTag("group-revoked-${group.id}"),
                )
            }
            if (group.needsReview) {
                Text(
                    stringResource(R.string.offline_needs_review_chip),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.testTag("group-review-${group.id}"),
                )
            }
        }
    }
}

// ============================== Padron ==============================

@Composable
fun RosterScreen(state: RosterUiState, onCapture: () -> Unit, contentPadding: PaddingValues) {
    when {
        state.loading -> LoadingView(Modifier.padding(contentPadding))
        state.error -> MessageView(
            title = stringResource(R.string.roster_error),
            detail = stringResource(R.string.error_local_detail),
            isError = true,
            modifier = Modifier.padding(contentPadding),
        )
        state.groupName == null -> MessageView(
            title = stringResource(R.string.group_not_found),
            modifier = Modifier.padding(contentPadding),
        )
        state.access is mx.edu.eta15.prefectura.domain.OfflineAccess.Blocked ->
            AccessBlockedView(state.access.reason, onBack = null, modifier = Modifier.padding(contentPadding))
        else -> Column(Modifier.padding(contentPadding)) {
            Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    pluralStringResource(R.plurals.students_count, state.students.size, state.students.size),
                    style = MaterialTheme.typography.titleMedium,
                )
                Button(
                    onClick = onCapture,
                    enabled = state.isSchoolDay && state.students.isNotEmpty(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .testTag("roster-capture"),
                ) { Text(stringResource(R.string.roster_capture_button)) }
                if (!state.isSchoolDay) Text(stringResource(R.string.weekend_notice), style = MaterialTheme.typography.bodyMedium)
                if (state.students.isEmpty()) Text(stringResource(R.string.roster_empty), style = MaterialTheme.typography.bodyMedium)
            }
            HorizontalDivider()
            LazyColumn(contentPadding = PaddingValues(vertical = 4.dp)) {
                items(state.students, key = { it.id }) { StudentLine(it) }
            }
        }
    }
}

@Composable
private fun StudentLine(student: Student) {
    Text(
        student.displayName,
        style = MaterialTheme.typography.bodyLarge,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    )
}

// ============================== Conectividad ==============================

@Composable
fun ConnectivityScreen(
    state: ConnectivityUiState,
    onCheckHealth: () -> Unit,
    onResetDemo: () -> Unit,
    contentPadding: PaddingValues,
) {
    var confirmReset by remember { mutableStateOf(false) }
    Column(
        Modifier
            .padding(contentPadding)
            .padding(ScreenPadding)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.sync_status_title), style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(R.string.sync_status_value),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.testTag("sync-status"),
                )
                Text(stringResource(R.string.sync_status_detail), style = MaterialTheme.typography.bodyMedium)
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.network_title), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(if (state.online) R.string.network_online else R.string.network_offline),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.testTag("network-state"),
            )
            Text(stringResource(R.string.network_note), style = MaterialTheme.typography.bodyMedium)
        }

        InfoNotice(stringResource(R.string.connectivity_local_guarantee))

        HorizontalDivider()
        EncryptionSection(state.encryption)

        if (DevHealthCheck.AVAILABLE) {
            HorizontalDivider()
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.dev_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.dev_note), style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(
                    onClick = onCheckHealth,
                    enabled = !state.checkingHealth,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .testTag("dev-health"),
                ) { Text(stringResource(if (state.checkingHealth) R.string.dev_checking else R.string.dev_check)) }
                state.health?.let {
                    Text(healthText(it), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("dev-health-result"))
                }
            }
        }

        if (BuildConfig.DEMO_MODE) {
            HorizontalDivider()
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.reset_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.reset_detail), style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(
                    onClick = { confirmReset = true },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .testTag("reset-demo"),
                ) { Text(stringResource(R.string.reset_button)) }
            }
        }
    }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text(stringResource(R.string.reset_confirm_title)) },
            text = { Text(stringResource(R.string.reset_confirm_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    onResetDemo()
                }) { Text(stringResource(R.string.reset_confirm_yes)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmReset = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

@Composable
private fun healthText(result: HealthResult): String = when (result) {
    HealthResult.Responding -> stringResource(R.string.dev_result_ok)
    HealthResult.Unreachable -> stringResource(R.string.dev_result_down)
    is HealthResult.UnexpectedStatus -> stringResource(R.string.dev_result_status, result.code)
    HealthResult.NotAvailable -> stringResource(R.string.dev_result_na)
}
