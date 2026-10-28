package mx.edu.eta15.prefectura.mobile

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mx.edu.eta15.prefectura.ui.theme.EtaTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private val JWK = EcJwk("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA", "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A")

private class FakeKey(var present: Boolean = false) : DeviceKey {
    override fun exists() = present

    override fun create() {
        check(!present)
        present = true
    }

    override fun publicJwk() = JWK

    override fun protection() = KeyProtection.TRUSTED_ENVIRONMENT

    override fun signDer(data: ByteArray): ByteArray = throw UnsupportedOperationException()

    override fun delete() {
        present = false
    }
}

private class FakeStore : LinkStore {
    var record: LinkRecord? = null

    override fun load() = record

    override fun save(record: LinkRecord) {
        this.record = record
    }

    override fun clear() {
        record = null
    }
}

private class ScriptedApi : MobileApi {
    private val now = Instant.now()
    var statusIndex = 0
    val statuses = listOf("claimed", "approved")

    override suspend fun enroll(jwk: EcJwk, label: String): ApiResult<EnrollCreated> =
        ApiResult.Ok(EnrollCreated("22222222-0000-4000-8000-000000000001", "ABCD-2345", jwk.shortFingerprint(), now.plusSeconds(600)))

    override suspend fun enrollStatus(requestId: String): ApiResult<EnrollStatus> {
        val s = statuses[minOf(statusIndex++, statuses.lastIndex)]
        return ApiResult.Ok(EnrollStatus(s, now.plusSeconds(600), JWK.shortFingerprint(), "Prefecta Ficticia"))
    }

    override suspend fun activate(requestId: String): ApiResult<String> = ApiResult.Ok("d3f4a5b6-0000-4000-8000-000000000001")

    private fun session() = MobileSession("a", "r", now.plusSeconds(300), now.plusSeconds(3600), now.plusSeconds(28_800), "d3f4a5b6-0000-4000-8000-000000000001")

    override suspend fun openSession(): ApiResult<MobileSession> = ApiResult.Ok(session())

    override suspend fun renew(session: MobileSession): ApiResult<MobileSession> = ApiResult.Ok(session())

    override suspend fun closeSession(session: MobileSession): ApiResult<Unit> = ApiResult.Ok(Unit)

    override suspend fun myGroups(session: MobileSession): ApiResult<List<GroupItem>> = ApiResult.Ok(listOf(GroupItem("g1", "1.º A", "2026-2027")))

    override suspend fun roster(session: MobileSession, groupId: String): ApiResult<Roster> =
        ApiResult.Ok(Roster("1.º A", listOf(RosterStudent("s1", "Ana Ficticia"), RosterStudent("s2", "Beto Ficticio"))))
}

/** Interfaz de la vinculacion de PRUEBAS con clave, almacen y servidor falsos (no toca el Keystore real ni la red). */
@RunWith(AndroidJUnit4::class)
class MobileLinkScreenTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val key = FakeKey()
    private val store = FakeStore()

    @After
    fun tearDown() = scope.cancel()

    private fun show(): MobileLinkController {
        val controller = MobileLinkController(key, store, { ScriptedApi() }, scope, pollMillis = 200)
        rule.setContent {
            EtaTheme {
                val state by controller.state.collectAsStateWithLifecycle()
                MobileLinkScreen(state, controller, PaddingValues())
            }
        }
        controller.start()
        return controller
    }

    private fun waitForTag(tag: String) = rule.waitUntil(10_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun elAvisoDeEntornoDePruebasEstaSiempreVisibleYNoHayTextoDeLaEscuelaOficial() {
        show()
        waitForTag("mobile-start")
        rule.onNodeWithText("ENTORNO DE PRUEBAS").assertExists()
        rule.onNodeWithText("No es el sistema de la escuela", substring = true).assertExists()
    }

    @Test
    fun vincularMuestraClaveCodigoYHuellaYAvanzaHastaVinculado() {
        val controller = show()
        waitForTag("mobile-start")
        assertFalse(key.present)
        rule.onNodeWithTag("mobile-start").performClick()
        waitForTag("mobile-pairing-code")
        assertTrue("la clave se crea solo tras pulsar Vincular", key.present)
        rule.onNodeWithTag("mobile-pairing-code").assertTextContains("ABCD-2345")
        rule.onNodeWithTag("mobile-request-id").assertTextContains("22222222-0000-4000-8000-000000000001")
        rule.onNodeWithTag("mobile-fingerprint").assertTextContains(JWK.shortFingerprint())
        waitForTag("mobile-linked")
        assertEquals(Stage.LINKED, controller.state.value.stage)
        assertEquals("Prefecta Ficticia", controller.state.value.owner)
        rule.onNodeWithTag("mobile-protection").assertTextContains("entorno seguro", substring = true)
    }

    @Test
    fun conSesionSeLeenGruposYPadronEnLineaSinGuardarlos() {
        key.present = true
        store.record = LinkRecord("r1", "d3f4a5b6-0000-4000-8000-000000000001", "Equipo", "Prefecta Ficticia")
        val controller = show()
        waitForTag("mobile-open-session")
        rule.onNodeWithTag("mobile-session-status").assertTextContains("sin abrir", substring = true)
        rule.onNodeWithTag("mobile-open-session").performClick()
        waitForTag("mobile-load-groups")
        rule.onNodeWithTag("mobile-load-groups").performScrollTo().performClick()
        waitForTag("mobile-group-1.º A")
        rule.onNodeWithTag("mobile-group-1.º A").performScrollTo().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("mobile-student").fetchSemanticsNodes().size == 2 }
        assertNotNull(controller.state.value.roster)
        // nada del padron ni de la sesion se guarda en el almacen local: solo el registro de vinculacion
        assertEquals(LinkRecord("r1", "d3f4a5b6-0000-4000-8000-000000000001", "Equipo", "Prefecta Ficticia"), store.record)
        rule.onNodeWithTag("mobile-close-session").performScrollTo().performClick()
        waitForTag("mobile-open-session")
        assertNull(controller.state.value.groups)
        assertNull(controller.state.value.roster)
    }

    @Test
    fun olvidarPideConfirmacionBorraLaClaveYAvisaQueHayQueRevocarEnElServidor() {
        key.present = true
        store.record = LinkRecord("r1", "d1", "Equipo", "Prefecta Ficticia")
        val controller = show()
        waitForTag("mobile-forget")
        rule.onNodeWithTag("mobile-forget").performScrollTo().performClick()
        rule.onNodeWithTag("mobile-forget-confirm").assertExists()
        assertTrue(key.present)
        rule.onNodeWithTag("mobile-forget-confirm").performClick()
        waitForTag("mobile-start")
        assertFalse(key.present)
        assertNull(store.record)
        assertEquals(Stage.NOT_LINKED, controller.state.value.stage)
    }

    @Test
    fun conRegistroSinClaveSeExplicaYNoSeCreaOtraClave() {
        key.present = false
        store.record = LinkRecord("r1", "d1", "Equipo", "Prefecta Ficticia")
        show()
        waitForTag("mobile-forget")
        assertFalse(key.present)
        assertEquals(0, rule.onAllNodesWithTag("mobile-start").fetchSemanticsNodes().size)
    }
}
