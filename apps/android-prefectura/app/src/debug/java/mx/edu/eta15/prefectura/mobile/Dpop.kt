package mx.edu.eta15.prefectura.mobile

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.time.Clock
import java.util.Base64

/**
 * SOLO debug (prototipo de autenticacion movil AISLADA; ADR 0005 esta en estado "propuesta", no aceptada).
 *
 * Prueba de posesion de la clave del dispositivo (DPoP, RFC 9449) con ECDSA P-256 / SHA-256 (ES256). Este archivo es Kotlin
 * puro (sin Android) para poder probarlo en la JVM. Nunca maneja la clave privada: la firma la entrega quien la custodia
 * (Android Keystore) y aqui solo se arma el mensaje y se convierte el formato de la firma.
 */
object Dpop {
    fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    /** Valor de `ath`: SHA-256 del credencial de acceso (ASCII) en base64url. */
    fun accessHash(access: String): String = b64(sha256(access.toByteArray(Charsets.US_ASCII)))

    /** Escapa una cadena como literal JSON (comillas incluidas). */
    fun jsonString(value: String): String {
        val out = StringBuilder("\"")
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c < ' ' -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }

    /** Coordenada afin como 32 bytes sin signo, big-endian (RFC 7518 §6.2.1.2). */
    fun coordinate(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        val stripped = if (raw.size > 1 && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
        require(stripped.size <= 32) { "Coordenada fuera de rango" }
        return ByteArray(32).also { stripped.copyInto(it, 32 - stripped.size) }
    }

    fun jwkOf(key: ECPublicKey): EcJwk =
        EcJwk(b64(coordinate(key.w.affineX)), b64(coordinate(key.w.affineY)))

    /**
     * Convierte una firma ECDSA en DER (SEQUENCE { INTEGER r, INTEGER s }, la que produce Android Keystore) al formato P1363
     * (r || s, 64 bytes) que exige JWS ES256. Rechaza cualquier estructura que no sea exactamente esa.
     */
    fun derToP1363(der: ByteArray, size: Int = 32): ByteArray {
        try {
            var i = 0
            require(der[i++] == 0x30.toByte()) { "No es una SEQUENCE" }
            var length = der[i++].toInt() and 0xFF
            if (length and 0x80 != 0) {
                val bytes = length and 0x7F
                require(bytes in 1..2) { "Longitud no admitida" }
                length = 0
                repeat(bytes) { length = (length shl 8) or (der[i++].toInt() and 0xFF) }
            }
            require(length == der.size - i) { "Longitud inconsistente" }

            fun readInteger(): ByteArray {
                require(der[i++] == 0x02.toByte()) { "No es un INTEGER" }
                val l = der[i++].toInt() and 0xFF
                require(l in 1..(size + 1) && i + l <= der.size) { "INTEGER fuera de rango" }
                val value = der.copyOfRange(i, i + l)
                i += l
                var start = 0
                while (start < value.size - 1 && value[start] == 0.toByte()) start++
                val trimmed = value.copyOfRange(start, value.size)
                require(trimmed.size <= size) { "INTEGER demasiado largo" }
                return trimmed
            }

            val r = readInteger()
            val s = readInteger()
            require(i == der.size) { "Bytes sobrantes" }
            val out = ByteArray(size * 2)
            r.copyInto(out, size - r.size)
            s.copyInto(out, 2 * size - s.size)
            return out
        } catch (e: IndexOutOfBoundsException) {
            throw IllegalArgumentException("Firma DER truncada", e)
        }
    }
}

/** Clave publica EC P-256 en formato JWK (RFC 7517). Contiene SOLO el componente publico. */
data class EcJwk(val x: String, val y: String) {
    /** JSON canonico de RFC 7638 (miembros en orden alfabetico y sin espacios): base de la huella. */
    fun canonicalJson(): String = """{"crv":"P-256","kty":"EC","x":"$x","y":"$y"}"""

    fun json(): String = """{"kty":"EC","crv":"P-256","x":"$x","y":"$y"}"""

    /** Huella RFC 7638 (SHA-256 del JWK canonico, base64url). */
    fun thumbprint(): String = Dpop.b64(Dpop.sha256(canonicalJson().toByteArray(Charsets.UTF_8)))

    /**
     * Huella CORTA para que una persona la compare a simple vista con la que ve quien aprueba (`XXXX-XXXX-XXXX`): los primeros 12
     * hexadecimales del SHA-256 de la huella. Debe coincidir con la que calcula el servidor.
     */
    fun shortFingerprint(): String {
        val hex = Dpop.sha256(thumbprint().toByteArray(Charsets.UTF_8)).joinToString("") { "%02X".format(it) }.take(12)
        return "${hex.substring(0, 4)}-${hex.substring(4, 8)}-${hex.substring(8, 12)}"
    }
}

/** Arma pruebas DPoP firmadas. `signDer` es la firma de la clave del dispositivo (formato DER, p. ej. Android Keystore). */
class DpopProofBuilder(
    private val jwk: EcJwk,
    private val signDer: (ByteArray) -> ByteArray,
    private val clock: Clock = Clock.systemUTC(),
    private val random: SecureRandom = SecureRandom(),
) {
    fun build(method: String, url: String, accessCredential: String? = null, nonce: String? = null): String {
        val header = """{"typ":"dpop+jwt","alg":"ES256","jwk":${jwk.json()}}"""
        val jti = ByteArray(16).also(random::nextBytes).let(Dpop::b64)
        val claims = buildString {
            append("{\"jti\":").append(Dpop.jsonString(jti))
            append(",\"htm\":").append(Dpop.jsonString(method.uppercase()))
            append(",\"htu\":").append(Dpop.jsonString(url))
            append(",\"iat\":").append(clock.instant().epochSecond)
            if (accessCredential != null) append(",\"ath\":").append(Dpop.jsonString(Dpop.accessHash(accessCredential)))
            if (nonce != null) append(",\"nonce\":").append(Dpop.jsonString(nonce))
            append('}')
        }
        val signingInput = Dpop.b64(header.toByteArray(Charsets.UTF_8)) + "." + Dpop.b64(claims.toByteArray(Charsets.UTF_8))
        val signature = Dpop.derToP1363(signDer(signingInput.toByteArray(Charsets.US_ASCII)))
        return signingInput + "." + Dpop.b64(signature)
    }
}
