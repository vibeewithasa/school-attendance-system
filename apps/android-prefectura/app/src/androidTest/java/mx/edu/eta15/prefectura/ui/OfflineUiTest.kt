package mx.edu.eta15.prefectura.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import java.time.LocalDate
import mx.edu.eta15.prefectura.domain.AccessBlock
import mx.edu.eta15.prefectura.domain.Group
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.SyncInfo
import mx.edu.eta15.prefectura.ui.theme.EtaTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Estados de la interfaz de la cache descargada (SANDBOX): aviso permanente de datos de prueba, ultima descarga, vigencia vencida,
 * dispositivo revocado, reloj inconsistente, grupo revocado y revision pendiente. Estados puros: no tocan datos del dispositivo.
 */
@RunWith(AndroidJUnit4::class)
class OfflineUiTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val sync = SyncInfo(Instant.parse("2026-10-27T18:00:00Z"), Instant.parse("2026-10-27T18:00:00Z"), LocalDate.of(2026, 10, 27))
    private val groups = listOf(
        Group("g1", "1.º A", 1, 5, 2, true, needsReview = true, downloadedAt = sync.lastDownloadAt),
        Group("g2", "1.º B", 1, 4, 0, false, revoked = true, downloadedAt = sync.lastDownloadAt),
    )

    private fun show(access: OfflineAccess, list: List<Group> = groups, withSync: Boolean = true) {
        rule.setContent {
            EtaTheme {
                GroupsScreen(
                    GroupsUiState(loading = false, groups = list, date = LocalDate.of(2026, 10, 27), access = access, sync = if (withSync) sync else null),
                    onOpenGroup = {},
                    contentPadding = PaddingValues(),
                )
            }
        }
    }

    @Test
    fun vigenteMuestraAvisoDePruebaUltimaDescargaYGruposConSusMarcas() {
        show(OfflineAccess.Active(Instant.parse("2026-10-27T18:30:00Z"), dateConfirmed = true))
        rule.onNodeWithTag("offline-status").assertIsDisplayed()
        rule.onNodeWithText("DATOS DE PRUEBA DESCARGADOS (SANDBOX)").assertIsDisplayed()
        rule.onNodeWithTag("offline-last-update").assertIsDisplayed()
        rule.onNodeWithTag("offline-access-active").assertIsDisplayed()
        // las tarjetas de grupo fusionan su semantica: las etiquetas internas se buscan en el arbol SIN fusionar
        rule.onNode(hasScrollAction()).performScrollToNode(hasTestTag("group-g2"))
        rule.onNodeWithTag("group-revoked-g2", useUnmergedTree = true).assertIsDisplayed()
        rule.onNode(hasScrollAction()).performScrollToNode(hasTestTag("group-g1"))
        rule.onNodeWithTag("group-review-g1", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun fechaNoConfirmadaSeAvisa() {
        show(OfflineAccess.Active(Instant.parse("2026-10-27T18:30:00Z"), dateConfirmed = false))
        rule.onNodeWithTag("offline-date-unconfirmed").assertIsDisplayed()
    }

    @Test
    fun cadaMotivoDeBloqueoTieneSuAviso() {
        var access by mutableStateOf<OfflineAccess>(OfflineAccess.Blocked(AccessBlock.EXPIRED))
        rule.setContent {
            EtaTheme {
                GroupsScreen(
                    GroupsUiState(loading = false, groups = groups, date = LocalDate.of(2026, 10, 27), access = access, sync = sync),
                    onOpenGroup = {},
                    contentPadding = PaddingValues(),
                )
            }
        }
        for (reason in AccessBlock.entries) {
            rule.runOnIdle { access = OfflineAccess.Blocked(reason) }
            rule.waitForIdle()
            rule.onNodeWithTag("offline-blocked-${reason.name}").assertIsDisplayed()
        }
    }

    @Test
    fun laDemostracionLocalNoMuestraNadaDeLaCache() {
        show(OfflineAccess.NotApplicable, groups.take(1).map { it.copy(needsReview = false, downloadedAt = null) }, withSync = false)
        rule.onNodeWithText("1.º A").assertIsDisplayed()
        check(rule.onAllNodesWithTagCount("offline-status") == 0)
    }

    @Test
    fun laPantallaDeBloqueoNoOfreceReintentarDescargaPeroSiVolver() {
        rule.setContent { EtaTheme { AccessBlockedView(AccessBlock.EXPIRED, onBack = {}) } }
        rule.onNodeWithTag("offline-blocked-view-EXPIRED").assertIsDisplayed()
        rule.onNodeWithText("Acceso offline de demostración vencido").assertIsDisplayed()
        rule.onNodeWithText("Volver").assertIsDisplayed()
    }

    private fun androidx.compose.ui.test.junit4.AndroidComposeTestRule<*, *>.onAllNodesWithTagCount(tag: String): Int =
        onAllNodesWithTag(tag).fetchSemanticsNodes().size
}
