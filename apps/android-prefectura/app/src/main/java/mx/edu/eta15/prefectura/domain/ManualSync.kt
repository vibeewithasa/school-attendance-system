package mx.edu.eta15.prefectura.domain

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/*
 * Puerto de la sincronizacion MANUAL de asistencia (SANDBOX ONLY).
 *
 * Aqui solo viven los tipos que la interfaz necesita. El transporte HTTP, la prueba de posesion y el motor del ciclo existen UNICAMENTE en el
 * conjunto de fuentes `debug` (motor del ciclo manual, ver el conjunto de fuentes debug): en release este puerto se resuelve siempre a [NoManualSync], que no
 * esta disponible, no tiene red y jamas inicia nada. Un ciclo SOLO lo inicia una persona pulsando "Sincronizar ahora": ni abrir la
 * aplicacion, ni recuperar la conexion, ni reiniciar el proceso, ni iniciar sesion, ni navegar, ni preparar una intencion, ni un
 * temporizador lo disparan.
 */

/** Resultado de UN ciclo manual, sin textos del servidor. La interfaz lo traduce a un mensaje. */
enum class SyncResultKind {
    /** Todo lo enviable quedo CONFIRMADO por el servidor y el recibo ya esta guardado en Room. */
    CONFIRMED,

    /** No habia nada pendiente de enviar (o ya estaba confirmado): no se hizo ninguna escritura. */
    NOTHING_TO_SEND,

    /** Sin conexion: nada cambio; todo sigue guardado en el dispositivo. */
    OFFLINE,

    /** Hace falta volver a autenticar el dispositivo o la cuenta. */
    SESSION_REQUIRED,

    /** Error temporal (limite de peticiones, servidor no disponible, tiempo agotado). Se puede reintentar con el MISMO envio. */
    TEMPORARY_ERROR,

    /** La lista del servidor cambio (o esta finalizada): se conserva todo y no se resuelve solo. */
    CONFLICT,

    /** Algo exige revision de una persona (fecha, padron, grupo, identidad de la operacion): el envio queda bloqueado. */
    NEEDS_REVIEW,

    /** El envio salio pero no se pudo guardar o confirmar el resultado: se recupera con el mismo `requestId` en el proximo ciclo. */
    RESULT_UNKNOWN,

    /** El servidor de pruebas no tiene habilitada la sincronizacion de asistencia. */
    NOT_ENABLED,

    /** Cancelado por la persona o por el sistema; lo persistido se conserva. */
    CANCELLED,

    /** Este perfil o este dispositivo no pueden usar el transporte (demostracion, identidad distinta). */
    NOT_ALLOWED,
}

data class SyncReport(val kind: SyncResultKind, val confirmed: Int = 0)

data class ManualSyncState(
    /** Hay un ciclo en curso (solo uno a la vez). */
    val running: Boolean = false,
    /** Grupo (local) del ciclo en curso o del ultimo ciclo. */
    val groupId: String? = null,
    val last: SyncReport? = null,
)

interface ManualSync {
    /** `false` en release y en perfiles que no pueden sincronizar: la interfaz no ofrece "Sincronizar ahora". */
    val available: Boolean

    val state: StateFlow<ManualSyncState>

    /** Inicia UN ciclo para el grupo (accion de la persona). Si ya hay uno en curso no hace nada. */
    fun syncNow(groupId: String)

    /** Cancela el ciclo en curso; lo persistido se conserva y una peticion en vuelo queda como resultado desconocido. */
    fun cancel()

    fun consumeReport()
}

/** Release y demostracion: no existe sincronizacion. */
object NoManualSync : ManualSync {
    override val available: Boolean = false
    override val state: StateFlow<ManualSyncState> = MutableStateFlow(ManualSyncState())

    override fun syncNow(groupId: String) = Unit

    override fun cancel() = Unit

    override fun consumeReport() = Unit
}
