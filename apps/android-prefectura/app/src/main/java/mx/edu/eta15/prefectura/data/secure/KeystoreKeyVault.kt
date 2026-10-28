package mx.edu.eta15.prefectura.data.secure

import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.GeneralSecurityException
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.SecureRandom
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Custodia de la clave de la base. Separado en interfaz para poder probar fallos (clave equivocada, Keystore ausente). */
interface KeyVault {
    fun hasWrappedKey(): Boolean

    fun hasKeystoreKey(): Boolean

    /** Genera y guarda una clave nueva. Solo debe llamarse si no existe NINGUNA pieza; nunca regenera. */
    fun createAndStore(): ByteArray

    fun load(): ByteArray

    /** Borrado EXPLICITO de la clave y sus piezas. */
    fun destroy()
}

/**
 * Proteccion de la clave de la base con Android Keystore (sin criptografia propia):
 *
 *  - La clave de la BASE es de 256 bits aleatorios (`SecureRandom`); no se deriva de ningun identificador ni se escribe
 *    en claro.
 *  - Se "envuelve" con una clave AES-256-GCM **no exportable** que vive en Android Keystore (en StrongBox si el equipo
 *    lo tiene). Solo el blob envuelto (version + IV + texto cifrado + etiqueta GCM) se guarda, en `noBackupFilesDir`
 *    (excluido de copias de seguridad y de transferencia entre dispositivos).
 *  - La clave de Keystore no exige todavia autenticacion del usuario (la demostracion no tiene sesion); cuando exista el
 *    login seguro se le puede exigir (ver ADR 0005).
 *
 * Fail closed: si el blob existe pero la clave de Keystore no (o al reves), [load] lanza una [StorageException] y NO se
 * crea una clave nueva. Solo [createAndStore] genera claves y solo se llama cuando no existe NINGUNA de las dos piezas.
 */
class KeystoreKeyVault(
    private val context: Context,
    private val alias: String = DEFAULT_ALIAS,
    private val blobName: String = DEFAULT_BLOB,
) : KeyVault {
    private val blobFile: File get() = File(context.noBackupFilesDir, blobName)

    override fun hasWrappedKey(): Boolean = blobFile.exists()

    override fun hasKeystoreKey(): Boolean = try {
        keyStore().containsAlias(alias)
    } catch (e: GeneralSecurityException) {
        throw StorageException.KeystoreUnavailable(e)
    }

    /** Genera la clave de la base, la envuelve y la guarda. Devuelve los bytes (quien llama debe ponerlos a cero). */
    override fun createAndStore(): ByteArray {
        check(!hasWrappedKey() && !hasKeystoreKey()) { "Ya existe una clave: no se regenera" }
        val dbKey = ByteArray(KEY_BYTES).also { SecureRandom().nextBytes(it) }
        try {
            val wrapKey = createKeystoreKey()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, wrapKey)
            cipher.updateAAD(aad())
            val encrypted = cipher.doFinal(dbKey)
            val iv = cipher.iv
            writeAtomically(byteArrayOf(VERSION, iv.size.toByte()) + iv + encrypted)
            return dbKey
        } catch (e: GeneralSecurityException) {
            dbKey.fill(0)
            // Si fallo a medias, retira lo que se creo para no dejar una mitad (aun no hay datos cifrados con ella).
            runCatching { deleteKeystoreKey() }
            runCatching { blobFile.delete() }
            throw StorageException.KeystoreUnavailable(e)
        }
    }

    /** Recupera la clave de la base. Devuelve una copia nueva (quien llama debe ponerla a cero). */
    override fun load(): ByteArray {
        val blob = try {
            blobFile.readBytes()
        } catch (e: java.io.IOException) {
            throw StorageException.KeyMissing("Falta el archivo de la clave protegida")
        }
        if (blob.size < 2 + IV_MIN || blob[0] != VERSION) throw StorageException.KeyCorrupt()
        val ivLength = blob[1].toInt() and 0xFF
        if (ivLength < IV_MIN || blob.size <= 2 + ivLength) throw StorageException.KeyCorrupt()
        val iv = blob.copyOfRange(2, 2 + ivLength)
        val encrypted = blob.copyOfRange(2 + ivLength, blob.size)
        val wrapKey: SecretKey = try {
            keyStore().getKey(alias, null) as? SecretKey
        } catch (e: UnrecoverableKeyException) {
            throw StorageException.KeyInvalidated(e)
        } catch (e: GeneralSecurityException) {
            throw StorageException.KeystoreUnavailable(e)
        } ?: throw StorageException.KeyMissing("Falta la clave de Android Keystore")
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, wrapKey, GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(aad())
            cipher.doFinal(encrypted)
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw StorageException.KeyInvalidated(e)
        } catch (e: AEADBadTagException) {
            throw StorageException.KeyCorrupt(e)
        } catch (e: InvalidKeyException) {
            throw StorageException.KeyInvalidated(e)
        } catch (e: GeneralSecurityException) {
            throw StorageException.KeystoreUnavailable(e)
        }
    }

    /** Borrado EXPLICITO (autorizado por la persona o por una politica): elimina la clave de Keystore y el blob. */
    override fun destroy() {
        runCatching { deleteKeystoreKey() }
        runCatching { blobFile.delete() }
        runCatching { File(blobFile.path + TMP_SUFFIX).delete() }
    }

    // ---- internos ----

    private fun aad(): ByteArray = "$alias|v$VERSION".toByteArray(Charsets.UTF_8)

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun deleteKeystoreKey() {
        val ks = keyStore()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
    }

    private fun createKeystoreKey(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        // StrongBox (hardware dedicado) existe desde Android 9 (API 28); minSdk es 26: se prueba solo donde es posible.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generateWithStrongBox(generator)
            } catch (_: StrongBoxUnavailableException) {
                // el equipo no tiene StrongBox: se usa el Keystore respaldado por el entorno seguro (TEE) o por software
            }
        }
        generator.init(keySpec(strongBox = false))
        return generator.generateKey()
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private fun generateWithStrongBox(generator: KeyGenerator): SecretKey {
        generator.init(keySpec(strongBox = true))
        return generator.generateKey()
    }

    private fun keySpec(strongBox: Boolean): KeyGenParameterSpec {
        val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setStrongBox(builder)
        return builder.build()
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private fun setStrongBox(builder: KeyGenParameterSpec.Builder) {
        builder.setIsStrongBoxBacked(true)
    }
    private fun writeAtomically(bytes: ByteArray) {
        val dir = blobFile.parentFile!!.also { it.mkdirs() }
        val tmp = File(dir, blobName + TMP_SUFFIX)
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        Files.move(tmp.toPath(), blobFile.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    companion object {
        const val DEFAULT_ALIAS = "eta15_db_wrap_v1"
        const val DEFAULT_BLOB = "eta15_db_key_v1.blob"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val KEY_BYTES = 32
        private const val IV_MIN = 12
        private const val VERSION: Byte = 1
        private const val TMP_SUFFIX = ".tmp"
    }
}
