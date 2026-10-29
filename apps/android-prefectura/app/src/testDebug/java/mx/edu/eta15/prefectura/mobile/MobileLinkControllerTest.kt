package mx.edu.eta15.prefectura.mobile

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val NOW: Instant = Instant.parse("2026-10-27T18:00:00Z")
private val JWK = EcJwk("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA", "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A")

private class FakeKey(var present: Boolean = false, var failCreate: Boolean = false) : DeviceKey {
    var creations = 0
    var deletions = 0

    override fun exists() = present

    override fun create() {
        if (present) throw DeviceKeyException("Ya existe una clave de dispositivo: no se reemplaza")
        if (failCreate) throw DeviceKeyException("sin Keystore")
        present = true
        creations++
    }

    override fun publicJwk(): EcJwk {
        if (!present) throw DeviceKeyException("Falta la clave")
        return JWK
    }

    override fun protection() = KeyProtection.TRUSTED_ENVIRONMENT

    override fun signDer(data: ByteArray): ByteArray = throw UnsupportedOperationException("no se firma en estas pruebas")

    override fun delete() {
        present = false
        deletions++
    }
}

private class FakeStore(var record: LinkRecord? = null) : LinkStore {
    val writes = mutableListOf<LinkRecord>()

    override fun load() = record

    override fun save(record: LinkRecord) {
        this.record = record
        writes += record
    }

    override fun clear() {
        record = null
    }
}

private fun session(access: String = "acceso-1", expires: Instant = NOW.plusSeconds(300)) =
    MobileSession(access, "renovacion-1", expires, NOW.plusSeconds(3600), NOW.plusSeconds(28_800), "d3f4a5b6-0000-4000-8000-000000000001")

private class FakeApi : MobileApi {
    val calls = mutableListOf<String>()
    var enrollResult: ApiResult<EnrollCreated> =
        ApiResult.Ok(EnrollCreated("11111111-0000-4000-8000-000000000001", "ABCD-2345", "B59A-0E98-982E", NOW.plusSeconds(600)))
    val statuses = ArrayDeque<ApiResult<EnrollStatus>>()
    var activateResult: ApiResult<String> = ApiResult.Ok("d3f4a5b6-0000-4000-8000-000000000001")
    var openResults = ArrayDeque<ApiResult<MobileSession>>()
    var renewResult: ApiResult<MobileSession> = ApiResult.Ok(session("acceso-2"))
    var groupsResults = ArrayDeque<ApiResult<List<GroupItem>>>()
    var rosterResult: ApiResult<Roster> = ApiResult.Ok(Roster("1.º A", listOf(RosterStudent("s1", "Ana Ficticia"))))

    override suspend fun enroll(jwk: EcJwk, label: String): ApiResult<EnrollCreated> {
        calls += "enroll"
        return enrollResult
    }

    override suspend fun enrollStatus(requestId: String): ApiResult<EnrollStatus> {
        calls += "status"
        return if (statuses.size > 1) statuses.removeFirst() else statuses.first()
    }

    override suspend fun activate(requestId: String): ApiResult<String> {
        calls += "activate"
        return activateResult
    }

    override suspend fun openSession(): ApiResult<MobileSession> {
        calls += "open"
        return if (openResults.isNotEmpty()) openResults.removeFirst() else ApiResult.Ok(session())
    }

    override suspend fun renew(session: MobileSession): ApiResult<MobileSession> {
        calls += "renew"
        return renewResult
    }

    override suspend fun closeSession(session: MobileSession): ApiResult<Unit> {
        calls += "close"
        return ApiResult.Ok(Unit)
    }

    override suspend fun myGroups(session: MobileSession): ApiResult<List<GroupItem>> {
        calls += "groups:${session.accessToken}"
        return if (groupsResults.isNotEmpty()) groupsResults.removeFirst() else ApiResult.Ok(listOf(GroupItem("g1", "1.º A", "2026-2027")))
    }

    override suspend fun roster(session: MobileSession, groupId: String): ApiResult<Roster> {
        calls += "roster"
        return rosterResult
    }
}

private fun status(s: String, by: String? = null) = ApiResult.Ok(EnrollStatus(s, NOW.plusSeconds(600), "B59A-0E98-982E", by))

@OptIn(ExperimentalCoroutinesApi::class)
class MobileLinkControllerTest {
    private val clock = Clock.fixed(NOW, ZoneOffset.UTC)

    private fun kotlinx.coroutines.test.TestScope.controller(key: FakeKey, store: FakeStore, api: FakeApi) =
        MobileLinkController(key, store, { api }, backgroundScope, clock, pollMillis = 1_000)

    @Test
    fun `al abrir sin clave ni registro no se crea nada y se ofrece vincular`() = runTest {
        val key = FakeKey()
        val store = FakeStore()
        val c = controller(key, store, FakeApi())
        c.start()
        runCurrent()
        assertEquals(Stage.NOT_LINKED, c.state.value.stage)
        assertEquals(0, key.creations)
        assertNull(store.record)
    }

    @Test
    fun `vincular crea la clave solo por accion explicita y completa el flujo hasta activar`() = runTest {
        val key = FakeKey()
        val store = FakeStore()
        val api = FakeApi().apply {
            statuses += listOf(status("pending"), status("claimed", "Prefecta Ficticia"), status("approved", "Prefecta Ficticia"))
        }
        val c = controller(key, store, api)
        c.start()
        runCurrent()
        assertEquals(0, key.creations)

        c.startLinking("Tableta de pruebas")
        runCurrent()
        assertEquals(1, key.creations)
        var s = c.state.value
        assertEquals(Stage.PAIRING, s.stage)
        assertEquals("ABCD-2345", s.pairing?.pairingCode)
        assertEquals("B59A-0E98-982E", s.fingerprint)
        assertEquals("pending", s.pairing?.status)
        assertNull(store.record?.deviceId)

        advanceTimeBy(1_100)
        runCurrent()
        s = c.state.value
        assertEquals("claimed", s.pairing?.status)
        assertEquals("Prefecta Ficticia", s.pairing?.claimedBy)

        advanceTimeBy(1_100)
        runCurrent()
        s = c.state.value
        assertEquals(Stage.LINKED, s.stage)
        assertEquals("d3f4a5b6-0000-4000-8000-000000000001", s.deviceId)
        assertEquals("Prefecta Ficticia", s.owner)
        assertEquals("d3f4a5b6-0000-4000-8000-000000000001", store.record?.deviceId)
        assertEquals("Prefecta Ficticia", store.record?.owner)
        assertEquals(listOf("enroll", "status", "status", "status", "activate"), api.calls)
    }

    @Test
    fun `si ya existe la clave se reutiliza y nunca se regenera`() = runTest {
        val key = FakeKey(present = true)
        val api = FakeApi().apply { statuses += status("pending") }
        val c = controller(key, FakeStore(), api)
        c.start()
        runCurrent()
        assertEquals("B59A-0E98-982E", c.state.value.fingerprint)
        c.startLinking("Equipo")
        runCurrent()
        assertEquals(0, key.creations)
        assertEquals(Stage.PAIRING, c.state.value.stage)
    }

    @Test
    fun `un fallo del Keystore al crear la clave no llama al servidor`() = runTest {
        val key = FakeKey(failCreate = true)
        val api = FakeApi()
        val c = controller(key, FakeStore(), api)
        c.start()
        runCurrent()
        c.startLinking("Equipo")
        runCurrent()
        assertEquals(LinkIssue.KEY_ERROR, c.state.value.issue)
        assertTrue(api.calls.isEmpty())
        assertEquals(Stage.NOT_LINKED, c.state.value.stage)
    }

    @Test
    fun `con registro local pero sin clave se pide decidir y no se crea otra clave`() = runTest {
        val key = FakeKey(present = false)
        val store = FakeStore(LinkRecord("r1", "d1", "Equipo", "Prefecta Ficticia"))
        val c = controller(key, store, FakeApi())
        c.start()
        runCurrent()
        assertEquals(Stage.KEY_LOST, c.state.value.stage)
        assertEquals(0, key.creations)
        c.forgetDevice()
        assertEquals(Stage.NOT_LINKED, c.state.value.stage)
        assertNull(store.record)
        assertEquals(0, key.creations)
    }

    @Test
    fun `una clave ya registrada y revocada exige olvidar y no se reemplaza sola`() = runTest {
        val key = FakeKey()
        val api = FakeApi().apply { enrollResult = ApiResult.Failure(409, "KEY_ALREADY_REGISTERED") }
        val c = controller(key, FakeStore(), api)
        c.start()
        runCurrent()
        c.startLinking("Equipo")
        runCurrent()
        assertEquals(LinkIssue.KEY_ALREADY_REGISTERED, c.state.value.issue)
        assertEquals(1, key.creations) // la creada ahora por la accion explicita; no se crea otra
        c.startLinking("Equipo")
        runCurrent()
        assertEquals(1, key.creations)
        c.forgetDevice()
        assertEquals(1, key.deletions)
        assertFalse(key.present)
    }

    @Test
    fun `una solicitud rechazada o vencida vuelve a no vinculado y limpia el registro`() = runTest {
        val key = FakeKey()
        val store = FakeStore()
        val api = FakeApi().apply { statuses += listOf(status("claimed", "Prefecta Ficticia"), status("rejected")) }
        val c = controller(key, store, api)
        c.start()
        runCurrent()
        c.startLinking("Equipo")
        runCurrent()
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(Stage.NOT_LINKED, c.state.value.stage)
        assertEquals(LinkIssue.REQUEST_CLOSED, c.state.value.issue)
        assertNull(store.record)
    }

    @Test
    fun `sin red el sondeo sigue y se recupera`() = runTest {
        val api = FakeApi().apply { statuses += listOf(ApiResult.Failure(0, null), status("claimed", "Prefecta Ficticia")) }
        val c = controller(FakeKey(), FakeStore(), api)
        c.start()
        runCurrent()
        c.startLinking("Equipo")
        runCurrent()
        assertEquals(LinkIssue.NETWORK, c.state.value.issue)
        advanceTimeBy(1_100)
        runCurrent()
        assertNull(c.state.value.issue)
        assertEquals("claimed", c.state.value.pairing?.status)
    }

    private fun kotlinx.coroutines.test.TestScope.linked(api: FakeApi, store: FakeStore = FakeStore(LinkRecord("r1", "d1", "Equipo", "Prefecta Ficticia"))): MobileLinkController {
        val c = controller(FakeKey(present = true), store, api)
        c.start()
        runCurrent()
        assertEquals(Stage.LINKED, c.state.value.stage)
        return c
    }

    @Test
    fun `abrir sesion lee grupos y padron sin guardar nada en disco`() = runTest {
        val store = FakeStore(LinkRecord("r1", "d1", "Equipo", "Prefecta Ficticia"))
        val api = FakeApi()
        val c = linked(api, store)
        val writesBefore = store.writes.size
        c.openSession()
        runCurrent()
        assertNotNull(c.state.value.session)
        c.loadGroups()
        runCurrent()
        assertEquals("1.º A", c.state.value.groups?.single()?.label)
        c.loadRoster("g1")
        runCurrent()
        assertEquals("Ana Ficticia", c.state.value.roster?.students?.single()?.name)
        // el unico cambio de disco posible es completar el identificador del dispositivo; jamas credenciales ni datos escolares
        store.writes.drop(writesBefore).forEach { assertEquals("Equipo", it.label); assertEquals("Prefecta Ficticia", it.owner) }
        c.closeSession()
        runCurrent()
        assertNull(c.state.value.session)
        assertNull(c.state.value.groups)
        assertNull(c.state.value.roster)
        assertTrue(api.calls.contains("close"))
    }

    @Test
    fun `un acceso vencido se renueva y la lectura se reintenta una vez`() = runTest {
        val api = FakeApi().apply {
            groupsResults += listOf(ApiResult.Failure(401, "TOKEN_EXPIRED"), ApiResult.Ok(listOf(GroupItem("g1", "1.º A", "2026-2027"))))
        }
        val c = linked(api)
        c.openSession()
        runCurrent()
        c.loadGroups()
        runCurrent()
        assertEquals(listOf("open", "groups:acceso-1", "renew", "groups:acceso-2"), api.calls)
        assertNotNull(c.state.value.groups)
    }

    @Test
    fun `si la renovacion falla se abre una sesion nueva con la clave del dispositivo`() = runTest {
        val api = FakeApi().apply {
            renewResult = ApiResult.Failure(401, "SESSION_ENDED")
            openResults += listOf(ApiResult.Ok(session("acceso-1", NOW.plusSeconds(1))), ApiResult.Ok(session("acceso-3")))
        }
        val c = linked(api)
        c.openSession()
        runCurrent()
        c.loadGroups() // el acceso casi vencido obliga a renovar antes de leer
        runCurrent()
        assertEquals(listOf("open", "renew", "open", "groups:acceso-3"), api.calls)
    }

    @Test
    fun `un dispositivo revocado se informa y no abre sesion`() = runTest {
        val api = FakeApi().apply { openResults += ApiResult.Failure(403, "DEVICE_REVOKED") }
        val c = linked(api)
        c.openSession()
        runCurrent()
        assertEquals(LinkIssue.DEVICE_REVOKED, c.state.value.issue)
        assertNull(c.state.value.session)
    }

    @Test
    fun `olvidar borra la clave y el registro pero no habla con el servidor`() = runTest {
        val key = FakeKey(present = true)
        val store = FakeStore(LinkRecord("r1", "d1", "Equipo", "Prefecta Ficticia"))
        val api = FakeApi()
        val c = MobileLinkController(key, store, { api }, backgroundScope, clock, 1_000)
        c.start()
        runCurrent()
        c.forgetDevice()
        assertFalse(key.present)
        assertNull(store.record)
        assertEquals(Stage.NOT_LINKED, c.state.value.stage)
        assertTrue(api.calls.isEmpty())
    }
}
