package mx.edu.eta15.prefectura.data.secure

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mx.edu.eta15.prefectura.AppContainer
import mx.edu.eta15.prefectura.StorageState
import mx.edu.eta15.prefectura.domain.ManualSync
import mx.edu.eta15.prefectura.domain.NoManualSync
import mx.edu.eta15.prefectura.seedProfile
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Boveda real de Keystore con fallos INYECTADOS en cada punto de la apertura, para probar que un fallo nunca destruye datos. */
private class FaultyVault(private val real: KeyVault) : KeyVault {
    var failHasWrapped: StorageException? = null
    var failHasKey: StorageException? = null
    var failCreateBefore: StorageException? = null
    var failCreateAfter: StorageException? = null
    var failLoad: StorageException? = null
    var creates = 0
    var loads = 0
    var destroys = 0

    override fun hasWrappedKey(): Boolean = failHasWrapped?.let { throw it } ?: real.hasWrappedKey()

    override fun hasKeystoreKey(): Boolean = failHasKey?.let { throw it } ?: real.hasKeystoreKey()

    override fun createAndStore(): ByteArray {
        creates++
        failCreateBefore?.let { throw it }
        val key = real.createAndStore()
        failCreateAfter?.let {
            key.fill(0)
            throw it
        }
        return key
    }

    override fun load(): ByteArray {
        loads++
        failLoad?.let { throw it }
        return real.load()
    }

    override fun destroy() {
        destroys++
        real.destroy()
    }
}

/**
 * Resiliencia ante fallos de Android Keystore (Prompt 46). Principio: un fallo para obtener la clave NUNCA borra, reemplaza ni reinterpreta
 * la base cifrada existente. Recuperable = temporal (Keystore no disponible) -> se reintenta y los datos siguen. NO recuperable = clave
 * invalidada, ausente o alterada -> falla cerrado, no regenera la clave, no crea una base vacia y conserva todo para una revision autorizada.
 * Limitacion: la invalidacion real (cambio del bloqueo de pantalla / restablecer credenciales) no se puede provocar en el emulador desde una
 * prueba instrumentada; se SIMULA devolviendo las mismas excepciones que la boveda traduce de Keystore.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreResilienceTest {
    private val ctx = testContext()
    private val tag = "r${System.nanoTime()}"
    private val alias = "eta15_test_$tag"
    private val blobName = "$alias.blob"
    private val secureName = "resilience_$tag.db"
    private val legacyName = "resilience_legacy_$tag.db"
    private val real = KeystoreKeyVault(ctx, alias, blobName)
    private val vault = FaultyVault(real)
    private fun storage() = SecureStorage(ctx, vault, secureName, legacyName)
    private val dbFile: File get() = ctx.getDatabasePath(secureName)
    private val blobFile: File get() = File(ctx.noBackupFilesDir, blobName)

    @Before
    fun setUp() {
        SecureStorage.loadNativeLibrary()
        wipe()
    }

    @After
    fun tearDown() = wipe()

    private fun wipe() {
        SecureStorage.deleteDatabaseFiles(dbFile)
        SecureStorage.deleteDatabaseFiles(ctx.getDatabasePath(legacyName))
        real.destroy()
    }

    private fun sha(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }

    private fun dbFiles() = listOf("", "-wal", "-shm", "-journal").map { File(dbFile.path + it) }.filter { it.exists() }

    /** Estado completo de lo que hay en disco: nada debe cambiar tras un fallo. */
    private fun snapshot() = dbFiles().map { it.name to sha(it) } + (blobName to sha(blobFile))

    /** La primera apertura invoca destroy() una vez sobre un almacenamiento VACIO (inocuo); lo que importa es que despues no se vuelva a llamar. */
    private var baseDestroys = 0

    private fun seeded(): Int = runBlocking {
        val db = storage().open()
        val groups = db.seedProfile("p-$tag", listOf(3, 2))
        db.close()
        baseDestroys = vault.destroys
        groups.size
    }

    private fun profiles() = runBlocking {
        val db = storage().open()
        try {
            db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM students").use { it.moveToFirst(); it.getInt(0) }
        } finally {
            db.close()
        }
    }

    // ------------------------------------------------------------------------------------------------------------ casos felices

    @Test
    fun laPrimeraAperturaCreaLaClaveUnaVezYLaBaseCifrada() {
        storage().open().close()
        assertEquals(1, vault.creates)
        assertTrue(dbFile.exists() && blobFile.exists())
        assertFalse(SecureStorage.hasPlainSqliteHeader(dbFile))
    }

    @Test
    fun reiniciarDespuesDeAbrirConservaLosDatosSinNuevasClaves() {
        seeded()
        val before = snapshot().map { it.first }
        assertEquals(5, profiles()) // "reinicio": otra instancia de SecureStorage
        assertEquals(1, vault.creates) // nunca se regenera
        assertEquals(baseDestroys, vault.destroys)
        assertEquals(before.toSet(), snapshot().map { it.first }.toSet())
    }

    // ------------------------------------------------------------------------------------------------ fallo TEMPORAL: recuperable

    @Test
    fun unFalloTemporalDeKeystoreNoTocaNadaYSeRecuperaAlReintentar() {
        seeded()
        val before = snapshot()
        vault.failLoad = StorageException.KeystoreUnavailable(java.io.IOException("keystore2 ocupado"))
        repeat(3) { assertThrows(StorageException.KeystoreUnavailable::class.java) { storage().open() } }
        assertEquals("la base y la clave quedaron EXACTAMENTE igual", before, snapshot())
        assertEquals(1, vault.creates)
        assertEquals(baseDestroys, vault.destroys)
        vault.failLoad = null // el proveedor vuelve
        assertEquals("los datos siguen ahi", 5, profiles())
    }

    @Test
    fun unFalloAntesDeObtenerLaClaveConUnaBaseExistenteNoLaReemplazaNiLaBorra() {
        seeded()
        val before = snapshot()
        vault.failHasKey = StorageException.KeystoreUnavailable(java.io.IOException("sin Keystore"))
        assertThrows(StorageException.KeystoreUnavailable::class.java) { storage().open() }
        vault.failHasKey = null
        vault.failHasWrapped = StorageException.KeystoreUnavailable(java.io.IOException("sin disco"))
        assertThrows(StorageException.KeystoreUnavailable::class.java) { storage().open() }
        assertEquals(before, snapshot())
        assertEquals(baseDestroys, vault.destroys)
        assertEquals(1, vault.creates)
        vault.failHasWrapped = null
        assertEquals(5, profiles())
    }

    // -------------------------------------------------------------------------------------- invalidacion PERMANENTE: NO recuperable

    @Test
    fun unaClaveInvalidadaFallaCerradoYConservaBaseYClaveSinCrearNada() {
        seeded()
        val before = snapshot()
        vault.failLoad = StorageException.KeyInvalidated(java.security.InvalidKeyException("KeyPermanentlyInvalidated (simulada)"))
        repeat(3) { assertThrows(StorageException.KeyInvalidated::class.java) { storage().open() } } // y sigue igual en cada intento
        assertEquals("nada cambio: ni la base, ni el blob de la clave", before, snapshot())
        assertEquals("jamas se regenera la clave", 1, vault.creates)
        assertEquals("jamas se borra nada", baseDestroys, vault.destroys)
        assertTrue(real.hasKeystoreKey() && real.hasWrappedKey()) // el material existente se conserva para una revision autorizada
        assertEquals("sin base vacia encima: sigue siendo el mismo archivo", before.size, snapshot().size)
    }

    @Test
    fun unBlobAusenteOAlteradoConBaseExistenteTampocoSeReemplaza() {
        seeded()
        val dbBefore = snapshot().filter { it.first.startsWith("resilience") }
        vault.failLoad = StorageException.KeyCorrupt()
        assertThrows(StorageException.KeyCorrupt::class.java) { storage().open() }
        vault.failLoad = StorageException.KeyMissing("simulada")
        assertThrows(StorageException.KeyMissing::class.java) { storage().open() }
        assertEquals(dbBefore, snapshot().filter { it.first.startsWith("resilience") })
        assertEquals(baseDestroys, vault.destroys)
    }

    @Test
    fun ningunFalloDeClaveFiltraMaterialSecretoEnMensajesNiTrazas() {
        seeded()
        val secret = real.load()
        val hex = secret.joinToString("") { "%02x".format(it) }
        val b64 = java.util.Base64.getEncoder().encodeToString(secret)
        secret.fill(0)
        val faults = listOf<StorageException>(
            StorageException.KeyInvalidated(java.security.InvalidKeyException("x")),
            StorageException.KeystoreUnavailable(java.io.IOException("y")),
            StorageException.KeyCorrupt(),
            StorageException.KeyMissing("z"),
        )
        for (fault in faults) {
            vault.failLoad = fault
            val e = assertThrows(StorageException::class.java) { storage().open() }
            val text = e.message.orEmpty() + e.toString() + e.stackTraceToString()
            assertFalse(text.contains(hex) || text.contains(b64))
            assertFalse(text.contains(ctx.noBackupFilesDir.path) || text.contains(dbFile.path)) // ni rutas internas en el mensaje
        }
    }

    // ----------------------------------------------------------------------------------------- primera apertura con fallos en medio

    @Test
    fun unFalloAntesDeCrearLaClaveNoDejaPiezasYSePuedeReintentar() {
        vault.failCreateBefore = StorageException.KeystoreUnavailable(java.io.IOException("antes"))
        assertThrows(StorageException.KeystoreUnavailable::class.java) { storage().open() }
        assertFalse(dbFile.exists())
        assertFalse(blobFile.exists())
        vault.failCreateBefore = null
        storage().open().close()
        assertTrue(dbFile.exists())
    }

    @Test
    fun unFalloDespuesDeCrearLaClaveNoCreaBaseYElReintentoReutilizaLaClaveSinPerderNada() {
        vault.failCreateAfter = StorageException.KeystoreUnavailable(java.io.IOException("despues"))
        assertThrows(StorageException.KeystoreUnavailable::class.java) { storage().open() }
        assertFalse("no se creo ninguna base", dbFile.exists())
        vault.failCreateAfter = null
        storage().open().close() // las piezas consistentes que quedaron se reutilizan (aun no hay datos que proteger)
        assertEquals(1, vault.creates) // la segunda apertura REUTILIZA las piezas consistentes: no genera otra clave
        assertTrue(dbFile.exists())
        assertEquals(0, profiles())
    }

    // ---------------------------------------------------- reapertura tras fallo y la aplicacion: nada se abre, nada se envia, nada se mezcla

    private suspend fun AppContainer.awaitSettled(): StorageState = withTimeout(20_000) {
        while (storage.value is StorageState.Opening) delay(25)
        storage.value
    }

    @Test
    fun conUnaClaveInvalidadaLaAplicacionNoMuestraDatosNiOfreceSincronizacionYSeConservaTodo() = runBlocking<Unit> {
        seeded()
        val before = snapshot()
        vault.failLoad = StorageException.KeyInvalidated(java.security.InvalidKeyException("simulada"))
        val container = AppContainer(opener = { storage().open() }, profileId = "p-$tag")
        container.start()
        val state = container.awaitSettled()
        assertTrue(state is StorageState.Failed && state.error is StorageException.KeyInvalidated)
        // sin base abierta no hay repositorios ni cache, y por tanto ningun transporte: no puede haber escrituras HTTP ni estados falsos
        assertNull(container.sandboxRepository("sbx.cualquiera"))
        assertNull(container.offlineCache)
        val sync: ManualSync = container.manualSync("sbx.cualquiera")
        assertTrue(sync === NoManualSync && !sync.available)
        assertEquals(before, snapshot())
        // reintentar mientras la clave siga invalidada: el mismo resultado y nada se destruye
        val loadsBefore = vault.loads
        container.retryOpen()
        withTimeout(20_000) { while (vault.loads == loadsBefore) delay(25) } // el reintento SI se ejecuto
        delay(300)
        assertTrue(container.awaitSettled() is StorageState.Failed)
        assertEquals(before, snapshot())
        assertEquals(baseDestroys, vault.destroys)
    }

    @Test
    fun unFalloTemporalSeRecuperaConReintentarYLosDatosSiguenIntactos() = runBlocking<Unit> {
        seeded()
        vault.failLoad = StorageException.KeystoreUnavailable(java.io.IOException("temporal"))
        val container = AppContainer(opener = { storage().open() }, profileId = "p-$tag")
        container.start()
        assertTrue(container.awaitSettled() is StorageState.Failed)
        vault.failLoad = null // el proveedor vuelve
        container.retryOpen()
        val ready = withTimeout(20_000) {
            while (container.storage.value !is StorageState.Ready) delay(25)
            container.storage.value
        }
        assertTrue(ready is StorageState.Ready)
        assertEquals(2, (ready as StorageState.Ready).repository.observeGroups().first().size) // los mismos grupos sembrados
    }

    @Test
    fun dosPerfilesNoSeMezclanTrasUnFalloYUnaReapertura() = runBlocking<Unit> {
        val db = storage().open()
        db.seedProfile("perfil-a", listOf(2))
        db.seedProfile("perfil-b", listOf(3))
        db.close()
        vault.failLoad = StorageException.KeystoreUnavailable(java.io.IOException("temporal"))
        assertThrows(StorageException.KeystoreUnavailable::class.java) { storage().open() }
        vault.failLoad = null
        val again = storage().open()
        try {
            val a = mx.edu.eta15.prefectura.data.LocalAttendanceRepository(again, "perfil-a", java.time.Clock.systemUTC())
            val b = mx.edu.eta15.prefectura.data.LocalAttendanceRepository(again, "perfil-b", java.time.Clock.systemUTC())
            assertEquals(1, a.observeGroups().first().size)
            assertEquals(1, b.observeGroups().first().size)
            assertEquals(2, a.observeRoster(a.observeGroups().first().single().id).first().size)
            assertEquals(3, b.observeRoster(b.observeGroups().first().single().id).first().size)
        } finally {
            again.close()
        }
    }
}
