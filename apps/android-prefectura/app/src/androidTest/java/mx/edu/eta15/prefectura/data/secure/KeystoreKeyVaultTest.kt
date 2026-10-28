package mx.edu.eta15.prefectura.data.secure

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.security.KeyStore
import javax.crypto.SecretKey
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

/** Pruebas REALES contra Android Keystore del emulador (sin simulaciones). Usan un alias y un archivo propios. */
@RunWith(AndroidJUnit4::class)
class KeystoreKeyVaultTest {
    private val alias = "eta15_test_vault_${System.nanoTime()}"
    private val blobName = "$alias.blob"
    private lateinit var vault: KeystoreKeyVault
    private val blob get() = File(testContext().noBackupFilesDir, blobName)

    @Before
    fun setUp() {
        vault = KeystoreKeyVault(testContext(), alias, blobName)
    }

    @After
    fun tearDown() = vault.destroy()

    @Test
    fun creaUnaClaveAleatoriaDe256BitsYLaRecuperaIgual() {
        val created = vault.createAndStore()
        assertEquals(32, created.size)
        assertTrue(vault.hasWrappedKey() && vault.hasKeystoreKey())
        val loaded = vault.load()
        assertArrayEquals(created, loaded)
        // dos claves nuevas jamas coinciden
        val other = KeystoreKeyVault(testContext(), "${alias}_b", "${blobName}_b")
        try {
            assertFalse(created.contentEquals(other.createAndStore()))
        } finally {
            other.destroy()
        }
    }

    @Test
    fun laClaveNuncaSeGuardaEnClaro() {
        val key = vault.createAndStore()
        val bytes = blob.readBytes()
        val hex = key.joinToString("") { "%02x".format(it) }
        assertFalse("el blob no contiene la clave en binario", indexOf(bytes, key) >= 0)
        assertFalse("el blob no contiene la clave en hex", String(bytes, Charsets.ISO_8859_1).contains(hex))
        assertTrue(bytes.size > key.size) // version + IV + texto cifrado + etiqueta GCM
        // el blob vive fuera de las copias de seguridad
        assertEquals(testContext().noBackupFilesDir.path, blob.parentFile!!.path)
    }

    @Test
    fun laClaveDeKeystoreNoEsExportable() {
        vault.createAndStore()
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val wrap = ks.getKey(alias, null) as SecretKey
        assertNull("Android Keystore no entrega el material de la clave", wrap.encoded)
    }

    @Test
    fun noRegeneraUnaClaveExistente() {
        vault.createAndStore()
        val before = blob.readBytes()
        assertThrows(IllegalStateException::class.java) { vault.createAndStore() }
        assertArrayEquals(before, blob.readBytes())
    }

    @Test
    fun unBlobAlteradoSeRechazaPorAutenticacion() {
        vault.createAndStore()
        val bytes = blob.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x01).toByte() // altera la etiqueta GCM
        blob.writeBytes(bytes)
        assertThrows(StorageException.KeyCorrupt::class.java) { vault.load() }
    }

    @Test
    fun unBlobConVersionDesconocidaOTruncadoSeRechaza() {
        vault.createAndStore()
        val bytes = blob.readBytes()
        blob.writeBytes(byteArrayOf(9) + bytes.copyOfRange(1, bytes.size))
        assertThrows(StorageException.KeyCorrupt::class.java) { vault.load() }
        blob.writeBytes(bytes.copyOfRange(0, 5))
        assertThrows(StorageException.KeyCorrupt::class.java) { vault.load() }
    }

    @Test
    fun siFaltaLaClaveDeKeystoreFallaSinCrearOtra() {
        vault.createAndStore()
        val before = blob.readBytes()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) // clave invalidada/perdida
        assertThrows(StorageException.KeyMissing::class.java) { vault.load() }
        assertFalse("load() no regenera la clave de Keystore", vault.hasKeystoreKey())
        assertArrayEquals("el blob no se toca", before, blob.readBytes())
    }

    @Test
    fun siFaltaElBlobFallaSinCrearOtro() {
        vault.createAndStore()
        assertTrue(blob.delete())
        assertThrows(StorageException.KeyMissing::class.java) { vault.load() }
        assertFalse(blob.exists())
    }

    @Test
    fun unBlobDeOtroAliasNoSePuedeDescifrar() {
        vault.createAndStore()
        val other = KeystoreKeyVault(testContext(), "${alias}_c", "${blobName}_c")
        try {
            other.createAndStore()
            // blob del primero copiado al segundo: otra clave de Keystore y otro AAD => falla la autenticacion
            File(testContext().noBackupFilesDir, "${blobName}_c").writeBytes(blob.readBytes())
            assertThrows(StorageException.KeyCorrupt::class.java) { other.load() }
        } finally {
            other.destroy()
        }
    }

    @Test
    fun destroyEliminaTodoDeFormaExplicita() {
        vault.createAndStore()
        vault.destroy()
        assertFalse(vault.hasWrappedKey())
        assertFalse(vault.hasKeystoreKey())
        assertNotNull(vault) // y se puede crear una nueva solo despues de borrar
        assertEquals(32, vault.createAndStore().size)
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return i
        }
        return -1
    }
}
