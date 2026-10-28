package mx.edu.eta15.prefectura

import android.content.Context
import java.time.Clock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mx.edu.eta15.prefectura.data.AndroidNetworkMonitor
import java.time.Duration
import mx.edu.eta15.prefectura.data.LocalAttendanceRepository
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.ProfileAccessGate
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.data.NetworkMonitor
import mx.edu.eta15.prefectura.data.OutboxStore
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.secure.SecureStorage
import mx.edu.eta15.prefectura.data.secure.StorageException
import mx.edu.eta15.prefectura.demo.DEMO_PROFILE_ID
import mx.edu.eta15.prefectura.demo.DemoMode
import mx.edu.eta15.prefectura.demo.NO_SESSION_PROFILE_ID
import mx.edu.eta15.prefectura.domain.AttendanceRepository
import mx.edu.eta15.prefectura.domain.ManualSync
import mx.edu.eta15.prefectura.domain.NoManualSync
import mx.edu.eta15.prefectura.mobile.MobileFeature
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.RemoteDataSource
import mx.edu.eta15.prefectura.domain.UnavailableRemoteDataSource

/** Estado del almacenamiento local. La UI no muestra datos hasta [Ready]; ante [Failed] no hay base vacia de respaldo. */
sealed interface StorageState {
    data object Opening : StorageState

    /** `encryption` = version de SQLCipher que respondio (`PRAGMA cipher_version`); `null` solo en pruebas sin cifrado. */
    data class Ready(val repository: AttendanceRepository, val encryption: String?) : StorageState

    data class Failed(val error: StorageException) : StorageState
}

/**
 * Contenedor de dependencias manual (sin frameworks de inyeccion: no hacen falta en esta etapa).
 * Separa claramente: DemoDataSource (solo debug) -> Room cifrada (LocalDataSource, fuente de verdad de la UI) -> futura
 * fuente remota. La apertura del almacenamiento es asincrona y FAIL CLOSED (ver [SecureStorage]).
 */
class AppContainer(
    private val opener: suspend () -> EtaDatabase,
    val clock: Clock = Clock.systemUTC(),
    val ids: IdGenerator = IdGenerator.Random,
    private val profileId: String = if (DemoMode.ENABLED) DEMO_PROFILE_ID else NO_SESSION_PROFILE_ID,
    val remote: RemoteDataSource = UnavailableRemoteDataSource,
    val networkMonitor: NetworkMonitor = NetworkMonitor.Unknown,
    private val secureStorage: SecureStorage? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    /** Vigencia offline de DEMOSTRACION (SANDBOX ONLY; se fija al compilar con -Peta15.offlineValidityMinutes). */
    private val offlinePolicy: OfflinePolicy = OfflinePolicy(Duration.ofMinutes(BuildConfig.OFFLINE_VALIDITY_MINUTES.toLong())),
) {
    private val _storage = MutableStateFlow<StorageState>(StorageState.Opening)
    val storage: StateFlow<StorageState> = _storage

    @Volatile
    private var db: EtaDatabase? = null

    /** Contexto de la aplicacion (solo para el transporte de PRUEBAS del build debug; `null` en pruebas sin Android). */
    private var appContext: Context? = null
    private val syncs = HashMap<String, ManualSync>()

    /**
     * Sincronizacion MANUAL de asistencia de un perfil descargado (SANDBOX). En release y en pruebas sin contexto no existe
     * ([NoManualSync]); en debug la crea `MobileFeature`. Un ciclo solo lo inicia una persona con "Sincronizar ahora".
     */
    fun manualSync(profileId: String): ManualSync {
        val database = db ?: return NoManualSync
        val context = appContext ?: return NoManualSync
        // UN solo motor por perfil: dos pantallas nunca abren dos ciclos a la vez.
        synchronized(syncs) {
            return syncs.getOrPut(profileId) { MobileFeature.manualSync(context, database, clock, ids, profileId, offlinePolicy, scope) }
        }
    }

    /** Cache offline del servidor de pruebas (misma base cifrada); `null` mientras el almacenamiento no esta abierto. */
    val offlineCache: OfflineCacheStore? get() = db?.let { OfflineCacheStore(it, clock, offlinePolicy) }

    /**
     * Repositorio de un perfil DESCARGADO (SANDBOX) con su vigencia offline y revocaciones. Es otro perfil que el de la
     * demostracion: nunca comparten grupos, alumnos ni borradores.
     */
    fun sandboxRepository(profileId: String): AttendanceRepository? {
        val database = db ?: return null
        return LocalAttendanceRepository(
            database,
            profileId,
            clock,
            ids,
            access = ProfileAccessGate(database, profileId, clock, offlinePolicy),
        )
    }

    fun start() {
        scope.launch { openAndSeed() }
    }

    /** Reintenta abrir el almacenamiento SIN borrar nada (p. ej. tras corregir el estado del dispositivo). */
    fun retryOpen() {
        scope.launch { openAndSeed() }
    }

    private suspend fun openAndSeed() {
        _storage.value = StorageState.Opening
        _storage.value = try {
            val database = withContext(Dispatchers.IO) { opener() }
            db = database
            // Un envio que quedo a medias (el proceso murio) tiene resultado desconocido: nunca se toma como exito.
            OutboxStore(database, clock, ids).recoverAfterRestart()
            if (DemoMode.ENABLED) DemoMode.seedIfEmpty(database, ids)
            StorageState.Ready(LocalAttendanceRepository(database, profileId, clock, ids), cipherVersion(database))
        } catch (e: CancellationException) {
            throw e
        } catch (e: StorageException) {
            StorageState.Failed(e)
        } catch (e: Exception) {
            StorageState.Failed(StorageException.DatabaseUnreadable(e))
        }
    }

    /** Borrado local controlado de los datos de demostracion (solo debug; en release no hace nada). */
    fun resetDemo() {
        val database = db ?: return
        scope.launch {
            _storage.value = StorageState.Opening
            DemoMode.reset(database, ids)
            _storage.value = StorageState.Ready(LocalAttendanceRepository(database, profileId, clock, ids), cipherVersion(database))
        }
    }

    /**
     * REINICIO EXPLICITO del almacenamiento de demostracion (solo debug): cierra y borra la base cifrada y sus claves, y
     * vuelve a abrir. Se ofrece unicamente cuando la persona lo confirma; nunca ocurre solo ante un error. En release no
     * existe (no hay modo demostracion) y jamas debe usarse con informacion escolar real.
     */
    fun wipeDemoStorageAndRestart() {
        if (!DemoMode.ENABLED) return
        val storage = secureStorage ?: return
        scope.launch {
            _storage.value = StorageState.Opening
            withContext(Dispatchers.IO) {
                runCatching { db?.close() }
                db = null
                storage.wipeAll()
            }
            openAndSeed()
        }
    }

    private suspend fun cipherVersion(database: EtaDatabase): String? = withContext(Dispatchers.IO) {
        runCatching {
            database.openHelper.writableDatabase.query("PRAGMA cipher_version").use { c ->
                if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
            }
        }.getOrNull()
    }

    companion object {
        /** Produccion: almacenamiento cifrado con SQLCipher y clave protegida por Android Keystore. */
        fun create(context: Context): AppContainer {
            val storage = SecureStorage(context.applicationContext)
            return AppContainer(
                opener = { storage.open() },
                networkMonitor = AndroidNetworkMonitor(context),
                secureStorage = storage,
            ).also {
                it.appContext = context.applicationContext
                it.start()
            }
        }

        /** Pruebas: usa una base ya abierta (normalmente en memoria). */
        fun forDatabase(
            db: EtaDatabase,
            clock: Clock = Clock.systemUTC(),
            ids: IdGenerator = IdGenerator.Random,
            networkMonitor: NetworkMonitor = NetworkMonitor.Unknown,
        ): AppContainer = AppContainer(opener = { db }, clock = clock, ids = ids, networkMonitor = networkMonitor)
    }
}
