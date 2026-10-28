package mx.edu.eta15.prefectura.mobile

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mx.edu.eta15.prefectura.data.CommitResult
import mx.edu.eta15.prefectura.data.DownloadSpec
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.OfflineSink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val NOW: Instant = Instant.parse("2026-10-27T18:00:00Z")
private val JWK = EcJwk("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA", "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A")

private const val DEVICE = "d3f4a5b6-0000-4000-8000-000000000001"
private const val YEAR = "aaaaaaaa-0000-4000-8000-0000000000aa"
private const val G1 = "11111111-0000-4000-8000-000000000001"
private const val G2 = "22222222-0000-4000-8000-000000000002"
private const val S1 = "51111111-0000-4000-8000-000000000001"
private const val S2 = "52222222-0000-4000-8000-000000000002"
private const val S3 = "53333333-0000-4000-8000-000000000003"
private const val DAY = "2026-10-27"

private class Key : DeviceKey {
    override fun exists() = true

    override fun create() = Unit

    override fun publicJwk() = JWK

    override fun protection() = KeyProtection.TRUSTED_ENVIRONMENT

    override fun signDer(data: ByteArray): ByteArray = throw UnsupportedOperationException()

    override fun delete() = Unit
}

private class Links : LinkStore {
    var record: LinkRecord? = LinkRecord("req", DEVICE, "Tableta ficticia", "Prefectura ficticia")

    override fun load() = record

    override fun save(record: LinkRecord) {
        this.record = record
    }

    override fun clear() {
        record = null
    }
}

private class Sink : OfflineSink {
    val commits = mutableListOf<DownloadSpec>()
    val marks = mutableListOf<Pair<String, String>>()
    val purges = mutableListOf<String>()
    var failCommit = false

    override suspend fun commit(spec: DownloadSpec): CommitResult {
        if (failCommit) throw IllegalStateException("la transaccion se revirtio")
        commits += spec
        return CommitResult(spec.groups.size, spec.revokedRemoteGroupIds.size, 0, 0)
    }

    override suspend fun markAuthState(deviceId: String, state: String): Boolean {
        marks += deviceId to state
        return true
    }

    override suspend fun purge(deviceId: String): Boolean {
        purges += deviceId
        return true
    }
}

private fun group(id: String, label: String, asOf: String = DAY) =
    GroupItem(id, label, "2026-2027", grade = 1, code = label.takeLast(1), shift = "matutino", schoolYearId = YEAR, asOf = asOf)

private fun student(id: String, given: String, family: String = "Ficticia") = RosterStudent(id, "$given $family", given, family)

private fun roster(groupId: String, vararg students: RosterStudent, asOf: String = DAY) =
    Roster("1.º A", students.toList(), groupId = groupId, asOf = asOf)

private fun session(deviceId: String = DEVICE) =
    MobileSession("acceso-1", "renovacion-1", NOW.plusSeconds(300), NOW.plusSeconds(3600), NOW.plusSeconds(28_800), deviceId)

/** Servidor de PRUEBAS simulado: solo expone las dos lecturas permitidas; NO existe ninguna operacion de asistencia. */
private class Api : MobileApi {
    val calls = mutableListOf<String>()
    var groups: ApiResult<List<GroupItem>> = ApiResult.Ok(listOf(group(G1, "1.º A"), group(G2, "1.º B")))
    val rosters = mutableMapOf<String, ApiResult<Roster>>(
        G1 to ApiResult.Ok(roster(G1, student(S1, "Ana"), student(S2, "Beto"))),
        G2 to ApiResult.Ok(roster(G2, student(S3, "Carla"))),
    )
    var opened: ApiResult<MobileSession> = ApiResult.Ok(session())

    override suspend fun enroll(jwk: EcJwk, label: String): ApiResult<EnrollCreated> = throw UnsupportedOperationException()

    override suspend fun enrollStatus(requestId: String): ApiResult<EnrollStatus> = throw UnsupportedOperationException()

    override suspend fun activate(requestId: String): ApiResult<String> = throw UnsupportedOperationException()

    override suspend fun openSession(): ApiResult<MobileSession> {
        calls += "POST /mobile/auth/token"
        return opened
    }

    override suspend fun renew(session: MobileSession): ApiResult<MobileSession> = ApiResult.Ok(session)

    override suspend fun closeSession(session: MobileSession): ApiResult<Unit> = ApiResult.Ok(Unit)

    override suspend fun myGroups(session: MobileSession): ApiResult<List<GroupItem>> {
        calls += "GET /mobile/school/me/groups"
        return groups
    }

    override suspend fun roster(session: MobileSession, groupId: String): ApiResult<Roster> {
        calls += "GET /mobile/school/groups/$groupId/roster"
        return rosters[groupId] ?: ApiResult.Failure(404, "NOT_FOUND")
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class AuthorizedDownloadTest {
    private val clock = Clock.fixed(NOW, ZoneOffset.UTC)

    private fun TestScope.controller(api: Api, sink: Sink?) =
        MobileLinkController(Key(), Links(), { api }, backgroundScope, clock, pollMillis = 1_000, cache = sink)

    private suspend fun TestScope.linked(api: Api, sink: Sink): MobileLinkController {
        val c = controller(api, sink)
        c.start()
        runCurrent()
        assertEquals(Stage.LINKED, c.state.value.stage)
        c.downloadAuthorized()
        runCurrent()
        return c
    }

    // ---------------------------------------------------------------- descarga correcta

    @Test
    fun `descarga mis grupos y solo el padron de cada uno, valida y guarda UNA vez con la identidad del servidor`() = runTest {
        val api = Api()
        val sink = Sink()
        val c = linked(api, sink)
        val outcome = c.state.value.download
        assertEquals(DownloadOutcome.Complete(2, 0, 0, 0), outcome)
        assertEquals(1, sink.commits.size)
        val spec = sink.commits.single()
        assertEquals(DEVICE, spec.deviceId) // sale de la vinculacion con el servidor, no de un dato de la interfaz
        assertEquals("Prefectura ficticia", spec.ownerName)
        assertEquals(DAY, spec.serverSchoolDate)
        assertEquals(listOf("1.º A", "1.º B"), spec.groups.map { it.label })
        assertEquals(listOf(listOf(S1, S2), listOf(S3)), spec.groups.map { g -> g.students.map { it.remoteId } })
        // solo las dos lecturas permitidas; jamas un grupo que no vino en "mis grupos" ni un alumno suelto
        assertEquals(
            listOf(
                "POST /mobile/auth/token",
                "GET /mobile/school/me/groups",
                "GET /mobile/school/groups/$G1/roster",
                "GET /mobile/school/groups/$G2/roster",
            ),
            api.calls,
        )
        assertTrue("no hay ninguna llamada de escritura de asistencia", api.calls.none { it.contains("attendance") })
        assertTrue(!c.state.value.busy)
    }

    @Test
    fun `sin cache configurada no descarga nada (comportamiento anterior)`() = runTest {
        val api = Api()
        val c = controller(api, null)
        c.start()
        runCurrent()
        c.downloadAuthorized()
        runCurrent()
        assertNull(c.state.value.download)
        assertTrue(api.calls.isEmpty())
    }

    // ---------------------------------------------------------------- todo o nada

    @Test
    fun `una descarga que falla a mitad no guarda nada ni se declara completa`() = runTest {
        val api = Api().apply { rosters[G2] = ApiResult.Failure(503, "UNAVAILABLE") }
        val sink = Sink()
        val c = linked(api, sink)
        assertEquals(DownloadOutcome.Incomplete, c.state.value.download)
        assertTrue("el primer padron NO se guarda solo", sink.commits.isEmpty())
        assertTrue(sink.marks.isEmpty())
    }

    @Test
    fun `sin red a mitad de la descarga se conserva la copia anterior`() = runTest {
        val api = Api().apply { rosters[G1] = ApiResult.Failure(0, null) }
        val sink = Sink()
        assertEquals(DownloadOutcome.Incomplete, linked(api, sink).state.value.download)
        assertTrue(sink.commits.isEmpty())
    }

    @Test
    fun `si la transaccion de Room falla la descarga es incompleta`() = runTest {
        val sink = Sink().apply { failCommit = true }
        assertEquals(DownloadOutcome.Incomplete, linked(Api(), sink).state.value.download)
    }

    @Test
    fun `un padron cuyo grupo no es el pedido se rechaza completo`() = runTest {
        val api = Api().apply { rosters[G1] = ApiResult.Ok(roster(G2, student(S1, "Ana"))) }
        val sink = Sink()
        assertEquals(DownloadOutcome.Invalid, linked(api, sink).state.value.download)
        assertTrue(sink.commits.isEmpty())
    }

    @Test
    fun `alumno duplicado, grupo duplicado, fecha invalida y datos fuera de rango se rechazan sin guardar`() = runTest {
        val cases = listOf<(Api) -> Unit>(
            { a -> a.rosters[G1] = ApiResult.Ok(roster(G1, student(S1, "Ana"), student(S1, "Ana otra"))) },
            { a -> a.groups = ApiResult.Ok(listOf(group(G1, "1.º A"), group(G1, "1.º A"))) },
            { a -> a.groups = ApiResult.Ok(listOf(group(G1, "1.º A", asOf = "27/10/2026"))) },
            { a -> a.groups = ApiResult.Ok(listOf(group("no-es-uuid", "1.º A"))) },
            { a -> a.rosters[G1] = ApiResult.Ok(roster(G1, student("no-es-uuid", "Ana"))) },
            { a -> a.rosters[G1] = ApiResult.Ok(roster(G1, student(S1, "\u0000Ana"))) },
            { a -> a.rosters[G1] = ApiResult.Ok(roster(G1, student(S1, ""))) },
            { a -> a.rosters[G1] = ApiResult.Ok(roster(G1, student(S1, "Ana"), asOf = "2026-10-28")) },
        )
        cases.forEachIndexed { i, mutate ->
            val api = Api().also(mutate)
            val sink = Sink()
            assertEquals("caso $i", DownloadOutcome.Invalid, linked(api, sink).state.value.download)
            assertTrue("caso $i: no debe guardar", sink.commits.isEmpty())
        }
    }

    // ---------------------------------------------------------------- revocaciones y autorizacion

    @Test
    fun `un padron que responde no encontrado es un grupo ya no autorizado - se bloquea y los demas se guardan`() = runTest {
        val api = Api().apply { rosters.remove(G2) }
        val sink = Sink()
        val c = linked(api, sink)
        assertEquals(DownloadOutcome.Complete(1, 1, 0, 0), c.state.value.download)
        val spec = sink.commits.single()
        assertEquals(setOf(G2), spec.revokedRemoteGroupIds)
        assertEquals(listOf(G1), spec.groups.map { it.remoteId })
    }

    @Test
    fun `lista vacia de grupos tambien es una descarga completa (los grupos conocidos se bloquean en la cache)`() = runTest {
        val api = Api().apply { groups = ApiResult.Ok(emptyList()) }
        val sink = Sink()
        val c = linked(api, sink)
        assertEquals(DownloadOutcome.Complete(0, 0, 0, 0), c.state.value.download)
        assertEquals(emptyList<String>(), sink.commits.single().groups.map { it.remoteId })
    }

    @Test
    fun `dispositivo revocado - se bloquea la cache, no se guarda nada y se informa`() = runTest {
        val api = Api().apply { opened = ApiResult.Failure(401, "DEVICE_REVOKED") }
        val sink = Sink()
        val c = linked(api, sink)
        // sin sesion no hay identificador del servidor en memoria: se usa el registro de vinculacion
        assertEquals(DownloadOutcome.Blocked(LinkIssue.DEVICE_REVOKED), c.state.value.download)
        assertEquals(listOf(DEVICE to OfflineCacheStore.AUTH_DEVICE_REVOKED), sink.marks)
        assertTrue(sink.commits.isEmpty())
        assertEquals(LinkIssue.DEVICE_REVOKED, c.state.value.issue)
    }

    @Test
    fun `cuenta ya no elegible o sin permiso - se bloquea la cache`() = runTest {
        for (failure in listOf(ApiResult.Failure(403, "NOT_ELIGIBLE"), ApiResult.Failure(403, "FORBIDDEN"))) {
            val api = Api().apply { groups = failure }
            val sink = Sink()
            val c = linked(api, sink)
            assertEquals(DownloadOutcome.Blocked(LinkIssue.NOT_ELIGIBLE), c.state.value.download)
            assertEquals(listOf(DEVICE to OfflineCacheStore.AUTH_ACCOUNT_BLOCKED), sink.marks)
            assertTrue(sink.commits.isEmpty())
        }
    }

    @Test
    fun `sin red al pedir los grupos no cambia ningun estado de autorizacion`() = runTest {
        val api = Api().apply { groups = ApiResult.Failure(0, null) }
        val sink = Sink()
        assertEquals(DownloadOutcome.Incomplete, linked(api, sink).state.value.download)
        assertTrue(sink.marks.isEmpty() && sink.commits.isEmpty())
    }

    @Test
    fun `borrar la cache es una accion explicita y usa el identificador del dispositivo vinculado`() = runTest {
        val sink = Sink()
        val c = linked(Api(), sink)
        c.purgeCache()
        runCurrent()
        assertEquals(listOf(DEVICE), sink.purges)
        assertNull(c.state.value.download)
    }

    // ---------------------------------------------------------------- validador

    @Test
    fun `el validador acepta el caso normal y convierte el padron a lo minimo para pasar lista`() {
        val g = group(G1, "1.º A")
        val converted = ResponseValidator.roster(g, roster(G1, student(S1, "Ana"), student(S2, "Beto")))
        assertNotNull(converted)
        assertEquals(listOf("Ana", "Beto"), converted!!.students.map { it.givenNames })
        assertEquals(listOf(g), ResponseValidator.groups(listOf(g)))
    }

    @Test
    fun `el validador rechaza mas de 1000 alumnos y mas de 50 grupos`() {
        val many = (1..1001).map { student("%08d-0000-4000-8000-000000000001".format(it), "Alumno$it") }
        assertNull(ResponseValidator.roster(group(G1, "1.º A"), Roster("1.º A", many, G1, DAY)))
        val groups = (1..51).map { group("%08d-0000-4000-8000-000000000001".format(it), "1.º A") }
        assertNull(ResponseValidator.groups(groups))
    }
}
