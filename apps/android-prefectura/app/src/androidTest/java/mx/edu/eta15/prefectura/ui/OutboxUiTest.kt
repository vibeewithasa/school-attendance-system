package mx.edu.eta15.prefectura.ui

import androidx.activity.ComponentActivity
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
import mx.edu.eta15.prefectura.domain.OperationInfo
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxSummary
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
}
