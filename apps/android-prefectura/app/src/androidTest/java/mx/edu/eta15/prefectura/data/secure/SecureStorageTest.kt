package mx.edu.eta15.prefectura.data.secure

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import androidx.room.Room
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.data.LocalAttendanceRepository
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.seedProfile
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Pruebas REALES del almacenamiento cifrado en el emulador: SQLCipher, Android Keystore y archivos de verdad.
 * Cada prueba usa nombres propios de base, de archivo de clave y de alias: no toca la base de la app.
 */
@RunWith(AndroidJUnit4::class)
class SecureStorageTest {
    private val ctx = testContext()
    private val tag = "t${System.nanoTime()}"
    private val alias = "eta15_test_$tag"
    private val blobName = "$alias.blob"
    private val secureName = "secure_$tag.db"
    private val legacyName = "legacy_$tag.db"
    private val vault = KeystoreKeyVault(ctx, alias, blobName)
    private val storage get() = SecureStorage(ctx, vault, secureName, legacyName)
    private val secureFile: File get() = ctx.getDatabasePath(secureName)
    private val legacyFile: File get() = ctx.getDatabasePath(legacyName)
    private val tmpFile: File get() = ctx.getDatabasePath("$secureName.converting")
    private val blob: File get() = File(ctx.noBackupFilesDir, blobName)
    private val clock = MutableClock()

    @Before
    fun setUp() {
        SecureStorage.loadNativeLibrary()
        wipe()
    }

    @After
    fun tearDown() = wipe()

    private fun wipe() {
        for (f in listOf(secureFile, legacyFile, tmpFile)) SecureStorage.deleteDatabaseFiles(f)
        vault.destroy()
    }

    // ---------------------------------------------------------------- utilidades

    private fun dbFiles(base: File) = listOf("", "-wal", "-shm", "-journal").map { File(base.path + it) }.filter { it.exists() }

    private fun allBytes(base: File): ByteArray = dbFiles(base).fold(ByteArray(0)) { acc, f -> acc + f.readBytes() }

    private fun contains(haystack: ByteArray, text: String): Boolean {
        val needle = text.toByteArray(Charsets.UTF_8)
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return true
        }
        return false
    }

    private fun sha(file: File): String =
        MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }

    private fun count(db: EtaDatabase, table: String): Int =
        db.openHelper.readableDatabase.query(SimpleSQLiteQuery("SELECT COUNT(*) FROM $table")).use { it.moveToFirst(); it.getInt(0) }

    /** Crea una base anterior SIN cifrar (como la de la etapa 1) con borradores y marcas ficticias. */
    private fun createLegacyPlainDb(): Map<String, Int> = runBlocking {
        val plain = Room.databaseBuilder(ctx, EtaDatabase::class.java, legacyName).addCallback(EtaDatabase.integrityCallback).build()
        val groups = plain.seedProfile("legacy", listOf(4, 3))
        val repo = LocalAttendanceRepository(plain, "legacy", clock, SequentialIds("L"))
        val draft = (repo.openTodayDraft(groups[0].id) as OpenDraftResult.Ready).draftId
        repo.setMark(draft, groups[0].studentIds[0], AttendanceMark.PRESENT)
        repo.setMark(draft, groups[0].studentIds[1], AttendanceMark.ABSENT)
        val counts = listOf("profiles", "school_groups", "students", "attendance_drafts", "attendance_marks").associateWith { count(plain, it) }
        plain.close()
        counts
    }

    // ---------------------------------------------------------------- base nueva

    @Test
    fun laBaseNuevaEstaRealmenteCifrada() = runBlocking {
        val db = storage.open()
        db.seedProfile("p1", listOf(5, 5))
        // con la base AUN ABIERTA (WAL activo) ya no hay texto claro en ningun archivo
        assertFalse("texto claro en archivos con la base abierta", contains(allBytes(secureFile), "Ficticio"))
        assertFalse(contains(allBytes(secureFile), "Perfil ficticio"))
        db.close()
        assertTrue(secureFile.exists())
        assertFalse("la cabecera no es la de SQLite", SecureStorage.hasPlainSqliteHeader(secureFile))
        assertFalse(contains(secureFile.readBytes().copyOfRange(0, 16), "SQLite format 3"))
        for (f in dbFiles(secureFile)) assertFalse("texto claro en ${f.name}", contains(f.readBytes(), "Ficticio"))
        // SQLite normal (sin clave) no puede leerla
        assertThrows(SQLiteException::class.java) {
            SQLiteDatabase.openDatabase(secureFile.path, null, SQLiteDatabase.OPEN_READONLY).use {
                it.rawQuery("SELECT COUNT(*) FROM sqlite_master", null).use { c -> c.moveToFirst() }
            }
        }
        Unit
    }

    @Test
    fun controlPositivoUnaBaseSinCifrarSiMuestraElTexto() = runBlocking {
        // prueba de que la busqueda de texto claro funciona: en una base Room normal SI aparece
        val plain = Room.databaseBuilder(ctx, EtaDatabase::class.java, legacyName).build()
        plain.seedProfile("p1", listOf(2))
        plain.close()
        assertTrue(contains(allBytes(legacyFile), "Ficticio"))
        assertTrue(SecureStorage.hasPlainSqliteHeader(legacyFile))
    }

    @Test
    fun laClaveDeSQLCipherEsLaProtegidaPorKeystore() = runBlocking {
        storage.open().close()
        // abrir con una clave cualquiera (no la de la bobeda) falla: el archivo no se lee sin la clave correcta
        val wrong = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val factory = net.zetetic.database.sqlcipher.SupportOpenHelperFactory(SecureStorage.rawKeyPassphrase(wrong))
        val db = Room.databaseBuilder(ctx, EtaDatabase::class.java, secureName).openHelperFactory(factory).build()
        try {
            assertThrows(Exception::class.java) { db.openHelper.writableDatabase }
        } finally {
            runCatching { db.close() }
        }
        Unit
    }

    @Test
    fun laBaseSobreviveAlReinicioYNoRegeneraLaClave() = runBlocking {
        val db1 = storage.open()
        val groups = db1.seedProfile("p1", listOf(3))
        val blobBefore = blob.readBytes()
        db1.close()
        // "reinicio del proceso": una instancia nueva solo con los archivos y Keystore
        val db2 = storage.open()
        assertEquals(3, count(db2, "students"))
        assertEquals(groups[0].id, db2.catalogDao().observeGroups("p1", "2026-10-27").first().first().id)
        assertArrayEquals("el blob no cambia", blobBefore, blob.readBytes())
        db2.close()
    }

    // ---------------------------------------------------------------- fail closed

    @Test
    fun siFaltaLaClaveDeKeystoreNoSeCreaUnaBaseVaciaNiSeBorraNada() {
        storage.open().apply { runBlocking { seedProfile("p1", listOf(2)) }; close() }
        val dbHash = sha(secureFile)
        val blobHash = blob.readBytes().toList()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) // clave invalidada
        repeat(2) {
            assertThrows(StorageException.KeyMissing::class.java) { storage.open() }
        }
        assertEquals("la base cifrada queda intacta", dbHash, sha(secureFile))
        assertEquals("el blob queda intacto", blobHash, blob.readBytes().toList())
        assertFalse("no se regenera la clave de Keystore", vault.hasKeystoreKey())
    }

    @Test
    fun siFaltaElArchivoDeLaClaveNoSeCreaUnaBaseVacia() {
        storage.open().apply { runBlocking { seedProfile("p1", listOf(2)) }; close() }
        val dbHash = sha(secureFile)
        assertTrue(blob.delete())
        assertThrows(StorageException.KeyMissing::class.java) { storage.open() }
        assertEquals(dbHash, sha(secureFile))
        assertFalse("no se crea blob nuevo", blob.exists())
    }

    @Test
    fun unBlobAlteradoDetieneLaAperturaSinTocarLaBase() {
        storage.open().apply { runBlocking { seedProfile("p1", listOf(2)) }; close() }
        val dbHash = sha(secureFile)
        val bytes = blob.readBytes()
        bytes[bytes.size - 2] = (bytes[bytes.size - 2].toInt() xor 0x55).toByte()
        blob.writeBytes(bytes)
        assertThrows(StorageException.KeyCorrupt::class.java) { storage.open() }
        assertEquals(dbHash, sha(secureFile))
    }

    @Test
    fun unaClaveEquivocadaSeRechazaYNoSeTocaLaBase() {
        storage.open().apply { runBlocking { seedProfile("p1", listOf(2)) }; close() }
        val dbHash = sha(secureFile)
        val wrongVault = object : KeyVault {
            val wrong = ByteArray(32).also { SecureRandom().nextBytes(it) }
            override fun hasWrappedKey() = true
            override fun hasKeystoreKey() = true
            override fun createAndStore(): ByteArray = error("no debe crear claves")
            override fun load(): ByteArray = wrong.copyOf()
            override fun destroy() = Unit
        }
        assertThrows(StorageException.DatabaseUnreadable::class.java) {
            SecureStorage(ctx, wrongVault, secureName, legacyName).open()
        }
        assertEquals(dbHash, sha(secureFile))
        // y con la clave correcta se abre sin perder nada
        val ok = storage.open()
        assertEquals(2, count(ok, "students"))
        ok.close()
    }

    @Test
    fun unPrimerArranqueInterrumpidoSeRehaceSinPerderDatos() {
        // Solo la clave envuelta (o solo la de Keystore) y NINGUNA base: aun no habia nada cifrado con ella.
        vault.createAndStore()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
        assertFalse(secureFile.exists())
        val db = storage.open()
        assertEquals(0, count(db, "profiles"))
        db.close()
        assertTrue(secureFile.exists())
    }

    // ---------------------------------------------------------------- conversion de la base anterior

    @Test
    fun laBaseAnteriorSinCifrarSeConvierteSinPerderBorradores() = runBlocking {
        val before = createLegacyPlainDb()
        assertTrue(contains(allBytes(legacyFile), "Ficticio"))
        val db = storage.open()
        try {
            assertFalse("la copia sin cifrar se retira", dbFiles(legacyFile).isNotEmpty())
            assertFalse(tmpFile.exists())
            assertFalse(SecureStorage.hasPlainSqliteHeader(secureFile))
            for ((table, n) in before) assertEquals(table, n, count(db, table))
            val repo = LocalAttendanceRepository(db, "legacy", clock, SequentialIds("N"))
            val groups = repo.observeGroups().first()
            assertEquals(2, groups.size)
            val draft = repo.observeTodayDraft(groups[0].id).first()!!
            assertEquals(2, draft.summary.marked)
            assertEquals(1, draft.summary.present)
            assertEquals(1, draft.summary.absent)
            // FKs, unicidad y escritura siguen funcionando sobre la base cifrada
            db.openHelper.readableDatabase.query("PRAGMA foreign_key_check").use { assertEquals(0, it.count) }
            val again = repo.openTodayDraft(groups[0].id) as OpenDraftResult.Ready
            assertFalse(again.created)
            assertEquals(SetMarkResult.Saved, repo.setMark(again.draftId, draft.rows[2].student.id, AttendanceMark.PRESENT))
            assertThrows(Exception::class.java) {
                db.openHelper.writableDatabase.execSQL(
                    "INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES (?, ?, ?, NULL, NULL)",
                    arrayOf(again.draftId, groups[0].id, draft.rows[0].student.id),
                )
            }
        } finally {
            db.close()
        }
        for (f in dbFiles(secureFile)) assertFalse(contains(f.readBytes(), "Ficticio"))
        // sin residuos de la conversion: ni la base anterior, ni sus auxiliares, ni el temporal
        val leftovers = secureFile.parentFile!!.listFiles { f -> f.name.startsWith(legacyName) || f.name.startsWith("$secureName.converting") }
        assertTrue("residuos: ${leftovers?.map { it.name }}", leftovers.isNullOrEmpty())
        // idempotente: abrir otra vez no cambia nada
        val reopened = storage.open()
        assertEquals(before["attendance_marks"], count(reopened, "attendance_marks"))
        reopened.close()
    }

    @Test
    fun laCopiaSinCifrarSobranteSeSobrescribeAntesDeEliminarla() {
        // shredDatabaseFiles es de mejor esfuerzo (flash): aqui solo se comprueba que elimina la base y sus auxiliares
        legacyFile.parentFile!!.mkdirs()
        val secret = "TEXTO-CLARO-DE-PRUEBA".toByteArray()
        for (suffix in listOf("", "-wal", "-shm", "-journal")) File(legacyFile.path + suffix).writeBytes(secret + ByteArray(10_000))
        SecureStorage.shredDatabaseFiles(legacyFile)
        assertTrue(dbFiles(legacyFile).isEmpty())
    }

    @Test
    fun unaConversionInterrumpidaAntesDelRenombradoSeReintentaDesdeLaBaseAnterior() {
        createLegacyPlainDb()
        tmpFile.parentFile!!.mkdirs()
        tmpFile.writeBytes(ByteArray(4096) { 7 }) // resto basura de una conversion interrumpida
        File(tmpFile.path + "-wal").writeBytes(ByteArray(64))
        val db = storage.open()
        db.close()
        assertFalse(tmpFile.exists())
        assertFalse(File(tmpFile.path + "-wal").exists())
        assertFalse(legacyFile.exists())
        assertTrue(secureFile.exists())
    }

    @Test
    fun siLaInterrupcionOcurrioDespuesDelRenombradoSoloSeRetiraLaCopiaSinCifrar() = runBlocking {
        createLegacyPlainDb()
        val plainCopy = legacyFile.readBytes()
        storage.open().close() // conversion completa
        legacyFile.writeBytes(plainCopy) // como si el borrado final no se hubiera ejecutado
        assertTrue(SecureStorage.hasPlainSqliteHeader(legacyFile))
        val encryptedHash = sha(secureFile)
        val db = storage.open()
        assertTrue("sigue abriendo la cifrada con sus datos", count(db, "attendance_marks") > 0)
        db.close()
        assertFalse("se retira la copia sin cifrar sobrante", legacyFile.exists())
        assertFalse(SecureStorage.hasPlainSqliteHeader(secureFile))
        assertEquals("la base cifrada no se modifica", encryptedHash, sha(secureFile))
    }

    @Test
    fun unaBaseAnteriorDeVersionDesconocidaNoSeToca_ni_SeCreaUnaVacia() {
        createLegacyPlainDb()
        SQLiteDatabase.openDatabase(legacyFile.path, null, SQLiteDatabase.OPEN_READWRITE).use { it.version = 7 }
        val hash = allBytes(legacyFile).toList()
        assertThrows(StorageException.UnknownLegacyFormat::class.java) { storage.open() }
        assertEquals("la base anterior queda intacta", hash, allBytes(legacyFile).toList())
        assertFalse("no se crea una base vacia", secureFile.exists())
        assertFalse(tmpFile.exists())
    }

    @Test
    fun unArchivoAnteriorQueNoEsSQLiteNoSeToca() {
        legacyFile.parentFile!!.mkdirs()
        legacyFile.writeBytes(ByteArray(2048) { (it * 31).toByte() })
        val hash = sha(legacyFile)
        assertThrows(StorageException.UnknownLegacyFormat::class.java) { storage.open() }
        assertEquals(hash, sha(legacyFile))
        assertFalse(secureFile.exists())
    }

    @Test
    fun unFalloAlCopiarFilasDejaLaBaseAnteriorIntactaYNoCreaBaseCifrada() {
        createLegacyPlainDb()
        // Una marca con estado invalido (la base anterior permitia saltarse el disparador desactivandolo): la copia
        // a la base cifrada la rechaza por sus disparadores y la conversion aborta.
        SQLiteDatabase.openDatabase(legacyFile.path, null, SQLiteDatabase.OPEN_READWRITE).use {
            it.execSQL("DROP TRIGGER IF EXISTS marks_status_update")
            it.execSQL("UPDATE attendance_marks SET status = 'LATE' WHERE rowid = 1")
        }
        val hash = allBytes(legacyFile).toList()
        assertThrows(StorageException.ConversionFailed::class.java) { storage.open() }
        assertEquals("la base anterior queda intacta", hash, allBytes(legacyFile).toList())
        assertFalse(secureFile.exists())
        assertFalse(tmpFile.exists())
        assertTrue("sigue siendo convertible cuando se corrige", SecureStorage.hasPlainSqliteHeader(legacyFile))
    }

    // ---------------------------------------------------------------- aislamiento y borrado explicito

    @Test
    fun losPerfilesQuedanAisladosEnLaBaseCifradaYSePuedenBorrarPorSeparado() = runBlocking {
        val db = storage.open()
        val a = db.seedProfile("pa", listOf(3))
        val b = db.seedProfile("pb", listOf(2))
        val repoA = LocalAttendanceRepository(db, "pa", clock, SequentialIds("A"))
        val repoB = LocalAttendanceRepository(db, "pb", clock, SequentialIds("B"))
        assertEquals(listOf(a[0].id), repoA.observeGroups().first().map { it.id })
        assertEquals(listOf(b[0].id), repoB.observeGroups().first().map { it.id })
        assertEquals(OpenDraftResult.GroupNotFound, repoB.openTodayDraft(a[0].id))
        val draftA = (repoA.openTodayDraft(a[0].id) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.NotFound, repoB.setMark(draftA, a[0].studentIds[0], AttendanceMark.PRESENT))
        repoB.openTodayDraft(b[0].id)
        // borrar el perfil A no toca al B
        assertEquals(1, db.catalogDao().deleteProfile("pa"))
        assertTrue(repoA.observeGroups().first().isEmpty())
        assertEquals(1, repoB.observeGroups().first().size)
        assertNotNull(repoB.observeTodayDraft(b[0].id).first())
        assertNull(repoA.observeTodayDraft(a[0].id).first())
        db.close()
    }

    @Test
    fun elBorradoExplicitoEliminaBaseYClavesYPermiteEmpezarDeCero() {
        storage.open().apply { runBlocking { seedProfile("p1", listOf(2)) }; close() }
        storage.wipeAll()
        assertFalse(secureFile.exists())
        assertFalse(vault.hasWrappedKey())
        assertFalse(vault.hasKeystoreKey())
        val fresh = storage.open()
        assertEquals(0, count(fresh, "profiles"))
        fresh.close()
    }

    @Test
    fun laCapturaSobreLaBaseCifradaNoUsaRed() = runBlocking {
        // La base cifrada no usa red: el modo avion real se prueba a mano en el emulador (docs/architecture/android-prefectura.md).
        val db = storage.open()
        val g = db.seedProfile("p1", listOf(3))[0]
        val repo = LocalAttendanceRepository(db, "p1", clock, SequentialIds("Z"))
        val draft = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, g.studentIds[0], AttendanceMark.ABSENT))
        assertEquals(1, repo.observeTodayDraft(g.id).first()!!.summary.absent)
        db.close()
    }
}
