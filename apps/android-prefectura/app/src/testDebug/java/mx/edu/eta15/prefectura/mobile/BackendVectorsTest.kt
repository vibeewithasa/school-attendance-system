package mx.edu.eta15.prefectura.mobile

import java.security.MessageDigest
import java.util.UUID
import mx.edu.eta15.prefectura.domain.OutboxCanonical
import mx.edu.eta15.prefectura.domain.WireMark
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * VECTORES REALES del backend (Prompt 45): las funciones `marksHash` (attendance.service.ts) y `rosterDigestV1`
 * (attendance.mobile.ts) se ejecutaron con tsx sobre estas entradas y sus resultados estan fijados aqui. Los ids se reconstruyen
 * con `UUID.nameUUIDFromBytes("vec-<caso>-<i>")` (identico al UUID v3 que genero el guion) y el estado es `absent` si
 * `(i * 7 + caso) % 3 == 0` y `present` si no. Si el backend cambia su formula, estos vectores deben regenerarse a proposito.
 */
class BackendVectorsTest {
    private data class Vector(val case: Int, val size: Int, val marksHash: String, val rosterDigest: String)

    private val vectors = listOf(
        Vector(0, 1, "38f845997b29f7eeba887c5852a5d81f29c8c9d2ba04b5247c7a26d367e853db", "v1:734542e0016561fca445f2b0e13acab8a891aca2120ae39d09d129034fed43c9"),
        Vector(1, 2, "4af88392df822f1284eac81029b9f080b3f1cc2a59b2c03d6282e7d9d03ac19b", "v1:b3848ec838ac5bc142fc0aa2a7cf74c4473304f3ee1e6298c9ee7a5ab1dba66e"),
        Vector(2, 3, "1861401bfafc999ee24cf55c6562c67dcba3f7352f274b48ff7b896808a90086", "v1:0daf5f0ed6aa740f20f96c87925bf5ea1cd011e3c1b4e23c1e5a2460f07871d5"),
        Vector(3, 5, "75c45e10d4991b710955460de5f32047f589d358df2f3118b25d9a1735298be2", "v1:4733bb03548848dae253e6a93f91ee52e0cafad9d2fca98a2f6ea36fae62c828"),
        Vector(4, 9, "6bd0a6048f325c4424c872eb99a9e1fd869c0703df656a32bed65e566d9c1295", "v1:9bf228ca8fa7c5e28b6959d5eacaffc2c9947d1a589828b64bfa8dfd3277fa11"),
        Vector(5, 17, "bbcf9794d8ff6cb576341350fe084c1f0fcbef2801a44f8fc2a0988556a84201", "v1:e2a71f0bbb2dcc14638358e5f944bcc5a48bb30caeb4b11fb983db73f11ae736"),
        Vector(6, 33, "087ed444991168919beab6babfd98892ddf498f07bf5f776c066252f1876dab2", "v1:ed0b9851c4944bb13cb6cde9b4572de49efc4ea470c90172c88937c41946bdc9"),
        Vector(7, 64, "677bd657ea3b6bbdb4f9c0a72d4c917bd7b0cedbd51c8e2c31a5213a55aa8f30", "v1:791ab3648277e6a87ed124d01c4a1c682511a1f3347268969527ed449b968de3"),
        Vector(8, 100, "aefb67a5edf7789f3850dcea9e91477556b380e4a2c30c115118d81758723f69", "v1:519fc1202d0a2bfd3aabeba3de7c58ed396d9c9c1a078e513d29396c742cf149"),
        Vector(9, 150, "deddbee27e299296136d4edc534d7e0b1de83e966defea6c3c3022b4a6265b5d", "v1:9b60a1e1c4bfa58d8530e82a55cd6b22b56bae44113f8fcd2acdd706f35388f6"),
        Vector(10, 199, "bbf8d0a626ad28efec5affd6f4d6f00fde467b7c23e7e92d5504d2c6ab3e3a08", "v1:96876ce4682744b36026f274e69b759aa34aa8ea09a0af98490cb5dc3d30376d"),
        Vector(11, 200, "6e67eebb7fdb0d626b5243c48d7b9ab09037d609b4ae295d742a2ad7dadb4e2e", "v1:dbd96f8a26306519fb5e3955822c420890e0986d0fbb903e32eddf8db22ee4ec"),
    )

    private fun marks(v: Vector) = (0 until v.size).map { i ->
        WireMark(UUID.nameUUIDFromBytes("vec-${v.case}-$i".toByteArray()).toString(), if ((i * 7 + v.case) % 3 == 0) "absent" else "present")
    }

    @Test
    fun `la huella de marcas del cliente es identica a marksHash del backend en 12 vectores reales`() {
        for (v in vectors) assertEquals("caso ${v.case} (${v.size} marcas)", v.marksHash, OutboxCanonical.marksHash(marks(v)))
    }

    @Test
    fun `el orden de entrada no cambia la huella (como en el backend)`() {
        for (v in vectors) assertEquals(v.marksHash, OutboxCanonical.marksHash(marks(v).reversed()))
    }

    @Test
    fun `la huella v1 del padron del cliente es identica a rosterDigestV1 del backend`() {
        for (v in vectors) {
            val ids = marks(v).map { it.studentId }
            assertEquals("caso ${v.case}", v.rosterDigest, SyncPolicy.rosterDigestV1(ids))
            assertEquals(v.rosterDigest, SyncPolicy.rosterDigestV1(ids.map { it.uppercase() }.reversed())) // el backend normaliza a minusculas
        }
    }

    @Test
    fun `cambiar un estado o un alumno cambia la huella y un requestId nunca identifica dos contenidos`() {
        val base = marks(vectors[5])
        val flipped = base.toMutableList().also { it[0] = it[0].copy(status = if (it[0].status == "present") "absent" else "present") }
        assertNotEquals(OutboxCanonical.marksHash(base), OutboxCanonical.marksHash(flipped))
        assertNotEquals(OutboxCanonical.marksHash(base), OutboxCanonical.marksHash(base.drop(1)))
        // la huella NO incluye dayId ni expectedRevision (parametros de transporte): el mismo contenido tiene la misma identidad
        val sha = MessageDigest.getInstance("SHA-256")
        val canonical = base.sortedBy { it.studentId }.joinToString("|") { "${it.studentId}:${it.status}" }
        assertEquals(sha.digest(canonical.toByteArray()).joinToString("") { "%02x".format(it) }, OutboxCanonical.marksHash(base))
    }
}
