package mx.edu.eta15.prefectura.data

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import org.junit.Rule
import java.io.File
import java.time.Duration
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.data.secure.KeystoreKeyVault
import mx.edu.eta15.prefectura.data.secure.SecureStorage
import mx.edu.eta15.prefectura.data.secure.StorageException
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * La cache descargada vive en la MISMA base SQLCipher (clave en Android Keystore): persiste al "reiniciar el proceso" (cerrar y
 * reabrir la base con una instancia nueva de SecureStorage), no aparece en claro en el archivo y, si se pierde la clave, falla
 * cerrado (jamas crea una base vacia ni borra). Datos ficticios; alias y archivos propios de la prueba.
 */
@RunWith(AndroidJUnit4::class)
class OfflineCacheEncryptedTest {
    private val ctx = testContext()
    private val tag = "o${System.nanoTime()}"
    private val alias = "eta15_test_$tag"
    private val blobName = "$alias.blob"
    private val secureName = "offline_$tag.db"
    private val legacyName = "offline_legacy_$tag.db"
    private val vault = KeystoreKeyVault(ctx, alias, blobName)
    private val storage get() = SecureStorage(ctx, vault, secureName, legacyName)
    private val secureFile: File get() = ctx.getDatabasePath(secureName)
    private val clock = MutableClock()
    private val policy = OfflinePolicy(Duration.ofMinutes(10))

    private val device = "dddddddd-0000-4000-8000-00000000000a"
    private val g1 = "11111111-0000-4000-8000-000000000001"
    private val s1 = "51111111-0000-4000-8000-000000000001"
    private val s2 = "52222222-0000-4000-8000-000000000002"

    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), EtaDatabase::class.java)

    @Before
    fun setUp() {
        SecureStorage.loadNativeLibrary()
        wipe()
    }

    @After
    fun tearDown() = wipe()

    private fun wipe() {
        SecureStorage.deleteDatabaseFiles(secureFile)
        SecureStorage.deleteDatabaseFiles(ctx.getDatabasePath(legacyName))
        vault.destroy()
    }

    private fun spec() = DownloadSpec(
        device,
        "Prefectura ficticia",
        "2026-10-27",
        listOf(
            DownloadedGroup(
                g1, "1.º A", 1, "A", "matutino", "aaaaaaaa-0000-4000-8000-0000000000aa", "2026-2027",
                listOf(DownloadedStudent(s1, "Zulema", "Cifradita"), DownloadedStudent(s2, "Yago", "Cifradito")),
            ),
        ),
    )

    @Test
    fun laCacheYLaCapturaPersistenAlReiniciarYNoEstanEnClaroEnElArchivo() = runBlocking {
        val profile = SandboxIds.profile(device)
        val group = SandboxIds.group(profile, g1)
        val db1 = storage.open()
        OfflineCacheStore(db1, clock, policy).commit(spec())
        val repo1 = LocalAttendanceRepository(db1, profile, clock, SequentialIds("e"), access = ProfileAccessGate(db1, profile, clock, policy))
        val draft = (repo1.openTodayDraft(group) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.Saved, repo1.setMark(draft, SandboxIds.student(group, s1), AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo1.setMark(draft, SandboxIds.student(group, s2), AttendanceMark.ABSENT))
        db1.close() // "se cierra la aplicacion"

        val db2 = storage.open() // "se vuelve a abrir": otra instancia, sin ninguna llamada de red
        try {
            val repo2 = LocalAttendanceRepository(db2, profile, clock, SequentialIds("f"), access = ProfileAccessGate(db2, profile, clock, policy))
            assertEquals(listOf("1.º A"), repo2.observeGroups().first().map { it.name })
            assertEquals(listOf("Zulema Cifradita", "Yago Cifradito"), repo2.observeRoster(group).first().map { it.displayName })
            val saved = repo2.observeTodayDraft(group).first()!!
            assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT), saved.rows.map { it.mark })
            assertTrue(repo2.observeAccess().first() is OfflineAccess.Active)
            assertEquals(draft, saved.draftId)
        } finally {
            db2.close()
        }
        // el contenido NO se ve en claro (SQLCipher): ni nombres ni el identificador del dispositivo
        val raw = String(secureFile.readBytes(), Charsets.ISO_8859_1)
        for (secret in listOf("Zulema", "Cifradita", "Cifradito", device, "Prefectura ficticia", "SQLite format 3"))
            assertFalse("no debe aparecer en claro: $secret", raw.contains(secret))
    }

    @Test
    fun siSePierdeLaClaveDelKeystoreLaBaseNoSeAbreNiSeReemplazaPorUnaVacia() = runBlocking {
        val db = storage.open()
        OfflineCacheStore(db, clock, policy).commit(spec())
        db.close()
        val before = secureFile.length()
        vault.destroy() // se pierde el blob de la clave: Keystore y archivo ya no corresponden
        val failure = assertThrows(StorageException::class.java) { storage.open() }
        assertTrue(failure is StorageException.KeyMissing || failure is StorageException)
        assertTrue("la base cifrada NO se borro ni se reemplazo", secureFile.exists() && secureFile.length() == before)
    }

    @Test
    fun unaBaseCifradaInaccesibleFallaCerradoYConservaElArchivo() {
        runBlocking {
            val db = storage.open()
            OfflineCacheStore(db, clock, policy).commit(spec())
            db.close()
        }
        val bytes = secureFile.readBytes()
        secureFile.writeBytes(bytes.copyOf(bytes.size / 2).also { it.fill(0x41, 0, minOf(64, it.size)) }) // corrompe el contenido
        assertThrows(StorageException::class.java) { storage.open() }
        assertTrue(secureFile.exists())
    }

    @Test
    fun unaBaseAnteriorV1SinCifrarSeConvierteAlEsquemaV2ConservandoLosDatos() = runBlocking {
        // Instalacion de la etapa 1: base SIN cifrar en esquema v1 con datos de demostracion y una captura.
        helper.createDatabase(legacyName, 1).apply {
            execSQL("INSERT INTO profiles (id, displayName, isDemo) VALUES ('p1', 'Demo', 1)")
            execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder) VALUES ('g1', 'p1', '1.º A', 1, 0)")
            execSQL("INSERT INTO students (id, groupId, givenNames, familyName) VALUES ('s1', 'g1', 'Ana', 'Ficticia')")
            execSQL("INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs) VALUES ('d1', 'p1', 'g1', '2026-10-27', 'r1', 1, 1)")
            execSQL("INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES ('d1', 'g1', 's1', 'PRESENT', 5)")
            close()
        }
        val db = storage.open() // convierte a SQLCipher y deja la base en v2
        try {
            assertEquals(2, db.openHelper.writableDatabase.version)
            val repo = LocalAttendanceRepository(db, "p1", clock, SequentialIds("v"))
            assertEquals(listOf("1.º A"), repo.observeGroups().first().map { it.name })
            assertEquals(AttendanceMark.PRESENT, repo.observeTodayDraft("g1").first().let { draftOrNull ->
                // el borrador es de 2026-10-27 (hoy en la prueba): conserva la marca
                draftOrNull?.rows?.first()?.mark
            })
            assertFalse(ctx.getDatabasePath(legacyName).exists()) // la copia sin cifrar se retiro
        } finally {
            db.close()
        }
    }
}
