package mx.edu.eta15.prefectura.domain

import java.time.Clock
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId

/**
 * Fecha escolar de DEMOSTRACION. El reloj del dispositivo NO es una autoridad escolar: la fecha real de una lista
 * siempre la decidira el servidor (America/Mazatlan, lunes a viernes). Aqui solo se replica la regla para que la demo
 * se comporte igual (no abre listas nuevas en sabado ni domingo) y se muestra como fecha de demostracion.
 */
object SchoolCalendar {
    val ZONE: ZoneId = ZoneId.of("America/Mazatlan")

    fun today(clock: Clock): LocalDate = LocalDate.now(clock.withZone(ZONE))

    fun isSchoolDay(date: LocalDate): Boolean =
        date.dayOfWeek != DayOfWeek.SATURDAY && date.dayOfWeek != DayOfWeek.SUNDAY
}
