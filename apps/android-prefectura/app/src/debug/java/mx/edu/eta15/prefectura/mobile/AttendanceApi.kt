package mx.edu.eta15.prefectura.mobile

import mx.edu.eta15.prefectura.domain.WireMark
import org.json.JSONArray
import org.json.JSONObject

/*
 * SOLO debug. Contrato del canal MOVIL de asistencia del servidor de PRUEBAS (rutas moviles de asistencia; ADR 0005 y 0006,
 * ambos PROPUESTOS). Reconstruido del codigo real del backend (`apps/api/src/modules/attendance/attendance.mobile.ts` y
 * `packages/shared-contracts/src/mobile-attendance.ts`). Los textos de error del servidor nunca llegan a la interfaz: solo su codigo.
 *
 * Solo CUATRO operaciones: leer hoy, leer una lista, abrir la lista del dia y guardar marcas. No existen finalizar, borrar,
 * corregir ni historial.
 */

/** Cabecera de una lista del servidor (proyeccion movil). `revision` es la que se envia como `expectedRevision`. */
data class SrvDay(
    val id: String,
    val groupId: String,
    val attendanceDate: String,
    val status: String,
    val revision: Int,
) {
    val isFinalized: Boolean get() = status == "finalized"
}

data class SrvTodayGroup(val groupId: String, val day: SrvDay?)

/** `schoolToday` lo decide el SERVIDOR (America/Mazatlan): es la unica autoridad sobre "hoy". */
data class SrvToday(val schoolToday: String, val isSchoolDay: Boolean, val groups: List<SrvTodayGroup>)

data class SrvRecord(val studentId: String, val status: String)

data class SrvDetail(
    val schoolToday: String,
    val day: SrvDay,
    /** Huella v1 del padron CONGELADO de la lista (`v1:` + SHA-256 hexadecimal de los ids ordenados, ver RosterDigest). */
    val rosterDigest: String,
    val records: List<SrvRecord>,
)

data class SrvOpen(val detail: SrvDetail, val created: Boolean)

data class SrvSave(val detail: SrvDetail, val changed: Int, val replayed: Boolean)

interface AttendanceApi {
    suspend fun today(session: MobileSession): ApiResult<SrvToday>

    suspend fun day(session: MobileSession, dayId: String): ApiResult<SrvDetail>

    /** `attendanceDate` es OBLIGATORIA: el servidor la contrasta con su "hoy" y rechaza otra fecha (400 DATE_NOT_TODAY). */
    suspend fun openDay(session: MobileSession, groupId: String, attendanceDate: String): ApiResult<SrvOpen>

    /** El `requestId` y las marcas son los de la operacion SELLADA: no cambian en ningun reintento. */
    suspend fun saveMarks(
        session: MobileSession,
        dayId: String,
        expectedRevision: Int,
        requestId: String,
        marks: List<WireMark>,
    ): ApiResult<SrvSave>
}

/** Lectura y armado de JSON del canal de asistencia. Falla (JSONException) ante cualquier forma inesperada: nunca "arregla" datos. */
object AttendanceJson {
    private fun day(o: JSONObject) = SrvDay(
        id = o.getString("id"),
        groupId = o.getString("groupId"),
        attendanceDate = o.getString("attendanceDate"),
        status = o.getString("status"),
        revision = o.getInt("revision"),
    )

    fun today(o: JSONObject): SrvToday {
        val groups = o.getJSONArray("groups")
        return SrvToday(
            schoolToday = o.getString("schoolToday"),
            isSchoolDay = o.getBoolean("isSchoolDay"),
            groups = (0 until groups.length()).map { i ->
                val g = groups.getJSONObject(i)
                SrvTodayGroup(g.getString("groupId"), if (g.isNull("day")) null else day(g.getJSONObject("day")))
            },
        )
    }

    fun detail(o: JSONObject): SrvDetail {
        val records = o.getJSONArray("records")
        return SrvDetail(
            schoolToday = o.getString("schoolToday"),
            day = day(o.getJSONObject("day")),
            rosterDigest = o.getString("rosterDigest"),
            records = (0 until records.length()).map { i ->
                val r = records.getJSONObject(i)
                SrvRecord(r.getString("studentId").lowercase(), r.getString("status"))
            },
        )
    }

    fun open(o: JSONObject, created: Boolean): SrvOpen = SrvOpen(detail(o.getJSONObject("day")), created)

    fun save(o: JSONObject): SrvSave = SrvSave(detail(o.getJSONObject("day")), o.getInt("changed"), o.getBoolean("replayed"))

    /** Cuerpo de guardado: el MISMO contrato del portal (`saveAttendanceMarksBody`). */
    fun saveBody(expectedRevision: Int, requestId: String, marks: List<WireMark>): String {
        val array = JSONArray()
        marks.forEach { array.put(JSONObject().put("studentId", it.studentId).put("status", it.status)) }
        return JSONObject().put("expectedRevision", expectedRevision).put("requestId", requestId).put("marks", array).toString()
    }
}
