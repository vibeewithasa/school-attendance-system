package mx.edu.eta15.prefectura.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.LocalDate
import mx.edu.eta15.prefectura.domain.ManualSyncState
import mx.edu.eta15.prefectura.domain.OperationInfo
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxSummary
import mx.edu.eta15.prefectura.domain.SyncReport
import mx.edu.eta15.prefectura.domain.SyncResultKind
import mx.edu.eta15.prefectura.ui.theme.EtaTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Seccion "Preparacion para sincronizar" (SANDBOX): estados puros, sin tocar datos del dispositivo. Verifica que la interfaz diga
 * siempre que NADA se envia, que ofrezca "Preparar para sincronizar" y que jamas muestre textos de envio o de registro oficial.
 */
@RunWith(AndroidJUnit4::class)
class OutboxUiTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val date = LocalDate.of(2026, 10, 27)

    private fun summary(unsealed: Boolean, vararg ops: OperationInfo) = OutboxSummary("d1", date, localMarks = 2, unsealedChanges = unsealed, operations = ops.toList())

    private fun op(kind: OperationKind, state: OperationState, marks: Int = 2) = OperationInfo("o-${kind.name}-${state.name}", kind, state, null, marks)

    private fun show(outbox: OutboxSummary, message: PrepareMessage? = null, enabled: Boolean = true, onPrepare: () -> Unit = {}) {
        rule.setContent { EtaTheme { OutboxSection(outbox, message, enabled, onPrepare) } }
    }

    private fun showSync(
        outbox: OutboxSummary,
        sync: ManualSyncState = ManualSyncState(),
        available: Boolean = true,
        onSync: () -> Unit = {},
        onCancel: () -> Unit = {},
    ) {
        rule.setContent { EtaTheme { OutboxSection(outbox, null, true, {}, syncAvailable = available, sync = sync, onSync = onSync, onCancelSync = onCancel) } }
    }

    @Test
    fun sinPrepararDiceQueNadaSeEnviaYOfreceElBotonDePreparar() {
        var taps = 0
        show(summary(unsealed = true), onPrepare = { taps++ })
        rule.onNodeWithTag("outbox-local-notice").assertIsDisplayed()
        rule.onNodeWithTag("outbox-marks").assertIsDisplayed()
        rule.onNodeWithTag("outbox-unsealed").assertIsDisplayed()
        rule.onNodeWithText("Preparar para sincronizar").assertIsDisplayed().assertIsEnabled().performClick()
        assertEquals(1, taps)
        // no existe un boton de envio al servidor
        rule.onAllNodesWithText("Enviar", substring = true, ignoreCase = true).assertCountEquals(0)
    }

    @Test
    fun conOperacionesPreparadasMuestraSuEstadoSinDecirQueSeEnvio() {
        show(
            summary(
                unsealed = false,
                op(OperationKind.OPEN, OperationState.READY, 0),
                op(OperationKind.SAVE_MARKS, OperationState.WAITING_REMOTE_CONTEXT),
            ),
        )
        rule.onNodeWithTag("outbox-sealed").assertIsDisplayed()
        rule.onNodeWithTag("outbox-op-OPEN-READY").assertIsDisplayed()
        rule.onNodeWithTag("outbox-op-SAVE_MARKS-WAITING_REMOTE_CONTEXT").assertIsDisplayed()
        rule.onNodeWithText("Requiere contexto del servidor", substring = true).assertIsDisplayed()
        for (forbidden in listOf("Enviado", "Sincronizado", "Registrado oficialmente", "Enviada", "Sincronizada")) {
            rule.onAllNodesWithText(forbidden, substring = true, ignoreCase = true).assertCountEquals(0)
        }
    }

    @Test
    fun necesitaRevisionYRequiereAutenticacionTienenTextoPropio() {
        show(
            summary(
                unsealed = false,
                op(OperationKind.SAVE_MARKS, OperationState.NEEDS_REVIEW),
                op(OperationKind.OPEN, OperationState.AUTH_REQUIRED, 0),
            ),
        )
        rule.onNodeWithText("Necesita revisión", substring = true).assertIsDisplayed()
        rule.onNodeWithText("volver a autenticar", substring = true).assertIsDisplayed()
    }

    @Test
    fun listaParaUnEnvioFuturoAclaraQueAunNoSeEnvia() {
        show(summary(unsealed = false, op(OperationKind.SAVE_MARKS, OperationState.READY)))
        rule.onNodeWithText("aún no se envía", substring = true).assertIsDisplayed()
    }

    @Test
    fun elResultadoDePrepararDiceQueSoloSeGuardoEnEsteDispositivo() {
        show(summary(unsealed = false), message = PrepareMessage.Prepared)
        rule.onNodeWithTag("outbox-message").assertIsDisplayed()
        rule.onNodeWithText("No se envió nada al servidor", substring = true).assertIsDisplayed()
    }

    @Test
    fun unErrorLocalNoDiceQueSeHayaRegistradoNada() {
        show(summary(unsealed = true), message = PrepareMessage.LocalError)
        rule.onNodeWithText("Error local", substring = true).assertIsDisplayed()
        rule.onNodeWithText("no se modificó", substring = true).assertIsDisplayed()
    }

    @Test
    fun conElAccesoBloqueadoElBotonSeDeshabilita() {
        show(summary(unsealed = true), enabled = false)
        rule.onNodeWithText("Preparar para sincronizar").assertIsNotEnabled()
    }

    // ---------------------------------------------------------------------------------------------- sincronizacion manual

    @Test
    fun sinTransporteNoHayBotonDeSincronizar() {
        showSync(summary(unsealed = false, op(OperationKind.SAVE_MARKS, OperationState.READY)), available = false)
        rule.onAllNodesWithText("Sincronizar ahora").assertCountEquals(0)
        rule.onNodeWithTag("outbox-prepare").assertIsDisplayed()
    }

    @Test
    fun conTransporteElBotonExisteYSoloSeDisparaPorLaPulsacion() {
        var taps = 0
        showSync(summary(unsealed = false, op(OperationKind.SAVE_MARKS, OperationState.READY)), onSync = { taps++ })
        rule.onNodeWithText("Sincronizar ahora").assertIsDisplayed().assertIsEnabled()
        assertEquals(0, taps) // mostrar la pantalla no inicia nada
        rule.onNodeWithText("Sincronizar ahora").performClick()
        assertEquals(1, taps)
    }

    @Test
    fun durantEUnCicloElBotonSeDeshabilitaYSePuedeCancelar() {
        var cancels = 0
        showSync(summary(unsealed = true, op(OperationKind.SAVE_MARKS, OperationState.SENDING)), ManualSyncState(running = true, groupId = "g"), onCancel = { cancels++ })
        rule.onNodeWithText("Sincronizar ahora").assertIsNotEnabled()
        rule.onNodeWithText("Preparar para sincronizar").assertIsNotEnabled()
        rule.onNodeWithTag("outbox-sync-running").assertIsDisplayed()
        rule.onNodeWithTag("outbox-op-SAVE_MARKS-SENDING").assertIsDisplayed()
        rule.onNodeWithText("Cancelar").performClick()
        assertEquals(1, cancels)
    }

    @Test
    fun soloUnReciboConfirmadoDiceConfirmadoPorElServidor() {
        showSync(summary(unsealed = false, op(OperationKind.OPEN, OperationState.ACKNOWLEDGED, 0), op(OperationKind.SAVE_MARKS, OperationState.ACKNOWLEDGED)), ManualSyncState(last = SyncReport(SyncResultKind.CONFIRMED, 1)))
        rule.onNodeWithTag("outbox-op-SAVE_MARKS-ACKNOWLEDGED").assertIsDisplayed()
        rule.onAllNodesWithText("Confirmado por el servidor", substring = true)[0].assertIsDisplayed()
        rule.onNodeWithTag("outbox-sync-result-CONFIRMED").assertIsDisplayed()
    }

    @Test
    fun ningunResultadoDiceSincronizadoNiEnviadoYTodosTienenSuMensaje() {
        var current by androidx.compose.runtime.mutableStateOf(SyncResultKind.CONFIRMED)
        rule.setContent {
            EtaTheme {
                OutboxSection(
                    summary(unsealed = false, op(OperationKind.SAVE_MARKS, OperationState.RETRYABLE_ERROR)), null, true, {},
                    syncAvailable = true, sync = ManualSyncState(last = SyncReport(current)),
                )
            }
        }
        for (kind in SyncResultKind.entries) {
            rule.runOnUiThread { current = kind }
            rule.waitForIdle()
            rule.onAllNodesWithText("Sincronizado", substring = true, ignoreCase = true).assertCountEquals(0)
            rule.onAllNodesWithText("Enviado", substring = true, ignoreCase = true).assertCountEquals(0)
            rule.onNodeWithTag("outbox-sync-result-$kind").assertIsDisplayed()
        }
    }

    @Test
    fun cadaEstadoDeLaOperacionTieneSuTextoPropio() {
        showSync(
            summary(
                unsealed = false,
                op(OperationKind.SAVE_MARKS, OperationState.RETRYABLE_ERROR),
                op(OperationKind.SAVE_MARKS, OperationState.CONFLICT),
                op(OperationKind.OPEN, OperationState.NEEDS_REVIEW, 0),
                op(OperationKind.OPEN, OperationState.AUTH_REQUIRED, 0),
            ),
        )
        rule.onNodeWithText("se puede reintentar con el mismo envío", substring = true).assertIsDisplayed()
        rule.onNodeWithText("la lista cambió en el servidor", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Necesita revisión", substring = true).assertIsDisplayed()
        rule.onNodeWithText("volver a autenticar", substring = true).assertIsDisplayed()
    }
}
