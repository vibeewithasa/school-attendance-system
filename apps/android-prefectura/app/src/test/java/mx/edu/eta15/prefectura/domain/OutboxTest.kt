package mx.edu.eta15.prefectura.domain

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Logica PURA de la outbox (sin Room): contrato canonico con el servidor, maquina de estados y planificador del sellado.
 * Fixtures sinteticos; identificadores en el formato del servidor (UUID en minuscula).
 */
class OutboxTest {
    private val a = "00000000-0000-4000-8000-00000000000a"
    private val b = "00000000-0000-4000-8000-00000000000b"
    private val c = "00000000-0000-4000-8000-00000000000c"
    private val today = LocalDate.of(2026, 10, 28)

    // ------------------------------------------------------------------------------------------------ contrato canonico

    @Test
    fun `la huella es identica a la que calcula el servidor (vectores del backend) y no depende del orden`() {
        // Calculados con `marksHash` del backend (apps/api/src/modules/attendance/attendance.service.ts).
        val three = listOf(WireMark(b, "absent"), WireMark(a, "present"), WireMark(c, "present"))
        assertEquals("4aebb039f6a3b174403df2fe4f3a1b1ffb2d5404ef2b406c4479eff72d209d21", OutboxCanonical.marksHash(three))
        assertEquals(OutboxCanonical.marksHash(three), OutboxCanonical.marksHash(three.reversed()))
        assertEquals("5143a2670871f58490d4b9c61f805ad459bd531c804084c49f1f79ae17b6d6f5", OutboxCanonical.marksHash(listOf(WireMark(a, "present"))))
    }

    @Test
    fun `otro contenido produce otra huella (estado distinto o alumno distinto)`() {
        val base = OutboxCanonical.marksHash(listOf(WireMark(a, "present"), WireMark(b, "absent")))
        assertNotEquals(base, OutboxCanonical.marksHash(listOf(WireMark(a, "absent"), WireMark(b, "absent"))))
        assertNotEquals(base, OutboxCanonical.marksHash(listOf(WireMark(a, "present"), WireMark(c, "absent"))))
        assertNotEquals(base, OutboxCanonical.marksHash(listOf(WireMark(a, "present"))))
    }

    @Test
    fun `studentId se normaliza a minusculas y solo se acepta un UUID`() {
        assertEquals(a, OutboxCanonical.normalizeStudentId(a.uppercase()))
        assertEquals(a, OutboxCanonical.normalizeStudentId(a))
        listOf(null, "", "no-es-uuid", a.dropLast(1), "$a ", "sbx.dispositivo.$a").forEach { assertNull(it, OutboxCanonical.normalizeStudentId(it)) }
    }

    @Test
    fun `Pendiente no es un estado del servidor`() {
        assertEquals("present", WireMark.statusOf(AttendanceMark.PRESENT))
        assertEquals("absent", WireMark.statusOf(AttendanceMark.ABSENT))
        assertNull(WireMark.markOf("pending"))
        assertNull(WireMark.markOf(""))
    }

    // ------------------------------------------------------------------------------------------- maquina de estados

    @Test
    fun `los estados terminales no tienen salida y el resto tiene al menos una`() {
        OperationState.entries.forEach { s ->
            val tos = OutboxTransitions.ALLOWED.getValue(s)
            if (s.isTerminal) assertTrue("$s es terminal", tos.isEmpty()) else assertTrue("$s tiene salida", tos.isNotEmpty())
        }
        assertEquals(setOf(OperationState.ACKNOWLEDGED, OperationState.SUPERSEDED, OperationState.DISCARDED), OperationState.entries.filter { it.isTerminal }.toSet())
    }

    @Test
    fun `transiciones validas del ciclo normal`() {
        val path = listOf(
            OperationState.LOCAL_ONLY, OperationState.WAITING_REMOTE_CONTEXT, OperationState.READY, OperationState.SENDING,
            OperationState.ACKNOWLEDGED,
        )
        path.zipWithNext().forEach { (from, to) -> assertTrue("$from -> $to", from.canTransitionTo(to)) }
        assertTrue(OperationState.SENDING.canTransitionTo(OperationState.RETRYABLE_ERROR))
        assertTrue(OperationState.RETRYABLE_ERROR.canTransitionTo(OperationState.SENDING))
        assertTrue(OperationState.READY.canTransitionTo(OperationState.AUTH_REQUIRED))
        assertTrue(OperationState.CONFLICT.canTransitionTo(OperationState.READY))
    }

    @Test
    fun `transiciones invalidas`() {
        val invalid = listOf(
            OperationState.LOCAL_ONLY to OperationState.SENDING,
            OperationState.LOCAL_ONLY to OperationState.ACKNOWLEDGED,
            OperationState.WAITING_REMOTE_CONTEXT to OperationState.SENDING,
            OperationState.WAITING_REMOTE_CONTEXT to OperationState.ACKNOWLEDGED,
            OperationState.READY to OperationState.ACKNOWLEDGED,
            OperationState.SENDING to OperationState.READY,
            OperationState.SENDING to OperationState.DISCARDED, // pudo haber llegado: no se descarta
            OperationState.SENDING to OperationState.SUPERSEDED,
            OperationState.RETRYABLE_ERROR to OperationState.DISCARDED, // resultado desconocido
            OperationState.ACKNOWLEDGED to OperationState.READY,
            OperationState.SUPERSEDED to OperationState.READY,
            OperationState.DISCARDED to OperationState.READY,
        )
        invalid.forEach { (from, to) -> assertFalse("$from -> $to no debe permitirse", from.canTransitionTo(to)) }
    }

    @Test
    fun `lo que pudo llegar al servidor y lo que no se distinguen`() {
        assertTrue(OperationState.SENDING.mayHaveReachedServer && OperationState.RETRYABLE_ERROR.mayHaveReachedServer)
        assertFalse(OperationState.READY.mayHaveReachedServer || OperationState.WAITING_REMOTE_CONTEXT.mayHaveReachedServer)
        assertTrue(OperationState.READY.isUnsent && OperationState.NEEDS_REVIEW.isUnsent)
        assertFalse(OperationState.SENDING.isUnsent)
    }

    // ---------------------------------------------------------------------------------------------------- planificador

    private fun input(
        marks: List<PlanMark> = listOf(PlanMark(a, AttendanceMark.PRESENT, true), PlanMark(b, AttendanceMark.ABSENT, true)),
        prior: List<PriorOperation> = emptyList(),
        sandbox: Boolean = true,
        revoked: Boolean = false,
        draftDate: LocalDate = today,
        confirmed: Boolean = true,
        needsReview: Boolean = false,
        reason: String? = null,
    ) = SealInput(sandbox, revoked, draftDate, today, confirmed, needsReview, reason, marks, prior)

    private fun seal(i: SealInput) = (OutboxPlanner.plan(i) as PlanOutcome.Seal).plan

    @Test
    fun `se sella con payload completo, huella y orden canonico`() {
        val plan = seal(input(marks = listOf(PlanMark(b.uppercase(), AttendanceMark.ABSENT, true), PlanMark(a, AttendanceMark.PRESENT, true))))
        assertEquals(listOf(WireMark(a, "present"), WireMark(b, "absent")), plan.wire)
        assertEquals(OutboxCanonical.marksHash(plan.wire), plan.hash)
    }

    @Test
    fun `sin contexto remoto la operacion espera y no queda READY ni lleva dayId ni revision inventados`() {
        val plan = seal(input())
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, plan.state)
        assertEquals(OutboxReasons.WAITING_OPEN, plan.reason)
        assertNull(plan.serverDayId)
        assertNull(plan.expectedRevision)
        assertEquals(OperationState.READY, plan.openState) // OPEN solo necesita grupo y fecha: ya esta completa
        assertNull(plan.dependsOnId) // depende de la OPEN por crear
    }

    @Test
    fun `fecha sin confirmar - ni OPEN ni marcas quedan listas`() {
        val plan = seal(input(confirmed = false))
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, plan.state)
        assertEquals(OutboxReasons.DATE_UNCONFIRMED, plan.reason)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, plan.openState)
        assertEquals(DateProvenance.DEVICE_UNCONFIRMED, plan.provenance)
    }

    @Test
    fun `una captura de otro dia no se prepara como READY - se conserva en revision`() {
        val plan = seal(input(draftDate = today.minusDays(1)))
        assertEquals(OperationState.NEEDS_REVIEW, plan.state)
        assertEquals(OutboxReasons.DATE_HISTORIC, plan.reason)
        assertEquals(OperationState.NEEDS_REVIEW, plan.openState)
        // ni siquiera con la fecha confirmada se vuelve "de hoy"
        assertEquals(OperationState.NEEDS_REVIEW, seal(input(draftDate = today.minusDays(1), confirmed = true)).state)
    }

    @Test
    fun `padron cambiado o alumno inactivo - revision, sin modificar el payload`() {
        val changed = seal(input(needsReview = true, reason = OutboxReasons.ROSTER_CHANGED))
        assertEquals(OperationState.NEEDS_REVIEW, changed.state)
        assertEquals(OutboxReasons.ROSTER_CHANGED, changed.reason)
        assertEquals(2, changed.wire.size)
        val inactive = seal(input(marks = listOf(PlanMark(a, AttendanceMark.PRESENT, false), PlanMark(b, AttendanceMark.ABSENT, true))))
        assertEquals(OperationState.NEEDS_REVIEW, inactive.state)
        assertEquals(OutboxReasons.STUDENT_INACTIVE, inactive.reason)
    }

    @Test
    fun `rechazos locales`() {
        assertEquals(Refusal.NotSandbox, (OutboxPlanner.plan(input(sandbox = false)) as PlanOutcome.Refuse).refusal)
        assertEquals(Refusal.GroupRevoked, (OutboxPlanner.plan(input(revoked = true)) as PlanOutcome.Refuse).refusal)
        assertEquals(Refusal.NothingToPrepare, (OutboxPlanner.plan(input(marks = emptyList())) as PlanOutcome.Refuse).refusal)
        val many = (0 until 201).map { PlanMark("00000000-0000-4000-8000-%012x".format(it), AttendanceMark.PRESENT, true) }
        assertEquals(Refusal.TooManyMarks(201), (OutboxPlanner.plan(input(marks = many)) as PlanOutcome.Refuse).refusal)
        val bad = listOf(PlanMark("sbx.dispositivo.alumno", AttendanceMark.PRESENT, true), PlanMark(a, AttendanceMark.PRESENT, true))
        assertEquals(Refusal.InvalidIdentifier(1), (OutboxPlanner.plan(input(marks = bad)) as PlanOutcome.Refuse).refusal)
    }

    private fun sealed(id: String, state: OperationState, seq: Int, marks: Map<String, String>, dayId: String? = null, rev: Int? = null) =
        PriorOperation(id, OperationKind.SAVE_MARKS, state, seq, marks, dayId, rev)

    @Test
    fun `preparar dos veces sin cambios no crea otra operacion ni otro requestId`() {
        val prior = listOf(sealed("op1", OperationState.WAITING_REMOTE_CONTEXT, 2, mapOf(a to "present", b to "absent")))
        val outcome = OutboxPlanner.plan(input(prior = prior))
        assertEquals(PlanOutcome.AlreadyPrepared("op1"), outcome)
    }

    @Test
    fun `una edicion posterior conserva la operacion sellada, la reemplaza si no se envio y no reutiliza su identidad`() {
        val prior = listOf(sealed("op1", OperationState.WAITING_REMOTE_CONTEXT, 2, mapOf(a to "present", b to "absent")))
        val plan = seal(input(prior = prior, marks = listOf(PlanMark(a, AttendanceMark.ABSENT, true), PlanMark(b, AttendanceMark.ABSENT, true))))
        assertEquals(listOf("op1"), plan.supersede) // se CONSERVA como SUPERSEDED (la fila no se borra)
        assertNotEquals(OutboxCanonical.marksHash(listOf(WireMark(a, "present"), WireMark(b, "absent"))), plan.hash)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, plan.state) // nunca una segunda READY con revision obsoleta
    }

    @Test
    fun `una operacion posiblemente enviada no se reemplaza - la nueva depende de ella y espera`() {
        val prior = listOf(sealed("op1", OperationState.RETRYABLE_ERROR, 2, mapOf(a to "present", b to "absent")))
        val plan = seal(input(prior = prior, marks = listOf(PlanMark(a, AttendanceMark.ABSENT, true), PlanMark(b, AttendanceMark.ABSENT, true))))
        assertTrue(plan.supersede.isEmpty())
        assertEquals("op1", plan.dependsOnId)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, plan.state)
        assertEquals(OutboxReasons.WAITING_PREVIOUS, plan.reason)
    }

    @Test
    fun `tras una confirmacion del servidor la siguiente hereda el contexto (dayId y revision) sin inventarlo`() {
        val prior = listOf(sealed("op1", OperationState.ACKNOWLEDGED, 2, mapOf(a to "present", b to "absent"), dayId = "dia-1", rev = 3))
        val plan = seal(input(prior = prior, marks = listOf(PlanMark(a, AttendanceMark.ABSENT, true), PlanMark(b, AttendanceMark.ABSENT, true))))
        assertEquals(OperationState.READY, plan.state)
        assertEquals("dia-1", plan.serverDayId)
        assertEquals(3, plan.expectedRevision)
        assertEquals("op1", plan.dependsOnId)
    }

    @Test
    fun `Pendiente no se convierte en una orden de borrar una marca que el servidor pudo recibir`() {
        val prior = listOf(sealed("op1", OperationState.ACKNOWLEDGED, 2, mapOf(a to "present", b to "absent"), "dia-1", 3))
        // la persona dejo a `b` Pendiente (ya no hay marca explicita): no hay forma de expresarlo hacia el servidor
        val outcome = OutboxPlanner.plan(input(prior = prior, marks = listOf(PlanMark(a, AttendanceMark.PRESENT, true), PlanMark(c, AttendanceMark.PRESENT, true))))
        assertEquals(Refusal.UnmarkAfterSend(1), (outcome as PlanOutcome.Refuse).refusal)
        // en cambio, si la operacion NUNCA salio, no hay conflicto: se reemplaza
        val unsent = listOf(sealed("op1", OperationState.READY, 2, mapOf(a to "present", b to "absent")))
        assertTrue(OutboxPlanner.plan(input(prior = unsent, marks = listOf(PlanMark(a, AttendanceMark.PRESENT, true), PlanMark(c, AttendanceMark.PRESENT, true)))) is PlanOutcome.Seal)
    }

    @Test
    fun `cambios sin preparar se detectan comparando con lo ultimo sellado vigente`() {
        val local = mapOf(a to "present")
        assertTrue(OutboxPlanner.isDirty(local, null))
        assertFalse(OutboxPlanner.isDirty(emptyMap(), null))
        assertFalse(OutboxPlanner.isDirty(local, mapOf(a to "present")))
        assertTrue(OutboxPlanner.isDirty(local, mapOf(a to "absent")))
        assertTrue(OutboxPlanner.isDirty(emptyMap(), mapOf(a to "present")))
        val prior = listOf(
            sealed("viejo", OperationState.SUPERSEDED, 2, mapOf(a to "absent")),
            sealed("actual", OperationState.READY, 3, mapOf(a to "present")),
            PriorOperation("open", OperationKind.OPEN, OperationState.READY, 1, null),
        )
        assertEquals("actual", OutboxPlanner.latestActiveSealed(prior)?.id)
    }

    @Test
    fun `la identidad de la operacion no depende del contexto remoto`() {
        val withoutContext = seal(input())
        val withContext = seal(
            input(prior = listOf(sealed("op0", OperationState.ACKNOWLEDGED, 1, mapOf(a to "absent", b to "absent"), "dia-9", 7))),
        )
        // mismo payload logico => misma huella, con o sin dayId / revision
        assertEquals(withoutContext.hash, withContext.hash)
        assertNull(withoutContext.expectedRevision)
        assertEquals(7, withContext.expectedRevision)
    }
}
