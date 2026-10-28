package mx.edu.eta15.prefectura.mobile

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.HttpURLConnection
import java.net.URL
import java.time.Clock
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mx.edu.eta15.prefectura.data.LocalAttendanceRepository
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.ProfileAccessGate
import mx.edu.eta15.prefectura.data.SandboxIds
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.secure.SecureStorage
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * EXTREMO A EXTREMO de la cache offline contra el servidor de PRUEBAS (`pnpm dev:sandbox -- ... --mobile-auth`, cuentas y alumnos
 * FICTICIOS), con el Keystore y la base SQLCipher REALES del emulador. Solo corre si se pide: `-e e2e offline`. Cada fase es un
 * proceso nuevo ("se cierra y se vuelve a abrir la aplicacion"); un guion externo hace los pasos web, apaga y enciende la red y
 * lee los registros (etiqueta ETA15_E2E). Fases (`-e phase ...`):
 *   link-download -> vincula (clave nueva), abre sesion y descarga los grupos autorizados a la base cifrada (`-e groups N`).
 *   offline       -> SIN red: comprueba que no hay internet, abre grupos y padron locales, marca Presente/Ausente y deja Pendientes.
 *   persist       -> proceso nuevo: la captura sigue ahi.
 *   reconnect     -> con red: vuelve a descargar (`-e expectRevoked N`): detecta cambios de autorizacion sin perder borradores.
 *   isolation     -> otro perfil descargado: la cache de una identidad no es visible desde la otra.
 */
@RunWith(AndroidJUnit4::class)
class SandboxOfflineE2eTest {
    private val args = InstrumentationRegistry.getArguments()
    private val ctx = testContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clock: Clock = Clock.systemUTC()
    private val policy = OfflinePolicy(Duration.ofMinutes(15))

    private fun say(text: String) = Log.i(TAG, text)

    private fun profileOfLink(): String =
        SandboxIds.profile(FileLinkStore(ctx.noBackupFilesDir).load()?.deviceId ?: error("sin vinculacion"))

    private fun controller(db: EtaDatabase): MobileLinkController {
        val key = AndroidDeviceKey()
        return MobileLinkController(
            key = key,
            store = FileLinkStore(ctx.noBackupFilesDir),
            apiFor = { jwk -> HttpMobileApi(BASE, DpopProofBuilder(jwk, key::signDer), jwk) },
            scope = scope,
            clock = clock,
            pollMillis = 1_000,
            cache = OfflineCacheStore(db, clock, policy),
        )
    }

    private fun repo(db: EtaDatabase, profile: String) =
        LocalAttendanceRepository(db, profile, clock, IdGenerator.Random, access = ProfileAccessGate(db, profile, clock, policy))

    private suspend fun waitFor(what: String, seconds: Long = 30, ok: () -> Boolean) {
        try {
            withTimeout(seconds * 1_000) { while (!ok()) delay(250) }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("Tiempo agotado esperando: $what")
        }
    }

    private fun reachable(): Boolean = try {
        val c = URL("$BASE/health").openConnection() as HttpURLConnection
        c.connectTimeout = 3_000
        c.readTimeout = 3_000
        try {
            c.responseCode in 100..599
        } finally {
            c.disconnect()
        }
    } catch (_: Exception) {
        false
    }

    @Test
    fun fase() = runBlocking {
        assumeTrue("e2e=offline", args.getString("e2e") == "offline")
        SecureStorage.loadNativeLibrary()
        val db = SecureStorage(ctx).open()
        try {
            when (val phase = args.getString("phase")) {
                "link-download" -> linkAndDownload(db)
                "offline" -> offline(db)
                "persist" -> persist(db)
                "reconnect" -> reconnect(db)
                "isolation" -> isolation(db)
                else -> throw AssertionError("fase desconocida: $phase")
            }
        } finally {
            scope.cancel()
            db.close()
        }
    }

    private suspend fun linkAndDownload(db: EtaDatabase) {
        val key = AndroidDeviceKey()
        if (key.exists()) key.delete() // arranque limpio de la prueba
        FileLinkStore(ctx.noBackupFilesDir).clear()
        val c = controller(db)
        c.start()
        waitFor("estado inicial") { c.state.value.stage == Stage.NOT_LINKED }
        c.startLinking("Emulador offline")
        waitFor("solicitud creada", 20) { c.state.value.stage == Stage.PAIRING && c.state.value.pairing?.pairingCode != null }
        val p = c.state.value.pairing!!
        say("PAIRING request=${p.requestId} code=${p.pairingCode} fingerprint=${p.fingerprint}")
        waitFor("aprobacion y activacion", 180) { c.state.value.stage == Stage.LINKED }
        c.openSession()
        waitFor("sesion abierta", 20) { c.state.value.session != null }
        say("LINKED device=${c.state.value.deviceId} owner=${c.state.value.owner}")
        c.downloadAuthorized()
        waitFor("descarga", 60) { c.state.value.download != null }
        val outcome = c.state.value.download
        say("DOWNLOAD outcome=$outcome")
        assertTrue("descarga completa: $outcome", outcome is DownloadOutcome.Complete)
        val expected = args.getString("groups")?.toInt() ?: 1
        val profile = profileOfLink()
        val groups = repo(db, profile).observeGroups().first()
        assertEquals("solo los grupos autorizados", expected, groups.size)
        say("CACHE profile=$profile groups=" + groups.joinToString("|") { "${it.name}:${it.studentCount}" })
        assertTrue(groups.all { it.studentCount > 0 && it.downloadedAt != null })
    }

    private suspend fun offline(db: EtaDatabase) {
        // 1. Sin internet de verdad: el servidor de pruebas NO responde.
        val online = reachable()
        say("NETWORK reachable=$online")
        assertFalse("la red debe estar apagada en esta fase", online)
        // 2. Todo sale de Room cifrada.
        val profile = profileOfLink()
        val repo = repo(db, profile)
        assertTrue(repo.observeAccess().first() is OfflineAccess.Active)
        val groups = repo.observeGroups().first()
        assertTrue("hay grupos descargados", groups.isNotEmpty())
        val group = groups.first()
        val roster = repo.observeRoster(group.id).first()
        assertTrue("hay padron local", roster.size >= 3)
        val draft = repo.openTodayDraft(group.id)
        assertTrue("se abre la lista de hoy sin red: $draft", draft is OpenDraftResult.Ready)
        val id = (draft as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.Saved, repo.setMark(id, roster[0].id, AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(id, roster[1].id, AttendanceMark.ABSENT))
        val s = repo.observeTodayDraft(group.id).first()!!.summary
        say("CAPTURE group=${group.name} present=${s.present} absent=${s.absent} pending=${s.pending}")
        assertEquals(1, s.present)
        assertEquals(1, s.absent)
        assertTrue(s.pending >= 1)
        say("OFFLINE ok profile=$profile")
    }

    private suspend fun persist(db: EtaDatabase) {
        val profile = profileOfLink()
        val repo = repo(db, profile)
        val group = repo.observeGroups().first().first()
        val s = repo.observeTodayDraft(group.id).first()!!.summary
        say("PERSIST present=${s.present} absent=${s.absent} pending=${s.pending}")
        assertEquals(1, s.present)
        assertEquals(1, s.absent)
        assertNotNull(repo.observeSyncInfo().first())
    }

    private suspend fun reconnect(db: EtaDatabase) {
        assertTrue("la red debe estar encendida", reachable())
        val c = controller(db)
        c.start()
        waitFor("estado vinculado") { c.state.value.stage == Stage.LINKED }
        c.openSession()
        waitFor("sesion", 20) { c.state.value.session != null }
        c.downloadAuthorized()
        waitFor("descarga", 60) { c.state.value.download != null }
        val o = c.state.value.download
        say("RECONNECT outcome=$o")
        assertTrue("descarga completa: $o", o is DownloadOutcome.Complete)
        val expectRevoked = args.getString("expectRevoked")?.toInt() ?: 0
        assertEquals(expectRevoked, (o as DownloadOutcome.Complete).revoked)
        val profile = profileOfLink()
        val repo = repo(db, profile)
        val groups = repo.observeGroups().first()
        say("AFTER groups=" + groups.joinToString("|") { "${it.name}:revoked=${it.revoked}:review=${it.needsReview}" })
        // los borradores NO se perdieron, ni siquiera los de un grupo revocado
        val withDraft = groups.filter { it.hasDraftToday }
        assertTrue("el borrador de la fase offline sigue ahi", withDraft.isNotEmpty())
        if (expectRevoked > 0) {
            val revoked = groups.filter { it.revoked }
            assertEquals(expectRevoked, revoked.size)
            assertTrue(revoked.all { it.needsReview })
            for (g in revoked) {
                assertTrue("padron ajeno bloqueado", repo.observeRoster(g.id).first().isEmpty())
                assertEquals(OpenDraftResult.GroupRevoked, repo.openTodayDraft(g.id))
            }
        }
    }

    private suspend fun isolation(db: EtaDatabase) {
        val profile = profileOfLink()
        val repo = repo(db, profile)
        val mine = repo.observeGroups().first()
        val others = db.catalogDao().let { dao ->
            // perfiles descargados de OTRAS identidades que siguen en la misma base cifrada (cuenta distinta)
            db.openHelper.readableDatabase.query("SELECT id FROM profiles WHERE source = 'SANDBOX' AND id <> '$profile'").use { c ->
                buildList { while (c.moveToNext()) add(c.getString(0)) }
            }
        }
        say("ISOLATION mine=${mine.size} otherProfiles=${others.size}")
        assertTrue("existe cache de otra identidad en el mismo almacenamiento", others.isNotEmpty())
        for (other in others) {
            val otherGroups = db.cacheDao().groupsOf(other)
            assertTrue(otherGroups.isNotEmpty())
            // desde ESTA identidad no se abre ni se lee nada de la otra
            for (g in otherGroups) {
                assertTrue(repo.observeRoster(g.id).first().isEmpty())
                assertEquals(OpenDraftResult.GroupNotFound, repo.openTodayDraft(g.id))
            }
        }
    }

    private companion object {
        const val TAG = "ETA15_E2E"
        const val BASE = "http://10.0.2.2:3000"
    }
}
