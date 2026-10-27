package mx.edu.eta15.prefectura.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.AppContainer
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.data.NetworkMonitor
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.testContext
import mx.edu.eta15.prefectura.ui.theme.EtaTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Pruebas de la interfaz con una base EN MEMORIA y datos de demostracion (solo debug). No tocan los datos del dispositivo. */
@RunWith(AndroidJUnit4::class)
class EtaAppUiTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private lateinit var db: EtaDatabase
    private val clock = MutableClock()
    private val network = NetworkMonitor.Fake(initial = true)

    private fun launch() {
        db = EtaDatabase.inMemory(testContext())
        val container = AppContainer(db, clock, SequentialIds("ui"), networkMonitor = network)
        container.start()
        rule.setContent { EtaTheme { EtaApp(container) } }
        waitForTag("home-groups")
    }

    @After
    fun tearDown() {
        if (::db.isInitialized) db.close()
    }

    private fun waitForTag(tag: String) = rule.waitUntil(10_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) = rule.waitUntil(10_000) { rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun openCapture(groupName: String = "1° A") {
        rule.onNodeWithTag("home-groups").performClick()
        waitForText(groupName)
        rule.onNodeWithText(groupName).performClick()
        waitForTag("roster-capture")
        rule.onNodeWithTag("roster-capture").performClick()
        waitForTag("capture-progress")
    }

    @Test
    fun inicioMuestraModoDemostracionYPerfilFicticio() {
        launch()
        rule.onNodeWithText("MODO DEMOSTRACIÓN").assertExists()
        rule.onNodeWithTag("home-profile").assertTextContains("ficticia", substring = true)
        rule.onNodeWithText("Fecha de demostración", substring = true).assertExists()
    }

    @Test
    fun navegaDeGruposAPadronYCapturaYRegresaConAtras() {
        launch()
        rule.onNodeWithTag("home-groups").performClick()
        waitForText("3° B")
        // cinco grupos ficticios
        listOf("1° A", "1° B", "2° A", "3° A", "3° B").forEach { rule.onNodeWithText(it).assertExists() }
        rule.onNodeWithText("1° A").performClick()
        waitForTag("roster-capture")
        rule.onNodeWithText("12 alumnos").assertExists()
        rule.onNodeWithTag("roster-capture").performClick()
        waitForTag("capture-progress")
        rule.onNodeWithTag("capture-progress").assertTextEquals("0 de 12 marcados")
        Espresso.pressBack()
        waitForTag("roster-capture")
        Espresso.pressBack()
        waitForText("3° B")
    }

    @Test
    fun marcarActualizaContadoresYSeguardaEnEsteDispositivo() {
        launch()
        openCapture()
        rule.onNodeWithTag("saved-locally-badge").assertTextEquals("GUARDADA EN ESTE DISPOSITIVO")
        rule.onAllNodesWithText("Presente")[0].performClick()
        rule.onAllNodesWithText("Ausente")[1].performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("2 de 12 marcados").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("capture-counts").assertTextEquals("Presentes: 1 · Ausentes: 1 · Pendientes: 10")
        rule.onAllNodesWithText("Presente")[0].assertIsSelected()
        // quitar la marca la deja pendiente
        rule.onAllNodesWithText("Quitar marca")[0].performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("1 de 12 marcados").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun elResumenNoAfirmaSincronizacionNiFinalizacionOficial() {
        launch()
        openCapture()
        rule.onAllNodesWithText("Presente")[0].performClick()
        rule.onNodeWithTag("capture-summary").performClick()
        waitForTag("summary-progress")
        rule.onNodeWithTag("summary-present").assertTextEquals("Presentes: 1")
        rule.onNodeWithTag("summary-pending").assertTextEquals("Pendientes: 11")
        rule.onNodeWithText("NO equivale a finalizar", substring = true).assertExists()
        rule.onNodeWithTag("saved-locally-badge").assertExists()
        for (forbidden in listOf("Sincronizada", "Registrada en la escuela", "Enviada correctamente", "Finalizar lista")) {
            assertEquals(forbidden, 0, rule.onAllNodesWithText(forbidden, substring = true, ignoreCase = true).fetchSemanticsNodes().size)
        }
    }

    @Test
    fun conectividadDiceQueLaSincronizacionNoExisteConOSinRed() {
        launch()
        rule.onNodeWithTag("home-connectivity").performClick()
        waitForTag("sync-status")
        rule.onNodeWithTag("sync-status").assertTextEquals("Sincronización no implementada")
        rule.onNodeWithTag("network-state").assertTextEquals("Con red")
        network.set(false)
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Sin red").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("sync-status").assertTextEquals("Sincronización no implementada")
    }

    @Test
    fun laCapturaContinuaSinRed() {
        network.set(false)
        launch()
        openCapture()
        rule.onAllNodesWithText("Ausente")[2].performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("1 de 12 marcados").fetchSemanticsNodes().isNotEmpty() }
        network.set(true) // volver la red no cambia el aviso: sigue guardada solo en el dispositivo
        rule.onNodeWithTag("saved-locally-badge").assertTextEquals("GUARDADA EN ESTE DISPOSITIVO")
    }

    @Test
    fun enSabadoNoSeOfreceAbrirListaNueva() {
        clock.now = MutableClock.SATURDAY
        launch()
        rule.onNodeWithText("sábado o domingo", substring = true).assertExists()
        rule.onNodeWithTag("home-groups").performClick()
        waitForText("1° A")
        rule.onNodeWithText("1° A").performClick()
        waitForTag("roster-capture")
        rule.onNodeWithTag("roster-capture").assertIsNotEnabled()
    }

    @Test
    fun accesibilidadObjetivosTactilesYRegionViva() {
        launch()
        openCapture()
        rule.onAllNodesWithText("Presente")[0].assertHeightIsAtLeast(48.dp)
        rule.onAllNodesWithText("Ausente")[0].assertHeightIsAtLeast(48.dp)
        rule.onNodeWithTag("capture-summary").assertHeightIsAtLeast(56.dp).assertIsEnabled()
        val liveRegions = rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion)).fetchSemanticsNodes()
        assertTrue("el avance debe anunciarse como region viva", liveRegions.isNotEmpty())
        // ningun elemento accionable sin nombre accesible (texto o descripcion en el arbol combinado)
        val unnamed = rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick)).fetchSemanticsNodes()
            .filter { !it.config.contains(SemanticsProperties.Text) && !it.config.contains(SemanticsProperties.ContentDescription) }
        assertTrue("Elementos accionables sin nombre: ${unnamed.map { it.id }}", unnamed.isEmpty())
    }
    @Test
    fun reiniciarLaDemostracionBorraLasCapturasLocales() {
        launch()
        openCapture()
        rule.onAllNodesWithText("Presente")[0].performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("1 de 12 marcados").fetchSemanticsNodes().isNotEmpty() }
        Espresso.pressBack()
        waitForTag("roster-capture")
        Espresso.pressBack()
        waitForText("1° A")
        Espresso.pressBack()
        waitForTag("home-connectivity")
        rule.onNodeWithTag("home-connectivity").performClick()
        waitForTag("reset-demo")
        rule.onNodeWithTag("reset-demo").performClick()
        rule.onNodeWithText("Restablecer").performClick()
        waitForTag("home-groups")
        rule.onNodeWithTag("home-groups").performClick()
        waitForText("1° A")
        // grupo nuevo, sin avance
        rule.onAllNodesWithText("Sin lista hoy").fetchSemanticsNodes().let { assertEquals(5, it.size) }
        runBlocking { assertTrue(db.catalogDao().profileCount() == 1) }
    }}
