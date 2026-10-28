package mx.edu.eta15.prefectura.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Pruebas REALES contra Android Keystore del emulador. Usan un alias propio (nunca el de la app) y comprueban que la firma
 * del dispositivo verifica con la logica de formato que usa el servidor (ES256 / P1363).
 */
@RunWith(AndroidJUnit4::class)
class AndroidDeviceKeyTest {
    private val alias = "eta15_test_device_${System.nanoTime()}"
    private val key = AndroidDeviceKey(alias)

    @After
    fun tearDown() {
        key.delete()
    }

    private fun publicKeyOf(jwk: EcJwk): ECPublicKey {
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
        val decoder = Base64.getUrlDecoder()
        val point = ECPoint(BigInteger(1, decoder.decode(jwk.x)), BigInteger(1, decoder.decode(jwk.y)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params)) as ECPublicKey
    }


    /** Verifica una firma ES256 (r || s, 64 bytes) como lo hace el servidor; Android no ofrece SHA256withECDSAinP1363Format. */
    private fun verifyP1363(pub: ECPublicKey, data: ByteArray, signature: ByteArray): Boolean {
        require(signature.size == 64)
        fun asn1(raw: ByteArray): ByteArray {
            var v = raw.dropWhile { it == 0.toByte() }.toByteArray()
            if (v.isEmpty()) v = byteArrayOf(0)
            if (v[0] < 0) v = byteArrayOf(0) + v
            return byteArrayOf(0x02, v.size.toByte()) + v
        }
        val body = asn1(signature.copyOfRange(0, 32)) + asn1(signature.copyOfRange(32, 64))
        val der = byteArrayOf(0x30, body.size.toByte()) + body
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(data)
            verify(der)
        }
    }
    @Test
    fun laClaveSoloSeCreaDeFormaExplicitaYNuncaSeReemplaza() {
        assertFalse(key.exists())
        key.create()
        assertTrue(key.exists())
        val before = key.publicJwk()
        assertThrows(DeviceKeyException::class.java) { key.create() }
        assertEquals("La clave existente no cambia", before, key.publicJwk())
    }

    @Test
    fun elJwkPublicoTieneElFormatoDelServidor() {
        key.create()
        val jwk = key.publicJwk()
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(jwk.x))
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(jwk.y))
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(jwk.thumbprint()))
        assertTrue(Regex("^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$").matches(jwk.shortFingerprint()))
        assertFalse(jwk.json().contains("\"d\""))
    }

    @Test
    fun laProteccionSeInformaYNoEsDesconocida() {
        key.create()
        assertNotEquals(KeyProtection.UNKNOWN, key.protection())
    }

    @Test
    fun laFirmaDelKeystoreVerificaConLaClavePublicaEnFormatoES256() {
        key.create()
        val pub = publicKeyOf(key.publicJwk())
        repeat(25) {
            val message = "mensaje $it".toByteArray()
            val p1363 = Dpop.derToP1363(key.signDer(message))
            assertEquals(64, p1363.size)
            assertTrue(verifyP1363(pub, message, p1363))
        }
    }

    @Test
    fun laPruebaDpopFirmadaConElKeystoreVerifica() {
        key.create()
        val jwk = key.publicJwk()
        val proof = DpopProofBuilder(jwk, key::signDer).build("GET", "http://10.0.2.2:3000/mobile/me", accessCredential = "ejemplo")
        val parts = proof.split(".")
        assertTrue(verifyP1363(publicKeyOf(jwk), "${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII), Base64.getUrlDecoder().decode(parts[2])))
    }

    @Test
    fun unaClaveDistintaNoVerificaYBorrarLaClaveLaElimina() {
        key.create()
        val other = AndroidDeviceKey("${alias}_otra")
        other.create()
        try {
            val p1363 = Dpop.derToP1363(key.signDer("x".toByteArray()))
            assertFalse(verifyP1363(publicKeyOf(other.publicJwk()), "x".toByteArray(), p1363))
            assertNotEquals(key.publicJwk(), other.publicJwk())
        } finally {
            other.delete()
        }
        key.delete()
        assertFalse(key.exists())
        assertThrows(DeviceKeyException::class.java) { key.signDer("x".toByteArray()) }
        assertThrows(DeviceKeyException::class.java) { key.publicJwk() }
    }

    @Test
    fun laClavePrivadaNoSePuedeExportar() {
        key.create()
        val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val private = keyStore.getKey(alias, null)
        // El Keystore entrega una referencia opaca: sin material de clave
        assertEquals(null, private.encoded)
    }
}
