package mx.edu.eta15.prefectura.data.secure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RawKeyPassphraseTest {
    @Test
    fun `el formato binario de SQLCipher es x apostrofe 64 hex apostrofe`() {
        val key = ByteArray(32) { it.toByte() }
        val text = String(SecureStorage.rawKeyPassphrase(key), Charsets.US_ASCII)
        assertEquals(67, text.length)
        assertEquals("x'" + "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" + "'", text)
    }

    @Test
    fun `solo se aceptan claves de 256 bits`() {
        assertThrows(IllegalArgumentException::class.java) { SecureStorage.rawKeyPassphrase(ByteArray(16)) }
        assertThrows(IllegalArgumentException::class.java) { SecureStorage.rawKeyPassphrase(ByteArray(33)) }
    }

    @Test
    fun `los bytes altos se codifican sin signo`() {
        val text = String(SecureStorage.rawKeyPassphrase(ByteArray(32) { 0xFF.toByte() }), Charsets.US_ASCII)
        assertEquals("x'" + "ff".repeat(32) + "'", text)
    }
}