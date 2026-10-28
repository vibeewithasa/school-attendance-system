package mx.edu.eta15.prefectura.mobile

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** Donde vive la clave privada del dispositivo (informativo; la aplicacion no puede exportarla en ninguno de los casos). */
enum class KeyProtection { STRONGBOX, TRUSTED_ENVIRONMENT, SOFTWARE, UNKNOWN }

/** Fallo al manejar la clave del dispositivo. Nunca se arregla "en silencio" creando otra clave. */
class DeviceKeyException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Clave de identidad de ESTE dispositivo. La privada no se exporta ni se guarda fuera del Keystore; solo se puede firmar.
 * Una clave NUEVA cambia la identidad del dispositivo, asi que solo se crea de forma EXPLICITA ([create]) y nunca se reemplaza
 * una existente.
 */
interface DeviceKey {
    fun exists(): Boolean

    /** Crea la clave. Falla si ya existe (no hay regeneracion silenciosa). */
    fun create()

    fun publicJwk(): EcJwk

    fun protection(): KeyProtection

    /** Firma ECDSA SHA-256 en formato DER. */
    fun signDer(data: ByteArray): ByteArray

    /** Borra la clave (accion explicita de "olvidar este dispositivo"). */
    fun delete()
}

/**
 * Implementacion con Android Keystore: EC P-256, solo para firmar con SHA-256. Se intenta StrongBox y, si el equipo no lo tiene,
 * el entorno seguro del sistema (TEE) o software segun lo que ofrezca el dispositivo; [protection] informa cual quedo.
 *
 * Decision pendiente (ADR 0005): exigir desbloqueo del equipo o biometria para firmar (`setUserAuthenticationRequired`). No se
 * activa en este prototipo: en el emulador de pruebas no hay credencial configurada y daria un falso sentido de proteccion.
 */
class AndroidDeviceKey(private val alias: String = DEFAULT_ALIAS) : DeviceKey {
    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    override fun exists(): Boolean = try {
        keyStore().containsAlias(alias)
    } catch (e: Exception) {
        throw DeviceKeyException("No se pudo consultar el Keystore", e)
    }

    override fun create() {
        if (exists()) throw DeviceKeyException("Ya existe una clave de dispositivo: no se reemplaza")
        val tryStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        try {
            generate(strongBox = tryStrongBox)
        } catch (e: Exception) {
            if (!tryStrongBox) throw DeviceKeyException("No se pudo crear la clave", e)
            // Sin StrongBox (cada fabricante lanza una excepcion distinta): se usa el entorno seguro normal del equipo.
            try {
                generate(strongBox = false)
            } catch (second: Exception) {
                throw DeviceKeyException("No se pudo crear la clave", second)
            }
        }
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
    }

    private fun privateKey(): PrivateKey = try {
        keyStore().getKey(alias, null) as? PrivateKey ?: throw DeviceKeyException("Falta la clave de este dispositivo")
    } catch (e: DeviceKeyException) {
        throw e
    } catch (e: Exception) {
        throw DeviceKeyException("No se pudo leer la clave del Keystore", e)
    }

    override fun publicJwk(): EcJwk = try {
        val certificate = keyStore().getCertificate(alias) ?: throw DeviceKeyException("Falta la clave de este dispositivo")
        Dpop.jwkOf(certificate.publicKey as ECPublicKey)
    } catch (e: DeviceKeyException) {
        throw e
    } catch (e: Exception) {
        throw DeviceKeyException("No se pudo leer la clave publica", e)
    }

    override fun protection(): KeyProtection = try {
        val key = privateKey()
        val info = KeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> KeyProtection.STRONGBOX
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> KeyProtection.TRUSTED_ENVIRONMENT
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> KeyProtection.SOFTWARE
                else -> KeyProtection.UNKNOWN
            }
        } else {
            legacyProtection(info)
        }
    } catch (e: Exception) {
        KeyProtection.UNKNOWN
    }

    @Suppress("DEPRECATION")
    private fun legacyProtection(info: KeyInfo): KeyProtection =
        if (info.isInsideSecureHardware) KeyProtection.TRUSTED_ENVIRONMENT else KeyProtection.SOFTWARE

    override fun signDer(data: ByteArray): ByteArray = try {
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey())
            update(data)
            sign()
        }
    } catch (e: DeviceKeyException) {
        throw e
    } catch (e: Exception) {
        throw DeviceKeyException("No se pudo firmar con la clave del dispositivo", e)
    }

    override fun delete() {
        try {
            keyStore().deleteEntry(alias)
        } catch (e: Exception) {
            throw DeviceKeyException("No se pudo borrar la clave", e)
        }
    }

    companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val DEFAULT_ALIAS = "eta15_mobile_device_key"
    }
}
