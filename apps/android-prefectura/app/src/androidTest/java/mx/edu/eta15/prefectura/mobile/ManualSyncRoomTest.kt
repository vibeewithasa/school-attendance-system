package mx.edu.eta15.prefectura.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.data.DownloadSpec
import mx.edu.eta15.prefectura.data.DownloadedGroup
import mx.edu.eta15.prefectura.data.DownloadedStudent
import mx.edu.eta15.prefectura.data.LocalAttendanceRepository
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.OutboxStore
import mx.edu.eta15.prefectura.data.ProfileAccessGate
import mx.edu.eta15.prefectura.data.SandboxIds
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxCanonical
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.domain.SyncReport
import mx.edu.eta15.prefectura.domain.SyncResultKind
import mx.edu.eta15.prefectura.domain.WireMark
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Servidor de PRUEBAS en memoria con la semantica real del backend (idempotencia por requestId, revision optimista, padron congelado). */
private class RoomFakeServer(val remoteGroup: String, var roster: List<String>) : AttendanceApi {
    var schoolToday = "2026-10-27"
    var assigned = true

    class Day(val id: String, var revision: Int) {
        val marks = mutableMapOf<String, String>()
        val applied = mutableMapOf<String, String>()
        var events = 0
    }

    var day: Day? = null
    val requests = mutableListOf<String>()
    val savedRequestIds = mutableListOf<String>()
    var dropResponseOnce = false
    var gate: CompletableDeferred<Unit>? = null

    private fun dto(d: Day) = SrvDay(d.id, remoteGroup, schoolToday, "draft", d.revision)

    private fun detail(d: Day) = SrvDetail(schoolToday, dto(d), SyncPolicy.rosterDigestV1(roster), roster.map { SrvRecord(it, d.marks[it] ?: "pending") })

    override suspend fun today(session: MobileSession): ApiResult<SrvToday> {
        requests += "GET today"
        return ApiResult.Ok(SrvToday(schoolToday, true, if (assigned) listOf(SrvTodayGroup(remoteGroup, day?.let(::dto))) else emptyList()))
    }

    override suspend fun day(session: MobileSession, dayId: String): ApiResult<SrvDetail> {
        requests += "GET day"
        val d = day?.takeIf { it.id == dayId } ?: return ApiResult.Failure(404, "NOT_FOUND")
        return ApiResult.Ok(detail(d))
    }

    override suspend fun groupRoster(session: MobileSession, groupId: String): ApiResult<Roster> {
        requests += "GET roster"
        return ApiResult.Ok(Roster("1.º A", roster.map { RosterStudent(it, "Alumno Ficticio") }, remoteGroup, schoolToday))
    }

    override suspend fun openDay(session: MobileSession, groupId: String, attendanceDate: String): ApiResult<SrvOpen> {
        requests += "POST open"
        if (attendanceDate != schoolToday) return ApiResult.Failure(400, "DATE_NOT_TODAY")
        day?.let { return ApiResult.Ok(SrvOpen(detail(it), false)) }
        val created = Day(UUID.randomUUID().toString(), 1).also { day = it }
        return ApiResult.Ok(SrvOpen(detail(created), true))
    }

    override suspend fun saveMarks(session: MobileSession, dayId: String, expectedRevision: Int, requestId: String, marks: List<WireMark>): ApiResult<SrvSave> {
        requests += "POST marks"
        savedRequestIds += requestId
        gate?.await()
        val d = day?.takeIf { it.id == dayId } ?: return ApiResult.Failure(404, "NOT_FOUND")
        val hash = OutboxCanonical.marksHash(marks)
        d.applied[requestId]?.let { return if (it == hash) ApiResult.Ok(SrvSave(detail(d), 0, true)) else ApiResult.Failure(409, "IDEMPOTENCY_MISMATCH") }
        if (d.revision != expectedRevision) return ApiResult.Failure(409, "REVISION_CONFLICT")
        if (marks.any { it.studentId !in roster }) return ApiResult.Failure(400, "STUDENT_NOT_IN_LIST")
        var changed = 0
        marks.forEach { if (d.marks[it.studentId] != it.status) { d.marks[it.studentId] = it.status; changed++ } }
        d.applied[requestId] = hash
        d.events++
        if (changed > 0) d.revision++
        if (dropResponseOnce) {
            dropResponseOnce = false
            return ApiResult.Failure(0, null)
        }
        return ApiResult.Ok(SrvSave(detail(d), changed, false))
    }

    fun otherPrefectSaves(student: String, status: String) {
        val d = day!!
        d.marks[student] = status
        d.revision++
        d.events++
    }
}

private class RoomFakeSessions(var failure: ApiResult.Failure? = null) : SyncSessions {
    private val session = MobileSession("acceso", "renovacion", Instant.now().plusSeconds(600), Instant.now().plusSeconds(3600), Instant.now().plusSeconds(28_800), "dev")

    override suspend fun <T> authed(block: suspend (MobileSession) -> ApiResult<T>): ApiResult<T> = failure ?: block(session)

    override suspend fun close() = Unit
}

/**
 * Motor del ciclo manual contra Room REAL (SQLCipher en la prueba de reapertura) y un servidor falso con la semantica del backend:
 * recibo atomico, persistencia, rollback, resultado desconocido, conflictos, aislamiento por perfil y edicion local concurrente.
 */
@RunWith(AndroidJUnit4::class)
class ManualSyncRoomTest {
    private val clock = MutableClock()
    private val policy = OfflinePolicy(Duration.ofMinutes(10))
    private lateinit var db: EtaDatabase
    private lateinit var cache: OfflineCacheStore

    private val deviceA = "dddddddd-0000-4000-8000-00000000000a"
    private val deviceB = "dddddddd-0000-4000-8000-00000000000b"
    private val g1 = "11111111-0000-4000-8000-000000000001"
    private val s1 = "51111111-0000-4000-8000-0000000000a1"
    private val s2 = "52222222-0000-4000-8000-0000000000a2"
    private val s3 = "53333333-0000-4000-8000-0000000000a3"
    private val tuesday = "2026-10-27"

    private class UuidIds(private val seed: String) : IdGenerator {
        private var n = 0
        override fun newId(): String = UUID.nameUUIDFromBytes("$seed-${++n}".toByteArray()).toString()
    }

    @Before
    fun setUp() {
        db = EtaDatabase.inMemory(testContext())
        cache = OfflineCacheStore(db, clock, policy)
    }

    @After
    fun tearDown() = db.close()

    private val idsByDevice = mutableMapOf<String, IdGenerator>()

    private fun profile(device: String) = SandboxIds.profile(device)

    private fun group(device: String) = SandboxIds.group(profile(device), g1)

    private fun student(device: String, remote: String) = SandboxIds.student(group(device), remote)

    private fun spec(device: String, roster: List<String> = listOf(s1, s2, s3), revoked: Set<String> = emptySet(), serverDate: String = tuesday) = DownloadSpec(
        device, "Prefectura ficticia", serverDate,
        if (revoked.isNotEmpty()) emptyList() else listOf(
            DownloadedGroup(g1, "1.º A", 1, "A", "matutino", "aaaaaaaa-0000-4000-8000-0000000000aa", "2026-2027", roster.map { DownloadedStudent(it, "Alumno", it.take(4)) }),
        ),
        revoked,
    )

    private fun repo(device: String): LocalAttendanceRepository {
        val p = profile(device)
        return LocalAttendanceRepository(db, p, clock, idsByDevice.getOrPut(device) { UuidIds("r-$device") }, access = ProfileAccessGate(db, p, clock, policy))
    }

    private fun store(device: String, repo: LocalAttendanceRepository = repo(device)) = RoomSyncStore(
        OutboxStore(db, clock, idsByDevice.getOrPut(device) { UuidIds("r-$device") }), profile(device), device, cache,
        { repo.schoolToday() }, { id -> repo.prepareForSync(id) },
    )

    private fun engine(device: String, server: AttendanceApi, identity: String? = device, sessions: SyncSessions = RoomFakeSessions()) =
        ManualSyncEngine(profile(device), store(device), server, sessions, { identity }, pause = {})

    /** Espera (hasta 10 s) a que la operacion de marcas llegue a un estado: Room responde en otros hilos. */
    private suspend fun awaitSaveState(expected: OperationState) {
        val end = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < end) {
            if (ops().any { it.kind == "SAVE_MARKS" && it.state == expected.name }) return
            kotlinx.coroutines.delay(25)
        }
        throw AssertionError("la operacion no llego a $expected: ${ops().map { it.kind + ':' + it.state }}")
    }

    private suspend fun download(device: String = deviceA, serverDate: String = tuesday) = cache.commit(spec(device, serverDate = serverDate))

    /** Captura S1 Presente y S2 Ausente (S3 queda Pendiente) y devuelve el borrador. */
    private suspend fun capture(device: String = deviceA): String {
        val repo = repo(device)
        val draft = (repo.openTodayDraft(group(device)) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, student(device, s1), AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, student(device, s2), AttendanceMark.ABSENT))
        return draft
    }

    private fun ops(device: String = deviceA) = runBlocking { db.outboxDao().allOf(profile(device)) }

    private fun state(kind: String, device: String = deviceA) = ops(device).single { it.kind == kind && it.state != OperationState.SUPERSEDED.name }.state

    private fun sql(statement: String) = db.openHelper.writableDatabase.execSQL(statement)

    private fun scalar(query: String): String? = db.openHelper.readableDatabase.query(query).use { c -> if (c.moveToFirst()) c.getString(0) else null }

    private fun marks(device: String = deviceA) = runBlocking { repo(device).observeTodayDraft(group(device)).first()!!.rows.map { it.mark } }

    // ------------------------------------------------------------------------------------------------------------ flujo completo

    @Test
    fun cicloCompletoOpenSaveRecibosDurablesYBorradorIntacto() = runBlocking<Unit> {
        download()
        val draft = capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        val report = engine(deviceA, server).run(group(deviceA))!!
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), report)
        assertEquals(listOf("GET today", "GET roster", "POST open", "GET day", "POST marks"), server.requests) // el padron se compara ANTES de abrir
        assertEquals(mapOf(s1 to "present", s2 to "absent"), server.day!!.marks)
        // recibo local durable
        val all = ops()
        assertEquals(OperationState.ACKNOWLEDGED.name, all.single { it.kind == "OPEN" }.state)
        val save = all.single { it.kind == "SAVE_MARKS" }
        assertEquals(OperationState.ACKNOWLEDGED.name, save.state)
        assertEquals(2, save.ackRevision)
        assertEquals(server.day!!.id, save.serverDayId)
        assertEquals(1, save.expectedRevision)
        assertNotNull(save.requestId)
        assertEquals(1, save.attempts)
        // el borrador y sus marcas no cambiaron; las marcas confirmadas ya no pueden volver a Pendiente
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT, null), marks())
        assertEquals(SetMarkResult.UnmarkAfterAck, repo(deviceA).setMark(draft, student(deviceA, s1), null))
        assertEquals(setOf(s1, s2), OutboxStore(db, clock).acknowledgedStudentIds(draft))
        // repetir: ni una escritura mas
        assertEquals(SyncResultKind.NOTHING_TO_SEND, engine(deviceA, server).run(group(deviceA))!!.kind)
        assertEquals(1, server.requests.count { it == "POST marks" })
        assertEquals(1, server.day!!.events)
    }

    @Test
    fun laEdicionPosteriorSeSelladaYSeEnviaConOtroRequestIdYLaRevisionConfirmada() = runBlocking<Unit> {
        download()
        val draft = capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        engine(deviceA, server).run(group(deviceA))
        val firstRequest = ops().single { it.kind == "SAVE_MARKS" }.requestId
        // la prefecta cambia S1 a Ausente y marca S3 Presente despues de sincronizar
        assertEquals(SetMarkResult.Saved, repo(deviceA).setMark(draft, student(deviceA, s1), AttendanceMark.ABSENT))
        assertEquals(SetMarkResult.Saved, repo(deviceA).setMark(draft, student(deviceA, s3), AttendanceMark.PRESENT))
        val report = engine(deviceA, server).run(group(deviceA))!! // "Sincronizar ahora" sella y envia
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), report)
        val saves = ops().filter { it.kind == "SAVE_MARKS" }.sortedBy { it.seq }
        assertEquals(2, saves.size)
        assertNotEquals(firstRequest, saves[1].requestId)
        assertEquals(saves[0].ackRevision, saves[1].expectedRevision) // la revision CONFIRMADA, no una inventada
        assertEquals(mapOf(s1 to "absent", s2 to "absent", s3 to "present"), server.day!!.marks)
        assertEquals(2, server.day!!.events)
    }

    // ------------------------------------------------------------------------------------------------- recibo, rollback y reinicio

    @Test
    fun siRoomFallaAlGuardarElReciboNoHayExitoYSeRecuperaSinDuplicar() = runBlocking<Unit> {
        download()
        capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        // fallo REAL de Room: un disparador impide solo el recibo de las marcas
        sql(
            "CREATE TRIGGER t_no_ack BEFORE UPDATE OF state ON sync_operations WHEN NEW.state = 'ACKNOWLEDGED' AND NEW.kind = 'SAVE_MARKS' " +
                "BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END",
        )
        val report = engine(deviceA, server).run(group(deviceA))!!
        assertEquals(SyncResultKind.RESULT_UNKNOWN, report.kind) // nunca exito prematuro
        assertEquals(0, report.confirmed)
        assertEquals(OperationState.SENDING.name, state("SAVE_MARKS")) // resultado desconocido persistido
        assertEquals(mapOf(s1 to "present", s2 to "absent"), server.day!!.marks) // el servidor si lo aplico
        sql("DROP TRIGGER t_no_ack")
        // "reinicio": se abre otra vez la base y un SENDING es un resultado desconocido, nunca exito
        assertEquals(1, OutboxStore(db, clock).recoverAfterRestart())
        assertEquals(OperationState.RETRYABLE_ERROR.name, state("SAVE_MARKS"))
        val again = engine(deviceA, server).run(group(deviceA))!!
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), again)
        assertEquals(1, server.day!!.events) // sin duplicados
        assertEquals(1, server.savedRequestIds.toSet().size) // el mismo requestId en todos los intentos
        assertEquals(OperationState.ACKNOWLEDGED.name, state("SAVE_MARKS"))
    }

    @Test
    fun respuestaPerdidaSeRecuperaConElMismoRequestIdEnElSiguienteCicloManual() = runBlocking<Unit> {
        download()
        capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        server.dropResponseOnce = true
        assertEquals(SyncResultKind.RESULT_UNKNOWN, engine(deviceA, server).run(group(deviceA))!!.kind)
        val unknown = ops().single { it.kind == "SAVE_MARKS" }
        assertEquals(OperationState.RETRYABLE_ERROR.name, unknown.state)
        val payloadBefore = OutboxStore(db, clock).payloadOf(unknown.id)
        val rev = server.day!!.revision
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), engine(deviceA, server).run(group(deviceA))!!)
        val after = ops().single { it.kind == "SAVE_MARKS" }
        assertEquals(unknown.requestId, after.requestId)
        assertEquals(payloadBefore, OutboxStore(db, clock).payloadOf(after.id))
        assertEquals(unknown.contentHash, after.contentHash)
        assertEquals(1, ops().count { it.kind == "SAVE_MARKS" }) // ninguna operacion equivalente nueva
        assertEquals(rev, server.day!!.revision)
        assertEquals(1, server.day!!.events)
        assertEquals(1, after.ackReplayed)
    }

    // ------------------------------------------------------------------------------------------------------------ conflictos y bloqueos

    @Test
    fun otraPrefectaCambiaLaListaEsConflictoYTodoSeConserva() = runBlocking<Unit> {
        download()
        val draft = capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        engine(deviceA, server).run(group(deviceA)) // primer envio confirmado (revision 2)
        server.otherPrefectSaves(s3, "absent") // otra persona guarda por su cuenta (revision 3)
        assertEquals(SetMarkResult.Saved, repo(deviceA).setMark(draft, student(deviceA, s1), AttendanceMark.ABSENT))
        val postsBefore = server.requests.count { it == "POST marks" }
        val report = engine(deviceA, server).run(group(deviceA))!!
        assertEquals(SyncResultKind.CONFLICT, report.kind)
        assertEquals(postsBefore, server.requests.count { it == "POST marks" }) // no se envio nada
        assertEquals("absent", server.day!!.marks[s3]) // lo ajeno intacto
        assertEquals("present", server.day!!.marks[s1]) // nada se sobrescribio
        assertEquals(OperationState.CONFLICT.name, ops().filter { it.kind == "SAVE_MARKS" }.maxByOrNull { it.seq }!!.state)
        assertEquals(listOf(AttendanceMark.ABSENT, AttendanceMark.ABSENT, null), marks()) // la captura local sigue completa
        // el CONFLICT bloquea y no se limpia solo
        assertEquals(SyncResultKind.CONFLICT, engine(deviceA, server).run(group(deviceA))!!.kind)
        assertEquals(postsBefore, server.requests.count { it == "POST marks" })
    }

    @Test
    fun grupoRevocadoBloqueaElEnvioYConservaElBorrador() = runBlocking<Unit> {
        download()
        val draft = capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        assertTrue(repo(deviceA).prepareForSync(draft) is PrepareResult.Prepared)
        cache.commit(spec(deviceA, revoked = setOf(g1))) // el servidor ya no autoriza el grupo
        val report = engine(deviceA, server).run(group(deviceA))!!
        assertEquals(SyncResultKind.NEEDS_REVIEW, report.kind)
        assertTrue(server.requests.none { it.startsWith("POST") })
        assertTrue(ops().none { it.state == OperationState.ACKNOWLEDGED.name || it.state == OperationState.SENDING.name })
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT, null), marks()) // el borrador de un grupo revocado se conserva
    }

    @Test
    fun elServidorYaNoAsignaElGrupoHoySeBloqueaSinEnviar() = runBlocking<Unit> {
        download()
        capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        server.assigned = false
        assertEquals(SyncResultKind.NEEDS_REVIEW, engine(deviceA, server).run(group(deviceA))!!.kind)
        assertTrue(server.requests.none { it.startsWith("POST") })
        assertEquals(OperationState.NEEDS_REVIEW.name, state("SAVE_MARKS"))
    }

    @Test
    fun unaCapturaDeAyerNuncaSeEnviaPorElFlujoOrdinario() = runBlocking<Unit> {
        download()
        val draft = capture() // martes
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        assertTrue(repo(deviceA).prepareForSync(draft) is PrepareResult.Prepared) // sellada el martes
        clock.now = MutableClock.WEDNESDAY_AFTER_MIDNIGHT
        server.schoolToday = "2026-10-28"
        download(serverDate = "2026-10-28") // el servidor confirma el miercoles y el acceso sigue vigente
        val report = engine(deviceA, server).run(group(deviceA))!!
        assertEquals(SyncResultKind.NEEDS_REVIEW, report.kind)
        assertTrue(server.requests.none { it.startsWith("POST") })
        assertEquals(tuesday, ops().first { it.kind == "SAVE_MARKS" }.schoolDate) // la fecha NO se movio a hoy
        assertEquals(OperationState.NEEDS_REVIEW.name, state("SAVE_MARKS"))
        // el borrador de ayer se conserva completo (hoy ya es otro dia: se lee por su identificador)
        assertEquals(listOf("PRESENT", "ABSENT", null), db.draftDao().observeRows(draft).first().map { it.status })
    }

    @Test
    fun siElPadronDelServidorCambioNoSeEnviaYLasMarcasSeConservan() = runBlocking<Unit> {
        download()
        capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3, "54444444-0000-4000-8000-0000000000a4"))
        assertEquals(SyncResultKind.NEEDS_REVIEW, engine(deviceA, server).run(group(deviceA))!!.kind)
        assertTrue("ni se abrio la lista ni se enviaron marcas", server.requests.none { it.startsWith("POST") })
        assertNull("el servidor no tiene ninguna lista nueva", server.day)
        assertEquals(OperationState.NEEDS_REVIEW.name, state("SAVE_MARKS"))
        assertEquals(OperationState.NEEDS_REVIEW.name, state("OPEN"))
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT, null), marks())
    }

    @Test
    fun sesionExpiradaNoCambiaEstadosNiPierdeNada() = runBlocking<Unit> {
        download()
        capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        val sessions = RoomFakeSessions(ApiResult.Failure(401, "SESSION_ENDED"))
        assertEquals(SyncResultKind.SESSION_REQUIRED, engine(deviceA, server, sessions = sessions).run(group(deviceA))!!.kind)
        assertTrue(server.requests.isEmpty())
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT.name, state("SAVE_MARKS"))
        sessions.failure = null // al volver a autenticar, el mismo envio sigue pendiente
        assertEquals(SyncResultKind.CONFIRMED, engine(deviceA, server, sessions = sessions).run(group(deviceA))!!.kind)
    }

    // ---------------------------------------------------------------------------------------------------- identidad y aislamiento

    @Test
    fun dosPerfilesNoSeMezclanYUnaIdentidadAjenaNoPuedeSincronizar() = runBlocking<Unit> {
        download(deviceA)
        download(deviceB)
        capture(deviceA)
        capture(deviceB)
        val serverA = RoomFakeServer(g1, listOf(s1, s2, s3))
        // la identidad vinculada ahora es la del dispositivo B: el motor del perfil A se niega
        assertEquals(SyncResultKind.NOT_ALLOWED, engine(deviceA, serverA, identity = deviceB).run(group(deviceA))!!.kind)
        assertTrue(serverA.requests.isEmpty())
        // el ciclo de A solo toca lo de A
        assertEquals(SyncResultKind.CONFIRMED, engine(deviceA, serverA).run(group(deviceA))!!.kind)
        assertTrue(ops(deviceA).any { it.state == OperationState.ACKNOWLEDGED.name })
        assertTrue(ops(deviceB).none { it.state == OperationState.ACKNOWLEDGED.name })
        assertTrue(ops(deviceB).all { it.profileId == profile(deviceB) })
        assertEquals(setOf(ops(deviceA).single { it.kind == "SAVE_MARKS" }.requestId), serverA.savedRequestIds.toSet())
        // la demostracion no tiene outbox: un perfil que no es de un dispositivo vinculado no puede usar el transporte
        assertEquals(SyncResultKind.NOT_ALLOWED, ManualSyncEngine("demo", store(deviceA), serverA, RoomFakeSessions(), { deviceA }, pause = {}).run(group(deviceA))!!.kind)
    }

    // ---------------------------------------------------------------------------------------------- edicion local concurrente

    @Test
    fun editarMientrasSeEnviaConservaLoSelladoYRegistraOtraIntencion() = runBlocking<Unit> {
        download()
        val draft = capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        server.day = RoomFakeServer.Day(UUID.randomUUID().toString(), 1).also { }
        server.gate = CompletableDeferred()
        val job = async { engine(deviceA, server).run(group(deviceA)) }
        awaitSaveState(OperationState.SENDING)
        assertEquals(OperationState.SENDING.name, state("SAVE_MARKS"))
        val sealed = ops().single { it.kind == "SAVE_MARKS" }
        val payload = OutboxStore(db, clock).payloadOf(sealed.id)
        // la prefecta sigue capturando mientras la peticion esta en vuelo
        assertEquals(SetMarkResult.Saved, repo(deviceA).setMark(draft, student(deviceA, s3), AttendanceMark.PRESENT))
        server.gate!!.complete(Unit)
        assertEquals(SyncReport(SyncResultKind.CONFIRMED, 1), job.await())
        // lo enviado es EXACTAMENTE lo sellado; la edicion nueva queda como intencion sin enviar
        assertEquals(payload, OutboxStore(db, clock).payloadOf(sealed.id))
        assertEquals(mapOf(s1 to "present", s2 to "absent"), server.day!!.marks)
        val summary = repo(deviceA).observeOutbox(group(deviceA)).first()!!
        assertTrue(summary.unsealedChanges)
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT, AttendanceMark.PRESENT), marks())
    }

    @Test
    fun cancelarConPeticionEnVueloDejaResultadoDesconocidoYTodoPersistido() = runBlocking<Unit> {
        download()
        capture()
        val server = RoomFakeServer(g1, listOf(s1, s2, s3))
        server.day = RoomFakeServer.Day(UUID.randomUUID().toString(), 1)
        server.gate = CompletableDeferred()
        val job = async { engine(deviceA, server).run(group(deviceA)) }
        awaitSaveState(OperationState.SENDING)
        assertEquals(OperationState.SENDING.name, state("SAVE_MARKS"))
        job.cancel()
        runCatching { job.await() }
        assertEquals(OperationState.RETRYABLE_ERROR.name, state("SAVE_MARKS"))
        assertEquals(2, OutboxStore(db, clock).payloadOf(ops().single { it.kind == "SAVE_MARKS" }.id).size)
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT, null), marks())
        server.gate = null
        assertEquals(SyncResultKind.CONFIRMED, engine(deviceA, server).run(group(deviceA))!!.kind)
        assertEquals(1, server.day!!.events)
    }

    // ---------------------------------------------------------------------------------------------------------------- JSON del contrato

    @Test
    fun elJsonDelServidorSeLeeYElCuerpoDeGuardadoTieneElContratoDelPortal() {
        val day = """{"id":"d1","groupId":"g","schoolYearId":"y","attendanceDate":"2026-10-27","status":"draft","revision":3,"counts":{"total":2,"present":1,"absent":0,"pending":1},"finalizedAt":null}"""
        val today = AttendanceJson.today(org.json.JSONObject("""{"schoolToday":"2026-10-27","isSchoolDay":true,"serverTime":"x","groups":[{"groupId":"g","schoolYearId":"y","day":$day},{"groupId":"h","schoolYearId":"y","day":null}]}"""))
        assertEquals("2026-10-27", today.schoolToday)
        assertEquals(3, today.groups[0].day!!.revision)
        assertEquals(null, today.groups[1].day)
        val detail = """{"schoolToday":"2026-10-27","serverTime":"x","day":$day,"rosterDigest":"v1:ab","records":[{"studentId":"AAAAAAAA-0000-4000-8000-000000000001","status":"pending","markedAt":null}],"discrepancies":{"addedToRoster":0,"removedFromRoster":0}}"""
        val parsed = AttendanceJson.detail(org.json.JSONObject(detail))
        assertEquals("aaaaaaaa-0000-4000-8000-000000000001", parsed.records.single().studentId) // se normaliza
        val save = AttendanceJson.save(org.json.JSONObject("""{"day":$detail,"changed":1,"replayed":true}"""))
        assertTrue(save.replayed)
        val open = AttendanceJson.open(org.json.JSONObject("""{"day":$detail,"created":true}"""), created = true)
        assertTrue(open.created)
        val body = org.json.JSONObject(AttendanceJson.saveBody(4, "aaaaaaaa-0000-4000-8000-000000000009", listOf(WireMark(s1, "present"))))
        assertEquals(setOf("expectedRevision", "requestId", "marks"), body.keys().asSequence().toSet()) // sin campos ajenos (Zod estricto)
        assertEquals(4, body.getInt("expectedRevision"))
        assertEquals(setOf("studentId", "status"), body.getJSONArray("marks").getJSONObject(0).keys().asSequence().toSet())
        // una forma inesperada falla: jamas se "arregla" una respuesta
        var failed = false
        try {
            AttendanceJson.today(org.json.JSONObject("""{"schoolToday":"2026-10-27"}"""))
        } catch (_: org.json.JSONException) {
            failed = true
        }
        assertTrue(failed)
    }
}
