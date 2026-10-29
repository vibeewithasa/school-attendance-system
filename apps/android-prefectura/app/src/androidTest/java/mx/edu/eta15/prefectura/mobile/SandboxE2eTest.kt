package mx.edu.eta15.prefectura.mobile

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mx.edu.eta15.prefectura.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * EXTREMO A EXTREMO contra el servidor de PRUEBAS (`pnpm dev:sandbox -- ... --mobile-auth`, cuentas y datos FICTICIOS) con el
 * Keystore REAL del emulador y HTTP real hacia 10.0.2.2. Solo corre si se pide: `-e e2e sandbox`.
 *
 * Los pasos del lado web (reclamar con el codigo, aprobar con la huella, revocar) los hace un guion externo con sesion web; esta
 * prueba escribe en logcat (etiqueta ETA15_E2E) lo que ese guion necesita y espera el resultado. Fases (`-e phase ...`):
 *   link   -> vincula (clave nueva, solicitud, espera aprobacion, activacion), abre sesion y lee grupos y padron.
 *   revoked-> con el dispositivo ya revocado desde el portal: la sesion y una nueva apertura deben fallar de inmediato.
 *   forget -> olvida el dispositivo (borra clave y registro) y comprueba que no queda nada.
 */
@RunWith(AndroidJUnit4::class)
class SandboxE2eTest {
    private val args = InstrumentationRegistry.getArguments()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private fun say(text: String) = Log.i(TAG, text)

    private fun newController(): MobileLinkController {
        val key = AndroidDeviceKey() // alias real de la app
        return MobileLinkController(
            key = key,
            store = FileLinkStore(testContext().noBackupFilesDir),
            apiFor = { jwk -> HttpMobileApi(BASE, DpopProofBuilder(jwk, key::signDer), jwk) },
            scope = scope,
            pollMillis = 1_000,
        )
    }

    private suspend fun waitFor(controller: MobileLinkController, seconds: Long, what: String, ok: (MobileUiState) -> Boolean): MobileUiState {
        var last = controller.state.value
        try {
            withTimeout(seconds * 1_000) {
                while (!ok(controller.state.value)) {
                    last = controller.state.value
                    delay(250)
                }
            }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("Tiempo agotado esperando: $what (etapa=${last.stage}, problema=${last.issue})")
        }
        return controller.state.value
    }

    @Test
    fun fase() = runBlocking {
        assumeTrue("e2e=sandbox", args.getString("e2e") == "sandbox")
        val controller = newController()
        when (val phase = args.getString("phase")) {
            "link" -> link(controller)
            "revoked" -> revoked(controller)
            "forget" -> forget(controller)
            else -> throw AssertionError("fase desconocida: $phase")
        }
        scope.cancel()
    }

    private suspend fun link(controller: MobileLinkController) {
        val key = AndroidDeviceKey()
        if (key.exists()) key.delete() // arranque limpio de la prueba
        FileLinkStore(testContext().noBackupFilesDir).clear()
        controller.start()
        waitFor(controller, 10, "estado inicial") { it.stage == Stage.NOT_LINKED }
        assertFalse("no hay clave antes de pulsar Vincular", key.exists())

        controller.startLinking("Emulador de pruebas")
        val pairing = waitFor(controller, 20, "solicitud creada") { it.stage == Stage.PAIRING && it.pairing?.pairingCode != null }.pairing!!
        assertTrue(key.exists())
        say("PAIRING request=${pairing.requestId} code=${pairing.pairingCode} fingerprint=${pairing.fingerprint}")
        assertEquals(key.publicJwk().shortFingerprint(), pairing.fingerprint)

        // El guion externo reclama con el codigo y Direccion aprueba tecleando la huella: el dispositivo no hace nada mas que esperar.
        val linked = waitFor(controller, 180, "aprobacion y activacion") { it.stage == Stage.LINKED }
        assertNotNull(linked.deviceId)
        assertEquals("Prefectura ficticia", linked.owner)
        say("LINKED device=${linked.deviceId} protection=${linked.protection}")

        controller.openSession()
        waitFor(controller, 20, "sesion abierta") { it.session != null }
        say("SESSION ok until=${controller.state.value.session!!.sessionExpiresAt}")

        controller.loadGroups()
        val groups = waitFor(controller, 20, "grupos") { it.groups != null }.groups!!
        say("GROUPS count=${groups.size} labels=${groups.joinToString("|") { it.label }}")
        assertTrue("la prefecta ficticia ve al menos un grupo", groups.isNotEmpty())
        controller.loadRoster(groups.first().groupId)
        val roster = waitFor(controller, 20, "padron") { it.roster != null }.roster!!
        say("ROSTER group=${roster.groupLabel} students=${roster.students.size}")
        assertTrue(roster.students.isNotEmpty())

        // Lo guardado en disco son solo identificadores: nunca credenciales ni datos escolares.
        val record = FileLinkStore(testContext().noBackupFilesDir).load()
        assertEquals(linked.deviceId, record?.deviceId)
        val raw = java.io.File(testContext().noBackupFilesDir, "mobile_link.json").readText()
        assertFalse(raw.contains("Ficticio") && raw.contains("Ana"))
        say("LINK_RECORD_BYTES=${raw.length}")
    }

    private suspend fun revoked(controller: MobileLinkController) {
        controller.start()
        waitFor(controller, 10, "estado vinculado") { it.stage == Stage.LINKED }
        // La sesion abierta antes de la revocacion ya no sirve: se intenta leer grupos con la misma sesion en memoria no existe
        // (proceso nuevo), asi que se comprueba que NO se puede abrir otra y que el motivo es la revocacion.
        controller.openSession()
        val s = waitFor(controller, 20, "rechazo por revocacion") { it.issue != null }
        say("REVOKED issue=${s.issue} session=${s.session}")
        assertEquals(LinkIssue.DEVICE_REVOKED, s.issue)
        assertNull(s.session)
    }

    private suspend fun forget(controller: MobileLinkController) {
        controller.start()
        waitFor(controller, 10, "arranque") { it.stage != Stage.LOADING }
        controller.forgetDevice()
        assertFalse(AndroidDeviceKey().exists())
        assertNull(FileLinkStore(testContext().noBackupFilesDir).load())
        assertEquals(Stage.NOT_LINKED, controller.state.value.stage)
        say("FORGOTTEN at=${Instant.now()}")
    }

    private companion object {
        const val TAG = "ETA15_E2E"
        const val BASE = "http://10.0.2.2:3000"
    }
}
