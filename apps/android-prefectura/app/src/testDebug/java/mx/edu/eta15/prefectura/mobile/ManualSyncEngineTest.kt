package mx.edu.eta15.prefectura.mobile

import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.cancel
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.SandboxIds
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxCanonical
import mx.edu.eta15.prefectura.domain.OutboxReasons
import mx.edu.eta15.prefectura.domain.OutboxTransitions
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.SyncReport
import mx.edu.eta15.prefectura.domain.SyncResultKind
import mx.edu.eta15.prefectura.domain.WireMark
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val DEVICE = "dddddddd-0000-4000-8000-00000000000a"
private val PROFILE = SandboxIds.profile(DEVICE)
private const val GROUP = "local-group-1"
private const val REMOTE_GROUP = "11111111-0000-4000-8000-0000000000a1"
private const val DRAFT = "draft-1"
private const val TODAY = "2026-10-27"
private val S1 = "51111111-0000-4000-8000-0000000000a1"
private val S2 = "52222222-0000-4000-8000-0000000000a2"
private val S3 = "53333333-0000-4000-8000-0000000000a3"
private val NOW: Instant = Instant.parse("2026-10-27T18:00:00Z")
private val SESSION = MobileSession("acceso", "renovacion", NOW.plusSeconds(600), NOW.plusSeconds(3600), NOW.plusSeconds(28_800), DEVICE)

// ================================================================================================================ servidor falso
/** Servidor de PRUEBAS en memoria con la semantica real del backend: idempotencia por requestId, revision optimista y padron congelado. */
private class SyncFakeServer : AttendanceApi {
    var schoolToday = TODAY
    var isSchoolDay = true
    var assigned = true
    var roster: List<String> = listOf(S1, S2, S3)

    class Day(val id: String, var revision: Int, var finalized: Boolean = false) {
        val marks = mutableMapOf<String, String>()
        val applied = mutableMapOf<String, String>()
        var events = 0
    }

    var day: Day? = null
    val requests = mutableListOf<String>()
    class MarkPost(val requestId: String, val expectedRevision: Int, val marks: List<WireMark>)
    val markPosts = mutableListOf<MarkPost>()
    var writeFailures = ArrayDeque<ApiResult.Failure>()
    var readFailures = ArrayDeque<ApiResult.Failure>()
    var dropResponseOnce = false
    var gate: CompletableDeferred<Unit>? = null
    var enabled = true
    var rosterFailure: ApiResult.Failure? = null
    /** Se ejecuta justo antes de abrir la lista (simula un cambio de padron ENTRE la comparacion y OPEN). */
    var beforeOpen: (() -> Unit)? = null

    private fun dto(d: Day) = SrvDay(d.id, REMOTE_GROUP, TODAY, if (d.finalized) "finalized" else "draft", d.revision)

    private fun detail(d: Day) = SrvDetail(
        schoolToday, dto(d).copy(attendanceDate = dayDate), SyncPolicy.rosterDigestV1(roster),
        roster.map { SrvRecord(it, d.marks[it] ?: "pending") },
    )

    var dayDate = TODAY

    fun existingDay(revision: Int = 1, finalized: Boolean = false): Day = Day("22222222-0000-4000-8000-0000000000d1", revision, finalized).also { day = it }

    override suspend fun today(session: MobileSession): ApiResult<SrvToday> {
        requests += "GET today"
        if (!enabled) return ApiResult.Failure(404, "NOT_FOUND")
        readFailures.removeFirstOrNull()?.let { return it }
        return ApiResult.Ok(SrvToday(schoolToday, isSchoolDay, if (assigned) listOf(SrvTodayGroup(REMOTE_GROUP, day?.let { dto(it).copy(attendanceDate = dayDate) })) else emptyList()))
    }

    override suspend fun day(session: MobileSession, dayId: String): ApiResult<SrvDetail> {
        requests += "GET day"
        readFailures.removeFirstOrNull()?.let { return it }
        val d = day?.takeIf { it.id == dayId } ?: return ApiResult.Failure(404, "NOT_FOUND")
        return ApiResult.Ok(detail(d))
    }

    override suspend fun groupRoster(session: MobileSession, groupId: String): ApiResult<Roster> {
        requests += "GET roster"
        rosterFailure?.let { return it }
        if (!assigned) return ApiResult.Failure(404, "NOT_FOUND")
        return ApiResult.Ok(Roster("1.º A", roster.map { RosterStudent(it, "Alumno Ficticio") }, REMOTE_GROUP, TODAY))
    }

    override suspend fun openDay(session: MobileSession, groupId: String, attendanceDate: String): ApiResult<SrvOpen> {
        requests += "POST open"
        beforeOpen?.invoke()
        writeFailures.removeFirstOrNull()?.let { return it }
        if (attendanceDate != schoolToday) return ApiResult.Failure(400, "DATE_NOT_TODAY")
        val existing = day
        if (existing != null) return ApiResult.Ok(SrvOpen(detail(existing), created = false))
        val created = Day("22222222-0000-4000-8000-0000000000d1", 1).also { day = it }
        return ApiResult.Ok(SrvOpen(detail(created), created = true))
    }

    override suspend fun saveMarks(
        session: MobileSession,
        dayId: String,
        expectedRevision: Int,
        requestId: String,
        marks: List<WireMark>,
    ): ApiResult<SrvSave> {
        requests += "POST marks"
        markPosts += MarkPost(requestId, expectedRevision, marks)
        gate?.await()
        writeFailures.removeFirstOrNull()?.let { return it }
        val d = day?.takeIf { it.id == dayId } ?: return ApiResult.Failure(404, "NOT_FOUND")
        val hash = OutboxCanonical.marksHash(marks)
        d.applied[requestId]?.let {
            return if (it == hash) ApiResult.Ok(SrvSave(detail(d), 0, true)) else ApiResult.Failure(409, "IDEMPOTENCY_MISMATCH")
        }
        if (d.finalized) return ApiResult.Failure(409, "DAY_FINALIZED")
        if (d.revision != expectedRevision) return ApiResult.Failure(409, "REVISION_CONFLICT")
        if (marks.any { it.studentId !in roster }) return ApiResult.Failure(400, "STUDENT_NOT_IN_LIST")
        var changed = 0
        marks.forEach { if (d.marks[it.studentId] != it.status) { d.marks[it.studentId] = it.status; changed++ } }
        d.applied[requestId] = hash
        d.events++
        if (changed > 0) d.revision++
        val response = ApiResult.Ok(SrvSave(detail(d), changed, false))
        if (dropResponseOnce) {
            dropResponseOnce = false
            return ApiResult.Failure(0, null) // el servidor lo aplico; el cliente no recibio nada
        }
        return response
    }

    /** Otra prefecta guarda una marca por su cuenta (cambia la revision). */
    fun otherPrefectSaves(student: String, status: String) {
        val d = day!!
        d.marks[student] = status
        d.revision++
        d.events++
    }
}

// ================================================================================================================ almacen falso
private class SyncFakeStore : SyncStore {
    val ops = linkedMapOf<String, SyncOp>()
    val payloads = mutableMapOf<String, List<WireMark>>()
    var roster: Set<String> = setOf(S1, S2, S3)
    var acked: Set<String> = emptySet()
    var failAckFor: String? = null
    var failMoveTo: OperationState? = null
    var prepareResult: PrepareResult? = null
    var blocked: String? = null
    val journal = mutableListOf<String>()

    fun op(id: String) = ops.getValue(id)

    private fun put(op: SyncOp) {
        ops[op.id] = op
    }

    private fun transition(id: String, to: OperationState, patch: (SyncOp) -> SyncOp = { it }) {
        val cur = op(id)
        check(cur.state == to || cur.state.canTransitionTo(to)) { "transicion invalida ${cur.state} -> $to" }
        put(patch(cur).copy(state = to))
        journal += "$id:${cur.state}>$to"
    }

    /** Una operacion OPEN (READY) y una SAVE_MARKS sellada (WAITING_REMOTE_CONTEXT) con su dependencia. */
    fun prepared(marks: List<WireMark> = listOf(WireMark(S1, "present"), WireMark(S2, "absent")), date: String = TODAY, saveId: String = "save-1", openId: String = "open-1"): String {
        put(SyncOp(openId, OperationKind.OPEN, OperationState.READY, 2, GROUP, REMOTE_GROUP, DRAFT, date, null, null, null, null, null, 0, 0))
        put(
            SyncOp(
                saveId, OperationKind.SAVE_MARKS, OperationState.WAITING_REMOTE_CONTEXT, 1, GROUP, REMOTE_GROUP, DRAFT, date,
                "rq-$saveId".let { "aaaaaaaa-0000-4000-8000-" + it.hashCode().toUInt().toString(16).padStart(12, '0') }, null, null, openId, null, marks.size, 0,
            ),
        )
        payloads[saveId] = marks
        return saveId
    }

    override suspend fun recoverUnknown(): Int {
        val sending = ops.values.filter { it.state == OperationState.SENDING }
        sending.forEach { transition(it.id, OperationState.RETRYABLE_ERROR) }
        return sending.size
    }

    override suspend fun prepareDirty(groupId: String): PrepareResult? = prepareResult

    override suspend fun active(groupId: String) =
        ops.values.filter { !it.state.isTerminal && it.groupId == groupId }.sortedWith(compareBy({ it.schoolDate }, { it.seq }))

    override suspend fun operation(id: String) = ops[id]

    override suspend fun payload(opId: String) = payloads[opId].orEmpty()

    override suspend fun localRoster(draftId: String) = roster

    override suspend fun ackedStudents(draftId: String) = acked

    override suspend fun setContext(opId: String, serverDayId: String?, expectedRevision: Int?): Boolean {
        transition(opId, OperationState.READY) { it.copy(serverDayId = serverDayId, expectedRevision = expectedRevision) }
        return true
    }

    override suspend fun begin(opId: String): Boolean {
        transition(opId, OperationState.SENDING) { it.copy(attempts = it.attempts + 1) }
        return true
    }

    override suspend fun acknowledge(opId: String, serverDayId: String?, revision: Int, changed: Int, replayed: Boolean): Boolean {
        if (failAckFor == opId) throw IllegalStateException("fallo de Room al guardar el recibo")
        transition(opId, OperationState.ACKNOWLEDGED) { it.copy(serverDayId = serverDayId ?: it.serverDayId, ackRevision = revision) }
        return true
    }

    override suspend fun move(opId: String, to: OperationState, reason: String?, httpStatus: Int?, serverCode: String?): Boolean {
        if (failMoveTo == to) throw IllegalStateException("fallo de Room")
        transition(opId, to)
        journal += "$opId reason=$reason http=$httpStatus code=$serverCode"
        return true
    }

    override suspend fun blockProfile(authState: String) {
        blocked = authState
    }
}

private class SyncFakeSessions(var failure: ApiResult.Failure? = null) : SyncSessions {
    var closed = 0

    @Suppress("UNCHECKED_CAST")
    override suspend fun <T> authed(block: suspend (MobileSession) -> ApiResult<T>): ApiResult<T> = failure ?: block(SESSION)

    override suspend fun close() {
        closed++
    }
}

private class Rig(
    val server: SyncFakeServer = SyncFakeServer(),
    val store: SyncFakeStore = SyncFakeStore(),
    val sessions: SyncFakeSessions = SyncFakeSessions(),
    var device: String? = DEVICE,
    val profile: String = PROFILE,
) {
    val pauses = mutableListOf<Long>()
    val engine = ManualSyncEngine(profile, store, server, sessions, { device }, pause = { pauses += it })

    suspend fun run(): SyncReport = engine.run(GROUP)!!

    fun posts() = server.requests.filter { it.startsWith("POST") }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ManualSyncEngineTest {
    // ============================================================================================ camino feliz y orden

    @Test
    fun `OPEN y luego SAVE_MARKS con el requestId sellado y la revision real`() = runTest {
        val rig = Rig()
        val saveId = rig.store.prepared()
        val sealedRequestId = rig.store.op(saveId).requestId!!
        val report = rig.run()
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), report)
        assertEquals(listOf("GET today", "GET roster", "POST open", "GET day", "POST marks"), rig.server.requests)
        val post = rig.server.markPosts.single()
        assertEquals(sealedRequestId, post.requestId)
        assertEquals(1, post.expectedRevision) // la revision que devolvio el servidor al abrir
        assertEquals(listOf(WireMark(S1, "present"), WireMark(S2, "absent")), post.marks)
        assertEquals(OperationState.ACKNOWLEDGED, rig.store.op("open-1").state)
        val save = rig.store.op(saveId)
        assertEquals(OperationState.ACKNOWLEDGED, save.state)
        assertEquals(2, save.ackRevision)
        assertEquals(rig.server.day!!.id, save.serverDayId)
        assertEquals(1, rig.sessions.closed)
        assertEquals(mapOf(S1 to "present", S2 to "absent"), rig.server.day!!.marks)
    }

    @Test
    fun `si la lista de hoy ya existe se reutiliza sin abrir otra`() = runTest {
        val rig = Rig()
        rig.server.existingDay(revision = 1)
        rig.store.prepared()
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(0, rig.server.requests.count { it == "POST open" })
        assertEquals(OperationState.ACKNOWLEDGED, rig.store.op("open-1").state)
        assertEquals(rig.server.day!!.id, rig.store.op("open-1").serverDayId)
    }

    @Test
    fun `sin nada preparado no hay ninguna peticion`() = runTest {
        val rig = Rig()
        assertEquals(SyncResultKind.NOTHING_TO_SEND, rig.run().kind)
        assertTrue(rig.server.requests.isEmpty())
        assertEquals(1, rig.sessions.closed)
    }

    @Test
    fun `repetir el ciclo ya confirmado no escribe nada ni duplica`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.run()
        val events = rig.server.day!!.events
        assertEquals(SyncResultKind.NOTHING_TO_SEND, rig.run().kind)
        assertEquals(1, rig.posts().count { it == "POST marks" })
        assertEquals(events, rig.server.day!!.events)
    }

    // ============================================================================================ validacion remota (autoridad = servidor)

    @Test
    fun `una operacion de otra fecha no se envia por el flujo ordinario`() = runTest {
        val rig = Rig()
        rig.store.prepared(date = "2026-10-26")
        val report = rig.run()
        assertEquals(SyncResultKind.NEEDS_REVIEW, report.kind)
        assertTrue(rig.posts().isEmpty())
        assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
    }

    @Test
    fun `si el telefono esta en otro dia que el servidor la operacion pasa a revision y no se envia`() = runTest {
        val rig = Rig()
        rig.server.schoolToday = "2026-10-28"
        rig.store.prepared() // sellada con fecha 2026-10-27
        assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
        assertTrue(rig.posts().isEmpty())
    }

    @Test
    fun `un grupo que ya no esta asignado hoy se bloquea sin enumerar nada`() = runTest {
        val rig = Rig()
        rig.server.assigned = false
        rig.store.prepared()
        assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
        assertTrue(rig.posts().isEmpty())
        assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
    }

    @Test
    fun `un dia sin clases no abre ni guarda`() = runTest {
        val rig = Rig()
        rig.server.isSchoolDay = false
        rig.store.prepared()
        assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
        assertTrue(rig.posts().isEmpty())
    }

    @Test
    fun `si el padron cambio no se envia y no se toca nada`() = runTest {
        val rig = Rig()
        rig.server.roster = listOf(S1, S2, S3, "54444444-0000-4000-8000-0000000000a4") // alta en el servidor
        rig.store.prepared()
        assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
        assertEquals(0, rig.server.markPosts.size)
        assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
        assertTrue(rig.store.payloads.getValue("save-1").size == 2) // payload intacto
    }

    @Test
    fun `si otra prefecta cambio la lista despues de nuestro ultimo recibo es CONFLICT y no se sobrescribe`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind) // recibo con la revision 2
        rig.server.otherPrefectSaves(S3, "absent") // otra persona guarda: revision 3
        // una edicion posterior de este dispositivo, ya sellada y encadenada al recibo anterior
        rig.store.ops["save-2"] = SyncOp(
            "save-2", OperationKind.SAVE_MARKS, OperationState.WAITING_REMOTE_CONTEXT, 3, GROUP, REMOTE_GROUP, DRAFT, TODAY,
            "bbbbbbbb-0000-4000-8000-000000000002", null, null, "save-1", null, 1, 0,
        )
        rig.store.payloads["save-2"] = listOf(WireMark(S1, "absent"))
        val before = rig.server.markPosts.size
        assertEquals(SyncResultKind.CONFLICT, rig.run().kind)
        assertEquals(before, rig.server.markPosts.size) // no se envio nada
        assertEquals(OperationState.CONFLICT, rig.store.op("save-2").state)
        assertEquals("absent", rig.server.day!!.marks[S3]) // lo de la otra persona sigue intacto
        assertEquals("present", rig.server.day!!.marks[S1]) // y nada se sobrescribio
    }

    @Test
    fun `una marca ajena distinta en un alumno nunca escrito por este dispositivo es conflicto`() = runTest {
        val rig = Rig()
        rig.server.existingDay(revision = 3).marks[S1] = "absent" // otra prefecta marco Ausente
        rig.store.prepared() // este dispositivo quiere S1 = present
        assertEquals(SyncResultKind.CONFLICT, rig.run().kind)
        assertEquals(0, rig.server.markPosts.size)
        assertEquals("absent", rig.server.day!!.marks[S1])
    }

    @Test
    fun `la misma marca que ya tiene el servidor no es conflicto`() = runTest {
        val rig = Rig()
        rig.server.existingDay(revision = 3).marks[S1] = "present"
        rig.store.prepared()
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(3, rig.server.markPosts.single().expectedRevision)
    }

    @Test
    fun `una lista finalizada es conflicto y no se envia`() = runTest {
        val rig = Rig()
        rig.server.existingDay(finalized = true)
        rig.store.prepared()
        assertEquals(SyncResultKind.CONFLICT, rig.run().kind)
        assertEquals(0, rig.server.markPosts.size)
        assertEquals(OperationState.CONFLICT, rig.store.op("save-1").state)
    }

    @Test
    fun `NEEDS_REVIEW y CONFLICT bloquean el envio y no se limpian solos`() = runTest {
        for (blocked in listOf(OperationState.NEEDS_REVIEW, OperationState.CONFLICT)) {
            val rig = Rig()
            rig.store.prepared()
            rig.store.ops["save-1"] = rig.store.op("save-1").copy(state = blocked)
            val kind = rig.run().kind
            assertEquals(if (blocked == OperationState.CONFLICT) SyncResultKind.CONFLICT else SyncResultKind.NEEDS_REVIEW, kind)
            assertTrue(rig.posts().isEmpty())
            assertEquals(blocked, rig.store.op("save-1").state)
        }
    }

    // ============================================================================================ errores HTTP (Fase L)

    private fun failingSave(status: Int, code: String?, retryAfter: Int? = null): Rig {
        val rig = Rig()
        rig.store.prepared()
        rig.server.writeFailures = ArrayDeque()
        rig.server.existingDay(1)
        rig.server.writeFailures.addLast(ApiResult.Failure(status, code, retryAfter))
        return rig
    }

    @Test
    fun `409 REVISION_CONFLICT es CONFLICT y 409 IDEMPOTENCY_MISMATCH es NEEDS_REVIEW sin mutar el payload`() = runTest {
        val a = failingSave(409, "REVISION_CONFLICT")
        assertEquals(SyncResultKind.CONFLICT, a.run().kind)
        assertEquals(OperationState.CONFLICT, a.store.op("save-1").state)
        val b = failingSave(409, "IDEMPOTENCY_MISMATCH")
        val payloadBefore = b.store.payloads.getValue("save-1")
        assertEquals(SyncResultKind.NEEDS_REVIEW, b.run().kind)
        assertEquals(OperationState.NEEDS_REVIEW, b.store.op("save-1").state)
        assertEquals(payloadBefore, b.store.payloads.getValue("save-1"))
        assertEquals(1, b.server.markPosts.size) // sin reintento automatico
    }

    @Test
    fun `los 409 y 400 de fecha dia o alumno van a revision`() = runTest {
        for ((status, code) in listOf(409 to "NOT_SCHOOL_DAY", 409 to "DAY_NOT_CURRENT", 400 to "DATE_NOT_TODAY", 400 to "STUDENT_NOT_IN_LIST")) {
            val rig = failingSave(status, code)
            assertEquals("$status $code", SyncResultKind.NEEDS_REVIEW, rig.run().kind)
            assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
            assertEquals(1, rig.server.markPosts.size)
        }
    }

    @Test
    fun `403 y 404 detienen y conservan sin reintentar`() = runTest {
        for (status in listOf(403, 404)) {
            val rig = failingSave(status, "X")
            assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
            assertEquals(1, rig.server.markPosts.size)
            assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
            assertNull(rig.store.blocked)
        }
    }

    @Test
    fun `dispositivo revocado o cuenta no elegible exigen autenticacion y bloquean el perfil`() = runTest {
        val rig = failingSave(401, "DEVICE_REVOKED") // el backend real responde 401 (no 403) para un dispositivo revocado
        assertEquals(SyncResultKind.SESSION_REQUIRED, rig.run().kind)
        assertEquals(OperationState.AUTH_REQUIRED, rig.store.op("save-1").state)
        assertEquals(OfflineCacheStore.AUTH_DEVICE_REVOKED, rig.store.blocked)
        // y tambien cuando la revocacion se descubre al ABRIR LA SESION (antes de cualquier lectura)
        val early = Rig(sessions = SyncFakeSessions(ApiResult.Failure(401, "DEVICE_REVOKED")))
        early.store.prepared()
        assertEquals(SyncResultKind.SESSION_REQUIRED, early.run().kind)
        assertEquals(OfflineCacheStore.AUTH_DEVICE_REVOKED, early.store.blocked)
        assertTrue(early.server.requests.isEmpty())
        val other = failingSave(403, "NOT_ELIGIBLE")
        other.run()
        assertEquals(OfflineCacheStore.AUTH_ACCOUNT_BLOCKED, other.store.blocked)
    }

    @Test
    fun `una sesion invalida no se repite en bucle`() = runTest {
        val rig = Rig(sessions = SyncFakeSessions(ApiResult.Failure(401, "SESSION_ENDED")))
        rig.store.prepared()
        assertEquals(SyncResultKind.SESSION_REQUIRED, rig.run().kind)
        assertTrue(rig.server.requests.isEmpty()) // ni siquiera llego al servidor
        assertEquals(OperationState.READY, rig.store.op("open-1").state) // nada cambio de estado
        // 401 durante el guardado: AUTH_REQUIRED, una sola peticion
        val rig2 = failingSave(401, "SESSION_ENDED")
        assertEquals(SyncResultKind.SESSION_REQUIRED, rig2.run().kind)
        assertEquals(OperationState.AUTH_REQUIRED, rig2.store.op("save-1").state)
        assertEquals(1, rig2.server.markPosts.size)
    }

    @Test
    fun `429 respeta Retry-After con reintentos acotados y el mismo requestId`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.existingDay(1)
        rig.server.writeFailures.addLast(ApiResult.Failure(429, "RATE_LIMITED", 3))
        rig.server.writeFailures.addLast(ApiResult.Failure(429, "RATE_LIMITED", 3))
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(listOf(3_000L, 3_000L), rig.pauses)
        assertEquals(3, rig.server.markPosts.size)
        assertEquals(1, rig.server.markPosts.map { it.requestId }.toSet().size)
        assertEquals(1, rig.server.markPosts.map { it.expectedRevision }.toSet().size)
        assertEquals(1, rig.server.day!!.events) // una sola aplicacion efectiva
    }

    @Test
    fun `503 agota el limite de reintentos y deja la operacion reintentable`() = runTest {
        val rig = failingSave(503, "DATABASE_UNAVAILABLE")
        repeat(2) { rig.server.writeFailures.addLast(ApiResult.Failure(503, "DATABASE_UNAVAILABLE")) }
        assertEquals(SyncResultKind.TEMPORARY_ERROR, rig.run().kind)
        assertEquals(OperationState.RETRYABLE_ERROR, rig.store.op("save-1").state)
        assertEquals(1 + SyncPolicy.MAX_RETRIES, rig.server.markPosts.size)
        assertEquals(listOf(1_000L, 2_000L), rig.pauses)
        // el siguiente ciclo MANUAL reintenta exactamente la misma operacion
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(1, rig.server.markPosts.map { it.requestId }.toSet().size)
    }

    // ============================================================================================ resultado desconocido y recuperacion

    @Test
    fun `una respuesta perdida despues de aplicarse se recupera con el mismo requestId sin duplicar`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.dropResponseOnce = true
        val first = rig.run()
        assertEquals(SyncResultKind.RESULT_UNKNOWN, first.kind)
        assertEquals(OperationState.RETRYABLE_ERROR, rig.store.op("save-1").state)
        assertEquals(mapOf(S1 to "present", S2 to "absent"), rig.server.day!!.marks) // el servidor SI lo aplico
        val revisionAfterFirst = rig.server.day!!.revision
        // siguiente ciclo manual: misma operacion, replay del servidor, recibo guardado una sola vez
        val second = rig.run()
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), second)
        assertEquals(2, rig.server.markPosts.size)
        assertEquals(1, rig.server.markPosts.map { it.requestId }.toSet().size)
        assertEquals(rig.server.markPosts[0].marks, rig.server.markPosts[1].marks)
        assertEquals(1, rig.server.day!!.events) // sin eventos duplicados
        assertEquals(revisionAfterFirst, rig.server.day!!.revision)
        assertEquals(OperationState.ACKNOWLEDGED, rig.store.op("save-1").state)
    }

    @Test
    fun `una peticion que nunca llego tambien se reintenta igual y se aplica una vez`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.existingDay(1)
        rig.server.writeFailures.addLast(ApiResult.Failure(0, null)) // no llego
        assertEquals(SyncResultKind.RESULT_UNKNOWN, rig.run().kind)
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(1, rig.server.day!!.events)
    }

    @Test
    fun `si falla Room al guardar el recibo de las marcas no hay exito y se recupera despues sin duplicar`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.store.failAckFor = "save-1"
        val report = rig.run()
        assertEquals(SyncResultKind.RESULT_UNKNOWN, report.kind) // nada de exito prematuro
        assertEquals(0, report.confirmed)
        assertEquals(OperationState.SENDING, rig.store.op("save-1").state) // resultado desconocido persistido
        assertEquals(mapOf(S1 to "present", S2 to "absent"), rig.server.day!!.marks) // el servidor si lo aplico
        rig.store.failAckFor = null
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), rig.run())
        assertEquals(1, rig.server.day!!.events)
        assertEquals(1, rig.server.markPosts.map { it.requestId }.toSet().size)
        assertEquals(OperationState.ACKNOWLEDGED, rig.store.op("save-1").state)
    }

    @Test
    fun `si falla Room al guardar el recibo de OPEN el siguiente ciclo no abre otra lista`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.store.failAckFor = "open-1"
        assertEquals(SyncResultKind.RESULT_UNKNOWN, rig.run().kind)
        assertEquals(1, rig.server.requests.count { it == "POST open" })
        assertEquals(0, rig.server.markPosts.size) // sin contexto confirmado no se guardan marcas
        rig.store.failAckFor = null
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(1, rig.server.requests.count { it == "POST open" }) // la lista ya existia: se consulto, no se abrio de nuevo
    }

    @Test
    fun `un recibo que no corresponde a lo enviado manda la operacion a revision`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.existingDay(1)
        // el servidor responde con OTRA lista: simulamos cambiando el id despues de aplicar
        val wrong = object : AttendanceApi by rig.server {
            override suspend fun saveMarks(session: MobileSession, dayId: String, expectedRevision: Int, requestId: String, marks: List<WireMark>): ApiResult<SrvSave> {
                val ok = rig.server.saveMarks(session, dayId, expectedRevision, requestId, marks) as ApiResult.Ok
                val bad = ok.value.copy(detail = ok.value.detail.copy(day = ok.value.detail.day.copy(id = "99999999-0000-4000-8000-000000000009")))
                return ApiResult.Ok(bad)
            }
        }
        val engine = ManualSyncEngine(PROFILE, rig.store, wrong, rig.sessions, { DEVICE }, pause = {})
        assertEquals(SyncResultKind.NEEDS_REVIEW, engine.run(GROUP)!!.kind)
        assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
        assertEquals(OutboxReasons.ACK_MISMATCH, rig.store.journal.last { it.startsWith("save-1 reason") }.substringAfter("reason=").substringBefore(" "))
    }

    @Test
    fun `un SENDING que quedo tras morir el proceso nunca es exito y se verifica con el mismo requestId`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.existingDay(1)
        // el ciclo anterior murio justo despues de aplicarse en el servidor
        rig.server.saveMarks(SESSION, rig.server.day!!.id, 1, rig.store.op("save-1").requestId!!, rig.store.payloads.getValue("save-1"))
        rig.store.ops["open-1"] = rig.store.op("open-1").copy(state = OperationState.ACKNOWLEDGED, serverDayId = rig.server.day!!.id, ackRevision = 1)
        rig.store.ops["save-1"] = rig.store.op("save-1").copy(state = OperationState.SENDING, serverDayId = rig.server.day!!.id, expectedRevision = 1)
        rig.server.markPosts.clear()
        val report = rig.run()
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), report)
        val post = rig.server.markPosts.single()
        assertEquals(1, post.expectedRevision) // la revision ORIGINAL: no se recalcula en una verificacion
        assertEquals(1, rig.server.day!!.events)
    }

    @Test
    fun `una operacion de ayer con resultado desconocido solo se verifica nunca se crea una nueva`() = runTest {
        val rig = Rig()
        rig.server.schoolToday = "2026-10-28"
        rig.server.dayDate = "2026-10-27"
        rig.store.prepared(date = "2026-10-27")
        val d = rig.server.existingDay(2)
        rig.store.ops["open-1"] = rig.store.op("open-1").copy(state = OperationState.ACKNOWLEDGED, serverDayId = d.id, ackRevision = 1)
        d.marks.putAll(mapOf(S1 to "present", S2 to "absent"))
        d.applied[rig.store.op("save-1").requestId!!] = OutboxCanonical.marksHash(rig.store.payloads.getValue("save-1"))
        rig.store.ops["save-1"] = rig.store.op("save-1").copy(state = OperationState.RETRYABLE_ERROR, serverDayId = d.id, expectedRevision = 1)
        val report = rig.run()
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), report)
        assertEquals(0, rig.server.requests.count { it == "POST open" })
        assertEquals(2, d.revision) // el servidor no cambio
    }

    // ============================================================================================ cancelacion, identidad y concurrencia

    @Test
    fun `cancelar con una peticion en vuelo deja la operacion como resultado desconocido y conserva todo`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.existingDay(1)
        rig.server.gate = CompletableDeferred()
        val job = launch { rig.engine.run(GROUP) }
        runCurrent()
        assertEquals(OperationState.SENDING, rig.store.op("save-1").state)
        job.cancel()
        advanceUntilIdle()
        assertEquals(OperationState.RETRYABLE_ERROR, rig.store.op("save-1").state)
        assertEquals(2, rig.store.payloads.getValue("save-1").size)
        assertNotNull(rig.store.op("save-1").requestId)
        assertEquals(1, rig.sessions.closed)
        // se puede reanudar luego
        rig.server.gate = null
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
    }

    @Test
    fun `si cambia la identidad a mitad del ciclo se detiene sin enviar mas`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        var calls = 0
        val engine = ManualSyncEngine(PROFILE, rig.store, rig.server, rig.sessions, { if (++calls > 3) "otro-dispositivo" else DEVICE }, pause = {})
        val report = engine.run(GROUP)!!
        assertEquals(SyncResultKind.NOT_ALLOWED, report.kind)
        assertTrue(rig.server.markPosts.isEmpty())
    }

    @Test
    fun `un perfil de demostracion o ajeno no puede usar el transporte`() = runTest {
        val demo = Rig(profile = "demo")
        demo.store.prepared()
        assertEquals(SyncResultKind.NOT_ALLOWED, demo.run().kind)
        assertTrue(demo.server.requests.isEmpty())
        val other = Rig(device = "dddddddd-0000-4000-8000-0000000000ff") // otro dispositivo vinculado
        other.store.prepared()
        assertEquals(SyncResultKind.NOT_ALLOWED, other.run().kind)
        assertTrue(other.server.requests.isEmpty())
        val none = Rig(device = null)
        assertEquals(SyncResultKind.NOT_ALLOWED, none.run().kind)
    }

    @Test
    fun `solo un ciclo a la vez`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.existingDay(1)
        rig.server.gate = CompletableDeferred()
        val first = launch { rig.engine.run(GROUP) }
        runCurrent()
        assertNull(rig.engine.run(GROUP)) // el segundo no entra
        rig.server.gate!!.complete(Unit)
        advanceUntilIdle()
        first.join()
        assertEquals(1, rig.server.markPosts.size)
    }

    @Test
    fun `el servidor sin la sincronizacion habilitada se informa sin tocar nada`() = runTest {
        val rig = Rig()
        rig.server.enabled = false
        rig.store.prepared()
        assertEquals(SyncResultKind.NOT_ENABLED, rig.run().kind)
        assertEquals(OperationState.READY, rig.store.op("open-1").state)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, rig.store.op("save-1").state)
    }

    @Test
    fun `sin red no cambia ningun estado`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.readFailures.addLast(ApiResult.Failure(0, null))
        assertEquals(SyncResultKind.OFFLINE, rig.run().kind)
        assertEquals(OperationState.READY, rig.store.op("open-1").state)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, rig.store.op("save-1").state)
        assertTrue(rig.posts().isEmpty())
    }

    // ============================================================================================ nada envia solo

    @Test
    fun `construir el motor y cambiar la conectividad no inicia ninguna peticion`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        // "reconexion": el motor no escucha la red; solo run() (accion de la persona) hace peticiones
        repeat(5) { rig.device = DEVICE }
        advanceUntilIdle()
        assertTrue(rig.server.requests.isEmpty())
    }

    @Test
    fun `la maquina de estados de la outbox admite los pasos del transporte y solo esos`() {
        val t = OutboxTransitions.ALLOWED
        // lo que el motor necesita
        assertTrue(OperationState.WAITING_REMOTE_CONTEXT.canTransitionTo(OperationState.CONFLICT))
        assertTrue(OperationState.READY.canTransitionTo(OperationState.CONFLICT))
        assertTrue(OperationState.READY.canTransitionTo(OperationState.SENDING))
        assertTrue(OperationState.SENDING.canTransitionTo(OperationState.ACKNOWLEDGED))
        assertTrue(OperationState.RETRYABLE_ERROR.canTransitionTo(OperationState.SENDING))
        // lo que NUNCA: una operacion confirmada no vuelve atras ni se limpia un NEEDS_REVIEW hacia SENDING
        assertTrue(t.getValue(OperationState.ACKNOWLEDGED).isEmpty())
        assertFalse(OperationState.NEEDS_REVIEW.canTransitionTo(OperationState.SENDING))
        assertFalse(OperationState.CONFLICT.canTransitionTo(OperationState.SENDING))
        assertFalse(OperationState.LOCAL_ONLY.canTransitionTo(OperationState.SENDING))
    }

    // ============================================================================================ auditoria 45: bloqueos por fecha

    @Test
    fun `una operacion bloqueada de ayer NO impide sincronizar la lista de hoy del mismo grupo`() = runTest {
        val rig = Rig()
        // ayer: quedo en revision y nadie puede resolverla todavia (no hay politica de la escuela)
        rig.store.prepared(date = "2026-10-26", saveId = "old-save", openId = "old-open")
        rig.store.ops["old-save"] = rig.store.op("old-save").copy(state = OperationState.NEEDS_REVIEW)
        rig.store.ops["old-open"] = rig.store.op("old-open").copy(state = OperationState.NEEDS_REVIEW)
        // hoy: una captura nueva, preparada y valida
        rig.store.prepared(date = TODAY, saveId = "new-save", openId = "new-open")
        val report = rig.run()
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), report)
        assertEquals(OperationState.ACKNOWLEDGED, rig.store.op("new-save").state)
        // lo de ayer sigue bloqueado y conservado: no se limpia, no se envia, no se mueve a hoy
        assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("old-save").state)
        assertEquals("2026-10-26", rig.store.op("old-save").schoolDate)
        assertEquals(1, rig.server.markPosts.size)
    }

    @Test
    fun `un CONFLICT de otra fecha tampoco bloquea hoy y un fallo temporal de hoy se informa tal cual`() = runTest {
        val rig = Rig()
        rig.store.prepared(date = "2026-10-26", saveId = "old-save", openId = "old-open")
        rig.store.ops["old-save"] = rig.store.op("old-save").copy(state = OperationState.CONFLICT)
        rig.store.ops["old-open"] = rig.store.op("old-open").copy(state = OperationState.ACKNOWLEDGED)
        rig.store.prepared(date = TODAY, saveId = "new-save", openId = "new-open")
        rig.server.existingDay(1)
        repeat(3) { rig.server.writeFailures.addLast(ApiResult.Failure(503, "DATABASE_UNAVAILABLE")) }
        assertEquals(SyncResultKind.TEMPORARY_ERROR, rig.run().kind) // lo que pasa HOY se informa; lo de ayer no lo tapa
        assertEquals(OperationState.CONFLICT, rig.store.op("old-save").state)
    }

    @Test
    fun `una operacion de ayer que solo estaba bloqueada informa revision si hoy no hay nada que enviar`() = runTest {
        val rig = Rig()
        rig.store.prepared(date = "2026-10-26", saveId = "old-save", openId = "old-open")
        rig.store.ops["old-save"] = rig.store.op("old-save").copy(state = OperationState.NEEDS_REVIEW)
        assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
        assertTrue(rig.posts().isEmpty())
    }

    // ============================================================================================ auditoria 45: un solo ciclo con varios hilos

    @Test
    fun `veinte pulsaciones simultaneas desde hilos distintos inician un unico ciclo y el estado sigue en ejecucion`() {
        kotlinx.coroutines.runBlocking {
            val rig = Rig()
            rig.store.prepared()
            rig.server.existingDay(1)
            rig.server.gate = CompletableDeferred()
            val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default + kotlinx.coroutines.SupervisorJob())
            val manual = DebugManualSync(scope, rig.engine)
            val start = java.util.concurrent.CountDownLatch(1)
            val threads = (1..20).map { Thread { start.await(); manual.syncNow(GROUP) } }
            threads.forEach { it.start() }
            start.countDown()
            threads.forEach { it.join() }
            // espera a que el ciclo llegue a la peticion de guardado (bloqueada en la compuerta)
            val end = System.currentTimeMillis() + 10_000
            while (rig.server.markPosts.isEmpty() && System.currentTimeMillis() < end) kotlinx.coroutines.delay(10)
            kotlinx.coroutines.delay(300) // da tiempo a que un ciclo duplicado, si existiera, termine y apague el indicador
            assertTrue("el indicador de ejecucion debe seguir encendido mientras el ciclo esta en curso", manual.state.value.running)
            assertEquals(1, rig.server.markPosts.size)
            rig.server.gate!!.complete(Unit)
            val end2 = System.currentTimeMillis() + 10_000
            while (manual.state.value.running && System.currentTimeMillis() < end2) kotlinx.coroutines.delay(10)
            assertEquals(SyncResultKind.CONFIRMED, manual.state.value.last?.kind)
            assertEquals(1, rig.server.markPosts.size)
            scope.cancel()
        }
    }

    // ============================================================================================ prompt 46: padron ANTES de OPEN

    @Test
    fun `un padron remoto distinto se detecta ANTES de abrir - no se abre la lista ni se envia nada`() = runTest {
        for (remote in listOf(listOf(S1, S2, S3, "54444444-0000-4000-8000-0000000000a4"), listOf(S1, S2))) { // alumno incorporado / dado de baja
            val rig = Rig()
            rig.server.roster = remote
            rig.store.prepared()
            val payloadBefore = rig.store.payloads.getValue("save-1")
            assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
            assertEquals(listOf("GET today", "GET roster"), rig.server.requests) // ni POST open ni lectura de lista
            assertNull(rig.server.day) // el servidor no tiene ninguna lista nueva
            assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("open-1").state)
            assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
            assertEquals(payloadBefore, rig.store.payloads.getValue("save-1")) // el borrador/payload no se tocan
            // el siguiente ciclo sigue bloqueado y sin escrituras
            assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
            assertTrue(rig.posts().isEmpty())
        }
    }

    @Test
    fun `si la lista de hoy ya existe no se consulta el padron antes (la valida el detalle de la lista)`() = runTest {
        val rig = Rig()
        rig.server.existingDay(1)
        rig.store.prepared()
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        assertEquals(0, rig.server.requests.count { it == "GET roster" })
    }

    @Test
    fun `el padron coincide y la lista se abre con normalidad (GET roster antes de POST open)`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        assertEquals(SyncResultKind.CONFIRMED, rig.run().kind)
        val order = rig.server.requests
        assertTrue(order.indexOf("GET roster") in 0 until order.indexOf("POST open"))
    }

    @Test
    fun `un 404 del padron (grupo ya no autorizado) bloquea sin abrir y un fallo temporal no cambia nada`() = runTest {
        val gone = Rig()
        gone.server.assigned = true
        gone.server.rosterFailure = ApiResult.Failure(404, "NOT_FOUND")
        gone.store.prepared()
        assertEquals(SyncResultKind.NEEDS_REVIEW, gone.run().kind)
        assertEquals(OperationState.NEEDS_REVIEW, gone.store.op("save-1").state)
        assertTrue(gone.posts().isEmpty())
        val temp = Rig()
        temp.server.rosterFailure = ApiResult.Failure(503, "DATABASE_UNAVAILABLE")
        temp.store.prepared()
        assertEquals(SyncResultKind.TEMPORARY_ERROR, temp.run().kind)
        assertEquals(OperationState.READY, temp.store.op("open-1").state) // nada cambio: se puede reintentar
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, temp.store.op("save-1").state)
        assertTrue(temp.posts().isEmpty())
    }

    @Test
    fun `si el padron cambia ENTRE la comparacion y OPEN no se envia ninguna marca (no hay atomicidad entre llamadas, pero SAVE_MARKS lo detecta)`() = runTest {
        val rig = Rig()
        rig.store.prepared()
        rig.server.beforeOpen = { rig.server.roster = rig.server.roster + "54444444-0000-4000-8000-0000000000a4" } // cambia justo antes de abrir
        assertEquals(SyncResultKind.NEEDS_REVIEW, rig.run().kind)
        assertEquals(1, rig.server.requests.count { it == "POST open" }) // la carrera permite abrir (limite del contrato)...
        assertEquals(0, rig.server.markPosts.size) // ...pero JAMAS se envian marcas con otro padron
        assertEquals(OperationState.NEEDS_REVIEW, rig.store.op("save-1").state)
    }
}
