package mx.edu.eta15.prefectura.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.KeyStore
import mx.edu.eta15.prefectura.AppContainer
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.StorageState
import mx.edu.eta15.prefectura.data.secure.KeystoreKeyVault
import mx.edu.eta15.prefectura.data.secure.SecureStorage
import mx.edu.eta15.prefectura.testContext
import mx.edu.eta15.prefectura.ui.theme.EtaTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * La app con almacenamiento cifrado REAL (SQLCipher + Keystore) en el emulador: arranque, datos de demostracion y la
 * pantalla de FALLO CERRADO cuando la clave deja de existir. Usa nombres propios (no toca la base de la app).
 */
@RunWith(AndroidJUnit4::class)
class StorageFailureUiTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val ctx = testContext()
    private val tag = "u${System.nanoTime()}"
    private val alias = "eta15_ui_$tag"
    private val vault = KeystoreKeyVault(ctx, alias, "$alias.blob")
    private val storage = SecureStorage(ctx, vault, "ui_$tag.db", "ui_legacy_$tag.db")

    @After
    fun tearDown() = storage.wipeAll()

    private fun launch(): AppContainer {
        val container = AppContainer(
            opener = { storage.open() },
            clock = MutableClock(),
            ids = SequentialIds("ui"),
            secureStorage = storage,
        )
        container.start()
        rule.setContent { EtaTheme { EtaApp(container) } }
        return container
    }

    private fun waitTag(tag: String) = rule.waitUntil(15_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun arrancaConAlmacenamientoCifradoYMuestraElEstadoDelCifrado() {
        val container = launch()
        waitTag("home-groups")
        val ready = container.storage.value as StorageState.Ready
        assertTrue("SQLCipher responde con su version", ready.encryption != null)
        rule.onNodeWithTag("home-connectivity").performClick()
        waitTag("encryption-status")
        rule.onNodeWithText("Cifrado en reposo de la base local: activo", substring = true).assertExists()
        rule.onNodeWithTag("license-toggle").performScrollTo().performClick()
        waitTag("license-text")
        rule.onNodeWithTag("license-text").assertTextContains("ZETETIC LLC", substring = true)
        assertFalse(SecureStorage.hasPlainSqliteHeader(ctx.getDatabasePath("ui_$tag.db")))
    }

    @Test
    fun conLaClaveInvalidadaLaPantallaExplicaElFalloYElReinicioEsExplicito() {
        // Se prepara una base cifrada y se invalida la clave ANTES de arrancar la app
        storage.open().close()
        val dbFile = ctx.getDatabasePath("ui_$tag.db")
        val bytesBefore = dbFile.readBytes()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)

        launch()
        waitTag("storage-failed-title")
        // fail closed: sin grupos, sin boton de grupos, sin base nueva
        assertEquals(0, rule.onAllNodesWithTag("home-groups").fetchSemanticsNodes().size)
        rule.onNodeWithTag("storage-failed-reason").assertExists()
        assertTrue("la base cifrada no se toco", bytesBefore.contentEquals(dbFile.readBytes()))
        assertFalse(vault.hasKeystoreKey())

        // Reintentar NO borra ni regenera nada
        rule.onNodeWithTag("storage-retry").performClick()
        waitTag("storage-failed-title")
        assertTrue(bytesBefore.contentEquals(dbFile.readBytes()))

        // Reinicio explicito (solo debug): pide confirmacion; cancelar no hace nada
        rule.onNodeWithTag("storage-wipe").performScrollTo().performClick()
        rule.onNodeWithText("Cancelar").performClick()
        assertTrue(bytesBefore.contentEquals(dbFile.readBytes()))
        rule.onNodeWithTag("storage-wipe").performScrollTo().performClick()
        rule.onNodeWithText("Borrar").performClick()
        waitTag("home-groups")
        rule.onNodeWithText("MODO DEMOSTRACIÓN").assertExists()
        assertFalse("la base es otra (nueva), cifrada", bytesBefore.contentEquals(dbFile.readBytes()))
        assertFalse(SecureStorage.hasPlainSqliteHeader(dbFile))
    }}
