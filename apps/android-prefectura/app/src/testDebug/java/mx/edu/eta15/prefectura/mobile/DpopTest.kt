package mx.edu.eta15.prefectura.mobile

import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pruebas JVM de la prueba de posesion DPoP del cliente. El vector de huella se calculo con la implementacion del SERVIDOR
 * (Node, `dpop.ts`): si cambia el formato en cualquiera de los dos lados, estas pruebas deben fallar.
 */
class DpopTest {
    // Coordenadas de ejemplo (no son un punto real de la curva: la huella no lo valida).
    private val jwk = EcJwk("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA", "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A")

    @Test
    fun `la huella RFC 7638 y la huella corta coinciden con las del servidor`() {
        assertEquals("""{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}""", jwk.canonicalJson())
        assertEquals("t1ZI8tOt77KZ9YepYcUiqtqXcpIYInMJhkFb6casAFo", jwk.thumbprint())
        assertEquals("B59A-0E98-982E", jwk.shortFingerprint())
    }

    @Test
    fun `ath coincide con el calculo del servidor`() {
        assertEquals("MoaGeXDfnieAbrdnVLI7jaUEw-iZd3_iK-MDQNeYEuw", Dpop.accessHash("abc-token-ejemplo"))
    }

    @Test
    fun `el JWK publico solo contiene kty crv x e y`() {
        val json = jwk.json()
        assertEquals("""{"kty":"EC","crv":"P-256","x":"${jwk.x}","y":"${jwk.y}"}""", json)
        assertFalse(json.contains("\"d\""))
    }

    @Test
    fun `las coordenadas se rellenan a 32 bytes y se rechazan si exceden`() {
        assertEquals(32, Dpop.coordinate(BigInteger.ONE).size)
        assertEquals(1, Dpop.coordinate(BigInteger.ONE)[31].toInt())
        // 33 bytes con el cero de signo de BigInteger
        val high = BigInteger(1, ByteArray(32) { 0xFF.toByte() })
        val bytes = Dpop.coordinate(high)
        assertEquals(32, bytes.size)
        assertTrue(bytes.all { it == 0xFF.toByte() })
        try {
            Dpop.coordinate(BigInteger.ONE.shiftLeft(256))
            fail("debio fallar")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun `jsonString escapa comillas barras y controles`() {
        assertEquals("\"a\\\"b\\\\c\\u000ad\"", Dpop.jsonString("a\"b\\c\nd"))
    }

    private fun der(r: ByteArray, s: ByteArray): ByteArray {
        fun int(v: ByteArray) = byteArrayOf(0x02, v.size.toByte()) + v
        val body = int(r) + int(s)
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    @Test
    fun `DER a P1363 rellena enteros cortos y quita el cero de signo`() {
        val shortR = ByteArray(31) { 7 }
        val longS = byteArrayOf(0) + ByteArray(32) { 0xFE.toByte() } // 33 bytes: cero de signo
        val out = Dpop.derToP1363(der(shortR, longS))
        assertEquals(64, out.size)
        assertEquals(0, out[0].toInt()) // r se rellena a la izquierda
        assertArrayEquals(shortR, out.copyOfRange(1, 32))
        assertArrayEquals(ByteArray(32) { 0xFE.toByte() }, out.copyOfRange(32, 64))
    }

    @Test
    fun `DER mal formado se rechaza`() {
        val good = der(ByteArray(32) { 1 }, ByteArray(32) { 2 })
        val broken = listOf(
            good.copyOfRange(0, good.size - 1), // truncada
            good + byteArrayOf(0), // bytes sobrantes
            byteArrayOf(0x31) + good.copyOfRange(1, good.size), // no es SEQUENCE
            ByteArray(0),
            der(ByteArray(33) { 1 }, ByteArray(32) { 2 }), // r de 33 bytes sin cero de signo (excede 32)
        )
        for (candidate in broken) {
            try {
                Dpop.derToP1363(candidate)
                fail("debio rechazar ${candidate.size} bytes")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    @Test
    fun `una firma real de la JVM se convierte a P1363 y verifica`() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        repeat(40) { // varias firmas: hay longitudes de r y s distintas
            val message = "mensaje $it".toByteArray()
            val derSig = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(message); sign() }
            val p1363 = Dpop.derToP1363(derSig)
            assertEquals(64, p1363.size)
            val ok = Signature.getInstance("SHA256withECDSAinP1363Format").run {
                initVerify(pair.public)
                update(message)
                verify(p1363)
            }
            assertTrue(ok)
        }
    }

    @Test
    fun `la prueba DPoP lleva los datos exigidos y su firma verifica con la clave publica`() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val realJwk = Dpop.jwkOf(pair.public as ECPublicKey)
        val signer: (ByteArray) -> ByteArray = { data -> Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() } }
        val clock = Clock.fixed(Instant.ofEpochSecond(1_800_000_000), ZoneOffset.UTC)
        val builder = DpopProofBuilder(realJwk, signer, clock)

        val proof = builder.build("post", "http://10.0.2.2:3000/mobile/auth/token", accessCredential = "credencial-de-ejemplo", nonce = "n\"1")
        val parts = proof.split(".")
        assertEquals(3, parts.size)
        val decoder = Base64.getUrlDecoder()
        val header = String(decoder.decode(parts[0]), Charsets.UTF_8)
        val claims = String(decoder.decode(parts[1]), Charsets.UTF_8)
        assertTrue(header.contains("\"typ\":\"dpop+jwt\"") && header.contains("\"alg\":\"ES256\""))
        assertTrue(header.contains(realJwk.json()))
        assertFalse(header.contains("\"d\""))
        assertTrue(claims.contains("\"htm\":\"POST\""))
        assertTrue(claims.contains("\"htu\":\"http://10.0.2.2:3000/mobile/auth/token\""))
        assertTrue(claims.contains("\"iat\":1800000000"))
        assertTrue(claims.contains("\"ath\":\"${Dpop.accessHash("credencial-de-ejemplo")}\""))
        assertTrue(claims.contains("\"nonce\":\"n\\\"1\""))
        assertTrue(Regex("\"jti\":\"[A-Za-z0-9_-]{22}\"").containsMatchIn(claims))

        val ok = Signature.getInstance("SHA256withECDSAinP1363Format").run {
            initVerify(pair.public)
            update("${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII))
            verify(decoder.decode(parts[2]))
        }
        assertTrue(ok)
    }

    @Test
    fun `cada prueba tiene un jti distinto y sin credencial no hay ath ni nonce`() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val builder = DpopProofBuilder(Dpop.jwkOf(pair.public as ECPublicKey), { d -> Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(d); sign() } })
        val claimsOf = { p: String -> String(Base64.getUrlDecoder().decode(p.split(".")[1]), Charsets.UTF_8) }
        val a = claimsOf(builder.build("GET", "http://10.0.2.2:3000/mobile/enroll/requests/x"))
        val b = claimsOf(builder.build("GET", "http://10.0.2.2:3000/mobile/enroll/requests/x"))
        assertFalse(a.contains("\"ath\"") || a.contains("\"nonce\""))
        val jti = { c: String -> Regex("\"jti\":\"([^\"]+)\"").find(c)!!.groupValues[1] }
        assertTrue(jti(a) != jti(b))
    }
}
