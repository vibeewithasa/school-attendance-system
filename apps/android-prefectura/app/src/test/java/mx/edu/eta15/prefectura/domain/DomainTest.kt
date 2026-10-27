package mx.edu.eta15.prefectura.domain

import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SchoolCalendarTest {
    private fun clockAt(instant: String): Clock = Clock.fixed(Instant.parse(instant), ZoneOffset.UTC)

    @Test
    fun `la zona escolar es America Mazatlan`() {
        assertEquals("America/Mazatlan", SchoolCalendar.ZONE.id)
    }

    @Test
    fun `la fecha escolar sigue Mazatlan (UTC-7) y no el reloj UTC`() {
        // 06:59 UTC del martes 27 = 23:59 del lunes 26 en Mazatlan.
        assertEquals(LocalDate.of(2026, 10, 26), SchoolCalendar.today(clockAt("2026-10-27T06:59:59Z")))
        // 07:00 UTC = 00:00 del martes 27 en Mazatlan.
        assertEquals(LocalDate.of(2026, 10, 27), SchoolCalendar.today(clockAt("2026-10-27T07:00:00Z")))
    }

    @Test
    fun `lunes a viernes son dias de clase y sabado y domingo no`() {
        val monday = LocalDate.of(2026, 10, 26)
        (0..4).forEach { assertTrue(SchoolCalendar.isSchoolDay(monday.plusDays(it.toLong()))) }
        assertFalse(SchoolCalendar.isSchoolDay(LocalDate.of(2026, 10, 31))) // sabado
        assertFalse(SchoolCalendar.isSchoolDay(LocalDate.of(2026, 11, 1))) // domingo
    }

    @Test
    fun `el sabado en UTC puede seguir siendo viernes escolar`() {
        // 2026-10-31 03:00 UTC = viernes 30 a las 20:00 en Mazatlan.
        val date = SchoolCalendar.today(clockAt("2026-10-31T03:00:00Z"))
        assertEquals(LocalDate.of(2026, 10, 30), date)
        assertTrue(SchoolCalendar.isSchoolDay(date))
    }
}

class DraftModelTest {
    private fun row(id: String, mark: AttendanceMark?) = CaptureRow(Student(id, "Alumno $id", "Ficticio"), mark)

    private fun draft(vararg marks: AttendanceMark?) = DraftState(
        draftId = "d1",
        groupId = "g1",
        groupName = "1° A",
        schoolDate = LocalDate.of(2026, 10, 27),
        requestId = "r1",
        rows = marks.mapIndexed { i, m -> row("s$i", m) },
        updatedAt = Instant.EPOCH,
    )

    @Test
    fun `solo Presente y Ausente son valores definitivos de marca`() {
        assertEquals(setOf("PRESENT", "ABSENT"), AttendanceMark.entries.map { it.name }.toSet())
    }

    @Test
    fun `el resumen cuenta presentes ausentes y pendientes`() {
        val s = draft(AttendanceMark.PRESENT, AttendanceMark.ABSENT, null, AttendanceMark.PRESENT).summary
        assertEquals(DraftSummary(present = 2, absent = 1, pending = 1), s)
        assertEquals(4, s.total)
        assertEquals(3, s.marked)
        assertEquals(0.75f, s.progress, 0.0001f)
        assertFalse(s.isComplete)
    }

    @Test
    fun `un borrador sin pendientes esta completo y uno vacio no`() {
        assertTrue(draft(AttendanceMark.PRESENT, AttendanceMark.ABSENT).summary.isComplete)
        assertFalse(draft().summary.isComplete)
        assertEquals(0f, draft().summary.progress, 0f)
    }

    @Test
    fun `los identificadores aleatorios no se repiten`() {
        val ids = (1..500).map { IdGenerator.Random.newId() }
        assertEquals(500, ids.toSet().size)
        assertNotEquals(ids[0], ids[1])
    }

    @Test
    fun `la fuente remota futura declara que no hay sincronizacion`() {
        assertEquals(SyncStatus.NotImplemented, UnavailableRemoteDataSource.status)
    }
}
