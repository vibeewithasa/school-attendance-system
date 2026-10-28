package mx.edu.eta15.prefectura.mobile

import java.time.Instant

/** Resultado de una llamada al servidor de PRUEBAS. Los textos del servidor nunca llegan a la interfaz: solo el codigo. */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>

    /** `status` = 0 cuando no hubo respuesta (sin red, tiempo agotado, servidor apagado). */
    data class Failure(val status: Int, val code: String?) : ApiResult<Nothing> {
        val isNetwork: Boolean get() = status == 0
    }
}

data class EnrollCreated(val requestId: String, val pairingCode: String, val fingerprint: String, val expiresAt: Instant)

data class EnrollStatus(val status: String, val expiresAt: Instant, val fingerprint: String, val claimedBy: String?)

/** Sesion movil en MEMORIA (nunca se guarda en disco): se vuelve a obtener probando la posesion de la clave del dispositivo. */
data class MobileSession(
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAt: Instant,
    val idleExpiresAt: Instant,
    val sessionExpiresAt: Instant,
    val deviceId: String,
)

data class GroupItem(val groupId: String, val label: String, val schoolYear: String)

data class RosterStudent(val id: String, val name: String)

data class Roster(val groupLabel: String, val students: List<RosterStudent>)

/** Puerto del servidor de pruebas (ver HttpMobileApi). Las llamadas autenticadas reciben la sesion; ninguna envia identidades. */
interface MobileApi {
    suspend fun enroll(jwk: EcJwk, label: String): ApiResult<EnrollCreated>

    suspend fun enrollStatus(requestId: String): ApiResult<EnrollStatus>

    /** Activa el dispositivo ya aprobado probando la posesion de la clave. Devuelve el identificador del dispositivo. */
    suspend fun activate(requestId: String): ApiResult<String>

    suspend fun openSession(): ApiResult<MobileSession>

    suspend fun renew(session: MobileSession): ApiResult<MobileSession>

    suspend fun closeSession(session: MobileSession): ApiResult<Unit>

    suspend fun myGroups(session: MobileSession): ApiResult<List<GroupItem>>

    suspend fun roster(session: MobileSession, groupId: String): ApiResult<Roster>
}
