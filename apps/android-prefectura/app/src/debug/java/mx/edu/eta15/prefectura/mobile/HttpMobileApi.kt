package mx.edu.eta15.prefectura.mobile

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mx.edu.eta15.prefectura.domain.WireMark
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * SOLO debug. Cliente HTTP del servidor de PRUEBAS (`http://10.0.2.2:3000`, el anfitrion del emulador; la configuracion de red de
 * debug no permite HTTP hacia ningun otro destino). Reglas:
 *  - No usa cookies ni cabeceras de navegador: este canal no se parece al del portal web.
 *  - Todo credencial de sesion viaja en la cabecera Authorization con prueba DPoP; nunca en la URL ni en el cuerpo (salvo la
 *    renovacion, que va en el cuerpo y siempre con prueba).
 *  - El destino de cada prueba (`htu`) se arma con la base configurada, igual que el servidor.
 *  - No se siguen redirecciones y las respuestas se leen con un limite de tamano.
 */
class HttpMobileApi(
    private val baseUrl: String,
    private val proofs: DpopProofBuilder,
    private val jwk: EcJwk,
) : MobileApi, AttendanceApi {
    private class Raw(val status: Int, val body: String, val retryAfter: Int? = null)

    private suspend fun call(
        method: String,
        path: String,
        body: String? = null,
        proof: String? = null,
        access: String? = null,
    ): Raw? = withContext(Dispatchers.IO) {
        // HttpURLConnection declara por su cuenta `application/x-www-form-urlencoded` en un POST sin cuerpo y el servidor lo rechaza
        // (415): todo POST envia JSON, aunque sea vacio.
        val payload = body ?: if (method == "POST") "{}" else null
        try {
            val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = method
                connection.connectTimeout = 5_000
                connection.readTimeout = 10_000
                connection.useCaches = false
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("Accept", "application/json")
                if (proof != null) connection.setRequestProperty("DPoP", proof)
                if (access != null) connection.setRequestProperty("Authorization", "DPoP $access")
                if (payload != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val retryAfter = connection.getHeaderField("Retry-After")?.trim()?.toIntOrNull()?.takeIf { it in 0..3600 }
                Raw(status, stream?.use { readLimited(it) } ?: "", retryAfter)
            } finally {
                connection.disconnect()
            }
        } catch (_: IOException) {
            null
        }
    }

    private fun readLimited(input: java.io.InputStream): String {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
            if (out.size() > MAX_BODY) throw IOException("Respuesta demasiado grande")
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private fun <T> parse(raw: Raw?, okStatus: Set<Int>, read: (JSONObject) -> T): ApiResult<T> {
        if (raw == null) return ApiResult.Failure(0, null)
        if (raw.status !in okStatus) return ApiResult.Failure(raw.status, errorCode(raw.body), raw.retryAfter)
        return try {
            ApiResult.Ok(read(JSONObject(raw.body.ifBlank { "{}" })))
        } catch (_: JSONException) {
            ApiResult.Failure(raw.status, "BAD_RESPONSE")
        }
    }

    private fun errorCode(body: String): String? = try {
        JSONObject(body).optJSONObject("error")?.optString("code")?.takeIf { it.isNotBlank() }
    } catch (_: JSONException) {
        null
    }

    /**
     * Pide un nonce de UN solo uso para la siguiente operacion. El desafio va firmado por la propia clave (prueba DPoP sin nonce):
     * el servidor solo lo emite a una clave ya ligada a una solicitud abierta o a un dispositivo registrado.
     */
    private suspend fun nonce(): String? {
        val path = "/mobile/auth/challenge"
        val raw = call("POST", path, """{"keyThumbprint":${Dpop.jsonString(jwk.thumbprint())}}""", proof("POST", path))
        if (raw == null || raw.status != 200) return null
        return try {
            JSONObject(raw.body).getString("nonce")
        } catch (_: JSONException) {
            null
        }
    }

    private fun proof(method: String, path: String, access: String? = null, nonce: String? = null) =
        proofs.build(method, baseUrl + path, access, nonce)

    override suspend fun enroll(jwk: EcJwk, label: String): ApiResult<EnrollCreated> {
        val body = """{"publicKey":${jwk.json()},"label":${Dpop.jsonString(label)},"platform":"android"}"""
        return parse(call("POST", "/mobile/enroll/requests", body), setOf(201)) {
            EnrollCreated(
                it.getString("requestId"),
                it.getString("pairingCode"),
                it.getString("fingerprint"),
                Instant.parse(it.getString("expiresAt")),
            )
        }
    }

    override suspend fun enrollStatus(requestId: String): ApiResult<EnrollStatus> {
        val path = "/mobile/enroll/requests/$requestId"
        return parse(call("GET", path, proof = proof("GET", path)), setOf(200)) {
            EnrollStatus(
                it.getString("status"),
                Instant.parse(it.getString("expiresAt")),
                it.getString("fingerprint"),
                it.optJSONObject("claimedBy")?.optString("displayName")?.takeIf { n -> n.isNotBlank() },
            )
        }
    }

    override suspend fun activate(requestId: String): ApiResult<String> {
        val path = "/mobile/enroll/requests/$requestId/activate"
        val nonce = nonce() ?: return ApiResult.Failure(0, null)
        return parse(call("POST", path, proof = proof("POST", path, nonce = nonce)), setOf(201)) { it.getString("deviceId") }
    }

    private fun readSession(o: JSONObject) = MobileSession(
        accessToken = o.getString("accessToken"),
        refreshToken = o.getString("refreshToken"),
        accessExpiresAt = Instant.parse(o.getString("accessExpiresAt")),
        idleExpiresAt = Instant.parse(o.getString("idleExpiresAt")),
        sessionExpiresAt = Instant.parse(o.getString("sessionExpiresAt")),
        deviceId = o.getString("deviceId"),
    )

    override suspend fun openSession(): ApiResult<MobileSession> {
        val path = "/mobile/auth/token"
        val nonce = nonce() ?: return ApiResult.Failure(0, null)
        return parse(call("POST", path, proof = proof("POST", path, nonce = nonce)), setOf(200), ::readSession)
    }

    override suspend fun renew(session: MobileSession): ApiResult<MobileSession> {
        val path = "/mobile/auth/refresh"
        val nonce = nonce() ?: return ApiResult.Failure(0, null)
        val body = """{"refreshToken":${Dpop.jsonString(session.refreshToken)}}"""
        return parse(call("POST", path, body, proof("POST", path, nonce = nonce)), setOf(200), ::readSession)
    }

    override suspend fun closeSession(session: MobileSession): ApiResult<Unit> {
        val path = "/mobile/auth/logout"
        val raw = call("POST", path, proof = proof("POST", path, session.accessToken), access = session.accessToken)
        return when {
            raw == null -> ApiResult.Failure(0, null)
            raw.status == 204 -> ApiResult.Ok(Unit)
            else -> ApiResult.Failure(raw.status, errorCode(raw.body))
        }
    }

    override suspend fun myGroups(session: MobileSession): ApiResult<List<GroupItem>> {
        val path = "/mobile/school/me/groups"
        val raw = call("GET", path, proof = proof("GET", path, session.accessToken), access = session.accessToken)
        return parse(raw, setOf(200)) { o ->
            val groups: JSONArray = o.getJSONArray("groups")
            val asOf = o.getString("asOf")
            (0 until groups.length()).map { i ->
                val g = groups.getJSONObject(i).getJSONObject("group")
                GroupItem(
                    groupId = g.getString("id"),
                    label = groupLabel(g),
                    schoolYear = g.optString("schoolYearName"),
                    grade = g.getInt("grade"),
                    code = g.getString("code"),
                    shift = g.optString("shift").takeIf { it.isNotBlank() && it != "null" },
                    schoolYearId = g.getString("schoolYearId"),
                    asOf = asOf,
                )
            }
        }
    }

    override suspend fun roster(session: MobileSession, groupId: String): ApiResult<Roster> {
        val path = "/mobile/school/groups/$groupId/roster"
        val raw = call("GET", path, proof = proof("GET", path, session.accessToken), access = session.accessToken)
        return parse(raw, setOf(200)) { o ->
            val students = o.getJSONArray("students")
            val group = o.getJSONObject("group")
            Roster(
                groupLabel(group),
                (0 until students.length()).map { i ->
                    val s = students.getJSONObject(i)
                    RosterStudent(
                        s.getString("id"),
                        "${s.getString("givenNames")} ${s.getString("familyName")}",
                        s.getString("givenNames"),
                        s.getString("familyName"),
                    )
                },
                groupId = group.getString("id"),
                asOf = o.getString("asOf"),
            )
        }
    }

    // ===================================================================================== asistencia (sandbox, manual)
    // Exactamente CUATRO operaciones del canal movil de asistencia: leer hoy, leer una lista, abrir la lista del dia y guardar marcas.
    // No existen finalizar, borrar, corregir ni historial. Cada peticion lleva una prueba DPoP NUEVA (jti aleatorio) ligada al metodo,
    // a la URL y al token de acceso; el `requestId` de la operacion viaja solo en el cuerpo y es estable en los reintentos.

    override suspend fun today(session: MobileSession): ApiResult<SrvToday> {
        val path = "/mobile/school/attendance/today"
        val raw = call("GET", path, proof = proof("GET", path, session.accessToken), access = session.accessToken)
        return parse(raw, setOf(200), AttendanceJson::today)
    }

    override suspend fun day(session: MobileSession, dayId: String): ApiResult<SrvDetail> {
        val path = "/mobile/school/attendance/days/$dayId"
        val raw = call("GET", path, proof = proof("GET", path, session.accessToken), access = session.accessToken)
        return parse(raw, setOf(200), AttendanceJson::detail)
    }

    override suspend fun groupRoster(session: MobileSession, groupId: String): ApiResult<Roster> = roster(session, groupId)

    override suspend fun openDay(session: MobileSession, groupId: String, attendanceDate: String): ApiResult<SrvOpen> {
        val path = "/mobile/school/attendance/days"
        val body = """{"groupId":${Dpop.jsonString(groupId)},"attendanceDate":${Dpop.jsonString(attendanceDate)}}"""
        val raw = call("POST", path, body, proof("POST", path, session.accessToken), session.accessToken)
        return parse(raw, setOf(200, 201)) { AttendanceJson.open(it, created = raw?.status == 201) }
    }

    override suspend fun saveMarks(
        session: MobileSession,
        dayId: String,
        expectedRevision: Int,
        requestId: String,
        marks: List<WireMark>,
    ): ApiResult<SrvSave> {
        val path = "/mobile/school/attendance/days/$dayId/marks"
        val body = AttendanceJson.saveBody(expectedRevision, requestId, marks)
        val raw = call("POST", path, body, proof("POST", path, session.accessToken), session.accessToken)
        return parse(raw, setOf(200), AttendanceJson::save)
    }

    private fun groupLabel(g: JSONObject): String {
        val shift = g.optString("shift").takeIf { it.isNotBlank() && it != "null" }
        return "${g.getInt("grade")}.º ${g.getString("code")}" + (shift?.let { " · $it" } ?: "")
    }

    private companion object {
        const val MAX_BODY = 256 * 1024
    }
}
