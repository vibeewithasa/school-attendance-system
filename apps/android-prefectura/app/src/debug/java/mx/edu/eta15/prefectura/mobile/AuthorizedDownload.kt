package mx.edu.eta15.prefectura.mobile

import mx.edu.eta15.prefectura.data.DownloadedGroup
import mx.edu.eta15.prefectura.data.DownloadedStudent

/**
 * SOLO debug. Validacion de lo que el servidor de PRUEBAS devuelve ANTES de tocar la cache cifrada. Una respuesta que no cumple
 * se rechaza completa: jamas se guarda una descarga parcial ni se "arregla" en silencio.
 *
 * Reglas: identificadores con forma de UUID, sin duplicados (grupos ni alumnos), un padron cuyo grupo es el que se pidio, fecha
 * escolar valida, tamanos acotados, nombres sin caracteres de control y solo los campos MINIMOS de asistencia (id y nombres).
 */
object ResponseValidator {
    const val MAX_GROUPS = 50
    const val MAX_STUDENTS = 1000
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val CONTROL = Regex("[\\u0000-\\u001F\\u007F]")

    private fun clean(text: String, max: Int): Boolean = text.isNotBlank() && text.length <= max && !CONTROL.containsMatchIn(text)

    /** Devuelve `null` si la lista de grupos no es valida. La fecha escolar `asOf` debe venir en todos los grupos y ser la misma. */
    fun groups(items: List<GroupItem>): List<GroupItem>? {
        if (items.size > MAX_GROUPS) return null
        if (items.map { it.groupId }.toSet().size != items.size) return null
        for (g in items) {
            if (!UUID.matches(g.groupId) || !UUID.matches(g.schoolYearId)) return null
            if (!clean(g.label, 60) || !clean(g.code, 20) || g.grade !in 1..9) return null
            if (g.schoolYear.isBlank() || !clean(g.schoolYear, 60)) return null
            if (g.shift != null && !clean(g.shift, 20)) return null
            if (!DATE.matches(g.asOf)) return null
        }
        if (items.map { it.asOf }.toSet().size > 1) return null
        return items
    }

    /** Devuelve el padron convertido para guardarse, o `null` si no es valido o no corresponde al grupo pedido. */
    fun roster(requested: GroupItem, roster: Roster): DownloadedGroup? {
        if (roster.groupId != requested.groupId) return null // el padron de OTRO grupo jamas se acepta
        if (roster.asOf != requested.asOf) return null
        if (roster.students.size > MAX_STUDENTS) return null
        if (roster.students.map { it.id }.toSet().size != roster.students.size) return null
        val students = roster.students.map { s ->
            if (!UUID.matches(s.id) || !clean(s.givenNames, 100) || !clean(s.familyName, 100)) return null
            DownloadedStudent(s.id, s.givenNames.trim(), s.familyName.trim())
        }
        return DownloadedGroup(
            remoteId = requested.groupId,
            label = requested.label,
            grade = requested.grade,
            code = requested.code,
            shift = requested.shift,
            schoolYearId = requested.schoolYearId,
            schoolYearName = requested.schoolYear,
            students = students,
        )
    }
}

/** Resultado de la descarga autorizada (sin textos del servidor). */
sealed interface DownloadOutcome {
    data class Complete(val groups: Int, val revoked: Int, val changedRosters: Int, val draftsFlagged: Int) : DownloadOutcome

    /** Fallo de red o del servidor a mitad: la cache anterior queda intacta y NO se declara completa. */
    data object Incomplete : DownloadOutcome

    /** El servidor devolvio datos que no pasan la validacion: no se guarda nada. */
    data object Invalid : DownloadOutcome

    /** El servidor informo revocacion o bloqueo: la cache se bloquea y se conserva. */
    data class Blocked(val issue: LinkIssue) : DownloadOutcome

    /** Aun no hay identificador de dispositivo (primero se abre una sesion). */
    data object NoDevice : DownloadOutcome
}
