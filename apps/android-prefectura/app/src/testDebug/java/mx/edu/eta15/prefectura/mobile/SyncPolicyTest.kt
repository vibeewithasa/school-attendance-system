package mx.edu.eta15.prefectura.mobile

import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxReasons
import mx.edu.eta15.prefectura.domain.WireMark
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val P_GROUP = "11111111-0000-4000-8000-0000000000a1"
private const val P_DAY = "22222222-0000-4000-8000-0000000000d1"
private const val A = "51111111-0000-4000-8000-0000000000a1"
private const val B = "52222222-0000-4000-8000-0000000000a2"
private const val C = "53333333-0000-4000-8000-0000000000a3"
private val ROSTER = setOf(A, B, C)
private val PNOW: Instant = Instant.parse("2026-10-27T18:00:00Z")

private fun op(requestId: String? = "aaaaaaaa-0000-4000-8000-000000000001", dayId: String? = P_DAY, revision: Int? = 1, date: String = "2026-10-27") = SyncOp(
    "op-1", OperationKind.SAVE_MARKS, OperationState.READY, 1, "g", P_GROUP, "d", date, requestId, dayId, revision, "open-1", null, 2, 0,
)

private fun detail(
    revision: Int = 1,
    status: String = "draft",
    date: String = "2026-10-27",
    group: String = P_GROUP,
    ids: Set<String> = ROSTER,
    marks: Map<String, String> = emptyMap(),
    digest: String = SyncPolicy.rosterDigestV1(ids),
) = SrvDetail("2026-10-27", SrvDay(P_DAY, group, date, status, revision), digest, ids.map { SrvRecord(it, marks[it] ?: "pending") })

class SyncPolicyTest {
    private val payload = listOf(WireMark(A, "present"), WireMark(B, "absent"))

    private fun validate(d: SrvDetail, known: Int? = 1, acked: Set<String> = emptySet(), roster: Set<String> = ROSTER, today: String = "2026-10-27", o: SyncOp = op()) =
        SyncPolicy.validateBeforeSend(o, payload, d, today, roster, acked, known)

    // ------------------------------------------------------------------------------------------------ padron

    @Test
    fun `la huella v1 del padron es la del backend e ignora el orden y las mayusculas`() {
        val expected = "v1:4d139808ce47b9d33f56a879f2adffc6a898746b534605e5f61ebb2cf7e3a9b8"
        assertEquals(expected, SyncPolicy.rosterDigestV1(listOf(C, A, B)))
        assertEquals(expected, SyncPolicy.rosterDigestV1(listOf(A.uppercase(), B, C)))
        assertEquals("v1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", SyncPolicy.rosterDigestV1(emptyList()))
    }

    // ------------------------------------------------------------------------------------------------ validacion previa

    @Test
    fun `todo coincide y se envia`() {
        assertEquals(Verdict.Proceed, validate(detail()))
    }

    @Test
    fun `otra fecha o otro grupo van a revision`() {
        assertEquals(Verdict.Review(OutboxReasons.DATE_MISMATCH), validate(detail(date = "2026-10-26")))
        assertEquals(Verdict.Review(OutboxReasons.DATE_MISMATCH), validate(detail(), today = "2026-10-28"))
        assertEquals(Verdict.Review(OutboxReasons.DATE_MISMATCH), validate(detail(), o = op(date = "2026-10-26")))
        assertEquals(Verdict.Review(OutboxReasons.INVALID_REQUEST), validate(detail(group = "99999999-0000-4000-8000-000000000009")))
    }

    @Test
    fun `lista finalizada es conflicto`() {
        assertEquals(Verdict.Conflict(OutboxReasons.DAY_FINALIZED), validate(detail(status = "finalized")))
    }

    @Test
    fun `padron distinto en cualquier sentido va a revision`() {
        val extra = "54444444-0000-4000-8000-0000000000a4"
        assertEquals(Verdict.Review(OutboxReasons.ROSTER_CHANGED), validate(detail(ids = ROSTER + extra)))
        assertEquals(Verdict.Review(OutboxReasons.ROSTER_CHANGED), validate(detail(ids = setOf(A, B))))
        assertEquals(Verdict.Review(OutboxReasons.ROSTER_CHANGED), validate(detail(), roster = setOf(A, B, extra)))
        // una huella que no corresponde al padron del propio servidor tambien se rechaza (respuesta incoherente)
        assertEquals(Verdict.Review(OutboxReasons.ROSTER_CHANGED), validate(detail(digest = "v1:00")))
    }

    @Test
    fun `la revision distinta de la confirmada por este dispositivo es conflicto`() {
        assertEquals(Verdict.Conflict(OutboxReasons.REVISION_CHANGED), validate(detail(revision = 3), known = 2))
        assertEquals(Verdict.Proceed, validate(detail(revision = 2), known = 2))
    }

    @Test
    fun `una marca de otra persona distinta es conflicto salvo que este dispositivo ya la haya escrito`() {
        val others = detail(revision = 4, marks = mapOf(A to "absent"))
        assertEquals(Verdict.Conflict(OutboxReasons.DIVERGENT_MARKS), validate(others, known = 4))
        assertEquals(Verdict.Proceed, validate(others, known = 4, acked = setOf(A))) // la escribimos nosotros antes
        assertEquals(Verdict.Proceed, validate(detail(revision = 4, marks = mapOf(A to "present")), known = 4)) // ya coincide
        assertEquals(Verdict.Proceed, validate(detail(revision = 4, marks = mapOf(C to "absent")), known = 4)) // alumno que no enviamos
    }

    // ------------------------------------------------------------------------------------------------ recibo

    private fun save(revision: Int = 2, changed: Int = 2, replayed: Boolean = false, marks: Map<String, String> = mapOf(A to "present", B to "absent"), dayId: String = P_DAY, date: String = "2026-10-27") =
        SrvSave(
            SrvDetail("2026-10-27", SrvDay(dayId, P_GROUP, date, "draft", revision), SyncPolicy.rosterDigestV1(ROSTER), ROSTER.map { SrvRecord(it, marks[it] ?: "pending") }),
            changed, replayed,
        )

    @Test
    fun `un recibo correcto se acepta`() {
        assertNull(SyncPolicy.verifyReceipt(op(), payload, save()))
        assertNull(SyncPolicy.verifyReceipt(op(), payload, save(revision = 5, changed = 0, replayed = true, marks = mapOf(A to "absent")))) // otra persona cambio despues
    }

    @Test
    fun `un recibo que no corresponde se rechaza`() {
        assertEquals(OutboxReasons.ACK_MISMATCH, SyncPolicy.verifyReceipt(op(), payload, save(dayId = "99999999-0000-4000-8000-000000000009")))
        assertEquals(OutboxReasons.ACK_MISMATCH, SyncPolicy.verifyReceipt(op(), payload, save(date = "2026-10-26")))
        assertEquals(OutboxReasons.ACK_MISMATCH, SyncPolicy.verifyReceipt(op(), payload, save(changed = 9)))
        assertEquals(OutboxReasons.ACK_MISMATCH, SyncPolicy.verifyReceipt(op(), payload, save(revision = 0)))
        assertEquals(OutboxReasons.ACK_MISMATCH, SyncPolicy.verifyReceipt(op(), payload, save(marks = mapOf(A to "absent", B to "absent")))) // marca distinta a la enviada
        assertEquals(OutboxReasons.ACK_MISMATCH, SyncPolicy.verifyReceipt(op(revision = null), payload, save()))
    }

    // ------------------------------------------------------------------------------------------------ errores

    private fun classify(status: Int, code: String? = null, retryAfter: Int? = null, attempt: Int = 0) =
        SyncPolicy.classify(ApiResult.Failure(status, code, retryAfter), attempt)

    @Test
    fun `cada codigo del backend tiene un tratamiento explicito`() {
        assertEquals(Reaction.Unknown, classify(0))
        assertEquals(Reaction.Unknown, classify(200, "BAD_RESPONSE"))
        assertEquals(Reaction.Auth, classify(401, "SESSION_ENDED"))
        assertEquals(Reaction.AuthBlocked("DEVICE_REVOKED"), classify(403, "DEVICE_REVOKED"))
        assertEquals(Reaction.AuthBlocked("NOT_ELIGIBLE"), classify(403, "NOT_ELIGIBLE"))
        assertEquals(Reaction.Review(OutboxReasons.FORBIDDEN), classify(403, "FORBIDDEN"))
        assertEquals(Reaction.Review(OutboxReasons.NOT_FOUND), classify(404, "NOT_FOUND"))
        assertEquals(Reaction.Conflict(OutboxReasons.REVISION_CHANGED), classify(409, "REVISION_CONFLICT"))
        assertEquals(Reaction.Conflict(OutboxReasons.DAY_FINALIZED), classify(409, "DAY_FINALIZED"))
        assertEquals(Reaction.Review(OutboxReasons.IDEMPOTENCY_MISMATCH), classify(409, "IDEMPOTENCY_MISMATCH"))
        assertEquals(Reaction.Review(OutboxReasons.NOT_SCHOOL_DAY), classify(409, "NOT_SCHOOL_DAY"))
        assertEquals(Reaction.Review(OutboxReasons.DATE_MISMATCH), classify(409, "DAY_NOT_CURRENT"))
        assertEquals(Reaction.Review(OutboxReasons.DATE_MISMATCH), classify(400, "DATE_NOT_TODAY"))
        assertEquals(Reaction.Review(OutboxReasons.ROSTER_CHANGED), classify(400, "STUDENT_NOT_IN_LIST"))
        assertEquals(Reaction.Review(OutboxReasons.INVALID_REQUEST), classify(400, "VALIDATION_ERROR"))
        assertEquals(Reaction.Review(OutboxReasons.GROUP_NOT_ASSIGNED), classify(409, "GROUP_INACTIVE"))
        assertEquals(Reaction.Review(OutboxReasons.INVALID_REQUEST), classify(409, "ALGO_NUEVO"))
    }

    @Test
    fun `solo los errores temporales se reintentan y de forma acotada`() {
        assertEquals(Reaction.Retry(3_000, OutboxReasons.RATE_LIMITED), classify(429, "RATE_LIMITED", 3))
        assertEquals(Reaction.Retry(10_000, OutboxReasons.RATE_LIMITED), classify(429, "RATE_LIMITED", 3_600)) // tope
        assertEquals(Reaction.Retry(1_000, OutboxReasons.RATE_LIMITED), classify(429, "RATE_LIMITED", 0)) // piso
        assertEquals(Reaction.Retry(1_000, OutboxReasons.UNAVAILABLE), classify(503, "DATABASE_UNAVAILABLE", attempt = 0))
        assertEquals(Reaction.Retry(2_000, OutboxReasons.UNAVAILABLE), classify(503, "DATABASE_UNAVAILABLE", attempt = 1))
        assertEquals(Reaction.Retry(8_000, OutboxReasons.UNAVAILABLE), classify(500, null, attempt = 9)) // nunca crece sin limite
        assertEquals(Reaction.Retry(1_000, OutboxReasons.UNAVAILABLE), classify(409, "CONCURRENT"))
        assertTrue(SyncPolicy.MAX_RETRIES in 1..3)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceSyncSessionsTest {
    private class ScriptedApi : MobileApi {
        var opens = 0
        var renews = 0
        var closes = 0
        var renewResult: ApiResult<MobileSession>? = null
        private fun session(n: Int) = MobileSession("acceso-$n", "renov-$n", PNOW.plusSeconds(300), PNOW.plusSeconds(3600), PNOW.plusSeconds(28_800), "dev")

        override suspend fun enroll(jwk: EcJwk, label: String) = error("no")
        override suspend fun enrollStatus(requestId: String) = error("no")
        override suspend fun activate(requestId: String) = error("no")
        override suspend fun openSession(): ApiResult<MobileSession> = ApiResult.Ok(session(++opens))
        override suspend fun renew(session: MobileSession): ApiResult<MobileSession> = renewResult ?: ApiResult.Ok(session(100 + ++renews))
        override suspend fun closeSession(session: MobileSession): ApiResult<Unit> {
            closes++
            return ApiResult.Ok(Unit)
        }
        override suspend fun myGroups(session: MobileSession) = error("no")
        override suspend fun roster(session: MobileSession, groupId: String) = error("no")
    }

    private val clock = java.time.Clock.fixed(PNOW, java.time.ZoneOffset.UTC)

    @Test
    fun `abre una sesion por ciclo y la cierra`() = runTest {
        val api = ScriptedApi()
        val sessions = DeviceSyncSessions(api, clock)
        var tokens = mutableListOf<String>()
        sessions.authed { tokens += it.accessToken; ApiResult.Ok(1) }
        sessions.authed { tokens += it.accessToken; ApiResult.Ok(2) }
        assertEquals(listOf("acceso-1", "acceso-1"), tokens)
        assertEquals(1, api.opens)
        sessions.close()
        assertEquals(1, api.closes)
        sessions.close()
        assertEquals(1, api.closes) // ya cerrada
    }

    @Test
    fun `un token vencido se renueva UNA vez y se reintenta UNA vez`() = runTest {
        val api = ScriptedApi()
        val sessions = DeviceSyncSessions(api, clock)
        var calls = 0
        val result = sessions.authed<Int> { calls++; if (calls == 1) ApiResult.Failure(401, "TOKEN_EXPIRED") else ApiResult.Ok(7) }
        assertEquals(ApiResult.Ok(7), result)
        assertEquals(2, calls)
        assertEquals(1, api.renews)
    }

    @Test
    fun `si sigue vencido no hay bucle`() = runTest {
        val api = ScriptedApi()
        val sessions = DeviceSyncSessions(api, clock)
        var calls = 0
        val result = sessions.authed<Int> { calls++; ApiResult.Failure(401, "TOKEN_EXPIRED") }
        assertTrue(result is ApiResult.Failure)
        assertEquals(2, calls)
        assertEquals(1, api.renews)
    }

    @Test
    fun `si la renovacion falla se abre una sesion nueva una sola vez y se reintenta una vez`() = runTest {
        val api = ScriptedApi()
        api.renewResult = ApiResult.Failure(401, "SESSION_ENDED")
        val sessions = DeviceSyncSessions(api, clock)
        var calls = 0
        sessions.authed<Int> { calls++; ApiResult.Failure(401, "TOKEN_EXPIRED") }
        assertEquals(2, calls)
        assertEquals(2, api.opens) // la inicial y la de recuperacion; nunca mas
    }
}
