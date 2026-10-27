package mx.edu.eta15.prefectura

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicInteger
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.local.GroupEntity
import mx.edu.eta15.prefectura.data.local.ProfileEntity
import mx.edu.eta15.prefectura.data.local.StudentEntity
import mx.edu.eta15.prefectura.domain.IdGenerator

/** Reloj controlable. Por omision: martes 27 de octubre de 2026, 11:00 en Mazatlan (18:00 UTC). */
class MutableClock(var now: Instant = TUESDAY) : Clock() {
    override fun getZone(): ZoneId = ZoneOffset.UTC

    override fun withZone(zone: ZoneId): Clock = Fixed(this, zone)

    override fun instant(): Instant = now

    private class Fixed(private val base: MutableClock, private val zone: ZoneId) : Clock() {
        override fun getZone(): ZoneId = zone

        override fun withZone(zone: ZoneId): Clock = Fixed(base, zone)

        override fun instant(): Instant = base.now
    }

    companion object {
        val TUESDAY: Instant = Instant.parse("2026-10-27T18:00:00Z")
        val SATURDAY: Instant = Instant.parse("2026-10-31T18:00:00Z")
        /** 01:00 del miercoles en Mazatlan (ya cruzo la medianoche respecto al martes). */
        val WEDNESDAY_AFTER_MIDNIGHT: Instant = Instant.parse("2026-10-28T08:00:00Z")
    }
}

/** Identificadores predecibles para las pruebas: id-1, id-2, ... */
class SequentialIds(prefix: String = "id") : IdGenerator {
    private val n = AtomicInteger()
    private val p = prefix

    override fun newId(): String = "$p-${n.incrementAndGet()}"
}

fun testContext(): Context = ApplicationProvider.getApplicationContext()

data class SeededGroup(val id: String, val studentIds: List<String>)

/** Carga datos 100 % ficticios en la base de PRUEBAS (en memoria). */
suspend fun EtaDatabase.seedProfile(
    profileId: String,
    studentsPerGroup: List<Int>,
    prefix: String = profileId,
): List<SeededGroup> {
    val catalog = catalogDao()
    catalog.insertProfile(ProfileEntity(profileId, "Perfil ficticio $profileId", isDemo = true))
    return studentsPerGroup.mapIndexed { index, count ->
        val groupId = "$prefix-g${index + 1}"
        catalog.insertGroups(listOf(GroupEntity(groupId, profileId, "Grupo ${index + 1}", 1, index)))
        val students = (1..count).map { n ->
            StudentEntity("$groupId-s$n", groupId, "Alumno %02d".format(n), "Ficticio $prefix")
        }
        catalog.insertStudents(students)
        SeededGroup(groupId, students.map { it.id })
    }
}
