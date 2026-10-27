package mx.edu.eta15.prefectura.domain

import java.time.Instant
import java.time.LocalDate

/**
 * Marca DEFINITIVA de captura. La ausencia de marca (`null`) es "Pendiente": solo existe en un borrador local,
 * igual que en el servidor (donde un borrador con pendientes no puede finalizarse).
 */
enum class AttendanceMark { PRESENT, ABSENT }

/** Perfil local. En la etapa 1 solo existe el perfil de DEMOSTRACION; no representa una sesion escolar. */
data class Profile(val id: String, val displayName: String, val isDemo: Boolean)

data class Group(
    val id: String,
    val name: String,
    val grade: Int,
    val studentCount: Int,
    /** Alumnos con marca en el borrador de HOY (0 si no hay borrador). */
    val markedToday: Int,
    val hasDraftToday: Boolean,
)

/** Datos minimos del alumno para pasar lista: nunca un expediente (sin CURP, tutores, fotografia ni datos medicos). */
data class Student(val id: String, val givenNames: String, val familyName: String) {
    val displayName: String get() = "$givenNames $familyName"
}

data class CaptureRow(val student: Student, val mark: AttendanceMark?)

data class DraftSummary(val present: Int, val absent: Int, val pending: Int) {
    val total: Int get() = present + absent + pending
    val marked: Int get() = present + absent
    val isComplete: Boolean get() = total > 0 && pending == 0
    val progress: Float get() = if (total == 0) 0f else marked.toFloat() / total
}

/**
 * Borrador LOCAL de asistencia de un grupo y una fecha. No es una lista oficial ni equivale a finalizar la lista del
 * servidor: vive solo en este dispositivo.
 */
data class DraftState(
    val draftId: String,
    val groupId: String,
    val groupName: String,
    val schoolDate: LocalDate,
    /** Identificador estable de la operacion (preparacion para el requestId idempotente del servidor; hoy no se envia). */
    val requestId: String,
    val rows: List<CaptureRow>,
    val updatedAt: Instant,
) {
    val summary: DraftSummary
        get() = DraftSummary(
            present = rows.count { it.mark == AttendanceMark.PRESENT },
            absent = rows.count { it.mark == AttendanceMark.ABSENT },
            pending = rows.count { it.mark == null },
        )
}

/** Resultado de abrir (u obtener) el borrador de hoy para un grupo. */
sealed interface OpenDraftResult {
    data class Ready(val draftId: String, val created: Boolean) : OpenDraftResult
    data class NotSchoolDay(val date: LocalDate) : OpenDraftResult
    data object GroupNotFound : OpenDraftResult
    data object EmptyRoster : OpenDraftResult
}

/** Resultado de cambiar una marca. */
sealed interface SetMarkResult {
    data object Saved : SetMarkResult
    /** El borrador no es de la fecha escolar de hoy (p. ej. cruzo la medianoche): ya no se modifica. */
    data object DraftNotEditable : SetMarkResult
    data object NotFound : SetMarkResult
}
