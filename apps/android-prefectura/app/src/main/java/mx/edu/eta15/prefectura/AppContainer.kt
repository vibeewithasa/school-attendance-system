package mx.edu.eta15.prefectura

import android.content.Context
import java.time.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import mx.edu.eta15.prefectura.data.AndroidNetworkMonitor
import mx.edu.eta15.prefectura.data.LocalAttendanceRepository
import mx.edu.eta15.prefectura.data.NetworkMonitor
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.demo.DEMO_PROFILE_ID
import mx.edu.eta15.prefectura.demo.DemoMode
import mx.edu.eta15.prefectura.demo.NO_SESSION_PROFILE_ID
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.RemoteDataSource
import mx.edu.eta15.prefectura.domain.UnavailableRemoteDataSource

/**
 * Contenedor de dependencias manual (sin frameworks de inyeccion: no hacen falta en esta etapa).
 * Separa claramente: DemoDataSource (solo debug) -> Room (LocalDataSource, fuente de verdad de la UI) -> futura fuente remota.
 */
class AppContainer(
    val db: EtaDatabase,
    val clock: Clock = Clock.systemUTC(),
    val ids: IdGenerator = IdGenerator.Random,
    profileId: String = if (DemoMode.ENABLED) DEMO_PROFILE_ID else NO_SESSION_PROFILE_ID,
    val remote: RemoteDataSource = UnavailableRemoteDataSource,
    val networkMonitor: NetworkMonitor = NetworkMonitor.Unknown,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    val repository: AttendanceRepository = LocalAttendanceRepository(db, profileId, clock, ids)

    private val _ready = MutableStateFlow(false)

    /** `true` cuando la carga local inicial (solo demostracion en debug) termino. */
    val ready: StateFlow<Boolean> = _ready

    fun start() {
        scope.launch {
            if (DemoMode.ENABLED) DemoMode.seedIfEmpty(db, ids)
            _ready.value = true
        }
    }

    /** Borrado local controlado de la demostracion (solo debug; en release no hace nada). */
    fun resetDemo() {
        scope.launch {
            _ready.value = false
            DemoMode.reset(db, ids)
            _ready.value = true
        }
    }

    companion object {
        fun create(context: Context): AppContainer =
            AppContainer(EtaDatabase.build(context), networkMonitor = AndroidNetworkMonitor(context)).also { it.start() }
    }
}
