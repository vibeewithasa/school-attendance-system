package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import android.content.res.Configuration
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import mx.edu.eta15.prefectura.R
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.CaptureRow
import mx.edu.eta15.prefectura.domain.DraftState
import mx.edu.eta15.prefectura.domain.DraftSummary

// ============================== Captura ==============================

@Composable
fun CaptureScreen(
    state: CaptureUiState,
    onMark: (draftId: String, studentId: String, mark: AttendanceMark?) -> Unit,
    onSummary: () -> Unit,
    onBack: () -> Unit,
    contentPadding: PaddingValues,
) {
    when (state) {
        CaptureUiState.Loading -> LoadingView(Modifier.padding(contentPadding))
        CaptureUiState.Error -> MessageView(
            title = stringResource(R.string.capture_error),
            detail = stringResource(R.string.error_local_detail),
            isError = true,
            modifier = Modifier.padding(contentPadding),
            actions = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        )
        CaptureUiState.GroupNotFound -> MessageView(
            title = stringResource(R.string.group_not_found),
            modifier = Modifier.padding(contentPadding),
            actions = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        )
        CaptureUiState.EmptyRoster -> MessageView(
            title = stringResource(R.string.capture_empty_roster),
            detail = stringResource(R.string.capture_empty_roster_detail),
            modifier = Modifier.padding(contentPadding),
            actions = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        )
        is CaptureUiState.NotSchoolDay -> MessageView(
            title = stringResource(R.string.capture_not_school_day),
            detail = stringResource(R.string.weekend_notice),
            modifier = Modifier.padding(contentPadding),
            actions = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        )
        is CaptureUiState.Blocked -> AccessBlockedView(state.reason, onBack, Modifier.padding(contentPadding))
        CaptureUiState.GroupRevoked -> MessageView(
            title = stringResource(R.string.offline_group_revoked_title),
            detail = stringResource(R.string.offline_group_revoked_detail),
            isError = true,
            modifier = Modifier.padding(contentPadding),
            actions = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        )
        is CaptureUiState.Ready -> CaptureContent(state.draft, onMark, onSummary, contentPadding)
    }
}

@Composable
private fun CaptureContent(
    draft: DraftState,
    onMark: (String, String, AttendanceMark?) -> Unit,
    onSummary: () -> Unit,
    contentPadding: PaddingValues,
) {
    val summary = draft.summary
    // En horizontal la lista necesita todo el alto: el boton va al final de la lista en vez de una barra fija.
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val summaryButton: @Composable (Modifier) -> Unit = { modifier ->
        Button(
            onClick = onSummary,
            modifier = modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .testTag("capture-summary"),
        ) { Text(stringResource(R.string.capture_summary_button)) }
    }
    Column(Modifier.padding(contentPadding)) {
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // El encabezado se desplaza con la lista: en pantallas pequenas o en horizontal no le quita espacio a la captura.
            item(key = "header") {
                Column {
                    CaptureHeader(draft, summary)
                    HorizontalDivider()
                }
            }
            items(draft.rows, key = { it.student.id }) { row ->
                StudentCaptureRow(row) { mark -> onMark(draft.draftId, row.student.id, mark) }
                HorizontalDivider()
            }
            if (landscape) item(key = "summary") { summaryButton(Modifier.padding(vertical = 8.dp)) }
        }
        if (!landscape) {
            Surface(tonalElevation = 3.dp) { summaryButton(Modifier.padding(16.dp)) }
        }
    }
}
@Composable
private fun CaptureHeader(draft: DraftState, summary: DraftSummary) {
    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(R.string.capture_date_label, formatSchoolDate(draft.schoolDate)),
            style = MaterialTheme.typography.bodyMedium,
        )
        LocalSaveBadge(Modifier.testTag("saved-locally-badge"))
        if (draft.needsReview) InfoNotice(stringResource(R.string.offline_review_notice), Modifier.testTag("draft-needs-review"))
        val progressText = stringResource(R.string.capture_progress, summary.marked, summary.total)
        // Region viva: los lectores de pantalla anuncian los cambios de conteo sin mover el foco.
        Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
            Text(progressText, style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("capture-progress"))
            Text(
                stringResource(R.string.capture_counts, summary.present, summary.absent, summary.pending),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("capture-counts"),
            )
        }
        LinearProgressIndicator(progress = { summary.progress }, modifier = Modifier.fillMaxWidth())
        Text(stringResource(R.string.capture_local_notice), style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun StudentCaptureRow(row: CaptureRow, onMark: (AttendanceMark?) -> Unit) {
    val name = row.student.displayName
    val stateText = when (row.mark) {
        AttendanceMark.PRESENT -> stringResource(R.string.mark_present)
        AttendanceMark.ABSENT -> stringResource(R.string.mark_absent)
        null -> stringResource(R.string.mark_pending)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .testTag("row-${row.student.id}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            name,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.semantics { contentDescription = "$name. $stateText" },
        )
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                SegmentedButton(
                    selected = row.mark == AttendanceMark.PRESENT,
                    onClick = { onMark(AttendanceMark.PRESENT) },
                    shape = SegmentedButtonDefaults.itemShape(0, 2),
                    colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = MaterialTheme.colorScheme.tertiaryContainer,
                        activeContentColor = MaterialTheme.colorScheme.onTertiaryContainer,
                    ),
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("present-${row.student.id}"),
                    label = { Text(stringResource(R.string.mark_present)) },
                )
                SegmentedButton(
                    selected = row.mark == AttendanceMark.ABSENT,
                    onClick = { onMark(AttendanceMark.ABSENT) },
                    shape = SegmentedButtonDefaults.itemShape(1, 2),
                    colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = MaterialTheme.colorScheme.errorContainer,
                        activeContentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("absent-${row.student.id}"),
                    label = { Text(stringResource(R.string.mark_absent)) },
                )
            }
            if (row.mark != null) {
                TextButton(
                    onClick = { onMark(null) },
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("clear-${row.student.id}"),
                ) { Text(stringResource(R.string.capture_clear)) }
            }
        }
    }
}

// ============================== Resumen ==============================

@Composable
fun SummaryScreen(state: SummaryUiState, onContinue: () -> Unit, contentPadding: PaddingValues) {
    when (state) {
        SummaryUiState.Loading -> LoadingView(Modifier.padding(contentPadding))
        SummaryUiState.Error -> MessageView(
            title = stringResource(R.string.summary_error),
            detail = stringResource(R.string.error_local_detail),
            isError = true,
            modifier = Modifier.padding(contentPadding),
        )
        SummaryUiState.NoDraft -> MessageView(
            title = stringResource(R.string.summary_no_draft),
            detail = stringResource(R.string.summary_no_draft_detail),
            modifier = Modifier.padding(contentPadding),
            actions = { TextButton(onClick = onContinue) { Text(stringResource(R.string.action_back)) } },
        )
        is SummaryUiState.Ready -> SummaryContent(state.draft, onContinue, contentPadding)
    }
}

@Composable
private fun SummaryContent(draft: DraftState, onContinue: () -> Unit, contentPadding: PaddingValues) {
    val s = draft.summary
    val pendingRows = draft.rows.filter { it.mark == null }
    LazyColumn(
        modifier = Modifier.padding(contentPadding),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(draft.groupName, style = MaterialTheme.typography.headlineMedium)
                Text(formatSchoolDate(draft.schoolDate), style = MaterialTheme.typography.bodyLarge)
                LocalSaveBadge(Modifier.testTag("saved-locally-badge"))
                Text(
                    stringResource(R.string.capture_progress, s.marked, s.total),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.testTag("summary-progress"),
                )
                LinearProgressIndicator(progress = { s.progress }, modifier = Modifier.fillMaxWidth())
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.summary_present, s.present), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("summary-present"))
                Text(stringResource(R.string.summary_absent, s.absent), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("summary-absent"))
                Text(stringResource(R.string.summary_pending, s.pending), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("summary-pending"))
            }
        }
        item {
            InfoNotice(
                stringResource(if (s.isComplete) R.string.summary_complete_local else R.string.summary_incomplete_local),
                Modifier.testTag("summary-notice"),
            )
        }
        item { InfoNotice(stringResource(R.string.summary_not_server)) }
        if (pendingRows.isNotEmpty()) {
            item { Text(stringResource(R.string.summary_pending_list), style = MaterialTheme.typography.titleMedium) }
            items(pendingRows, key = { it.student.id }) { Text(it.student.displayName, style = MaterialTheme.typography.bodyLarge) }
        }
        item {
            OutlinedButton(
                onClick = onContinue,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .testTag("summary-continue"),
            ) { Text(stringResource(R.string.summary_continue)) }
        }
    }
}
