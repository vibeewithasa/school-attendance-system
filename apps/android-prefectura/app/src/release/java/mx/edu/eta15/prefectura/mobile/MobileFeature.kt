package mx.edu.eta15.prefectura.mobile

import android.content.Context
import androidx.compose.runtime.Composable
import mx.edu.eta15.prefectura.data.OfflineSink

/** Release: la vinculacion experimental no existe (ni claves de dispositivo, ni cliente de red, ni permiso de red). */
object MobileFeature {
    const val AVAILABLE = false

    /** Sin vinculacion no hay cache descargada: en release siempre es nulo. */
    @Suppress("UNUSED_PARAMETER")
    fun sandboxProfileId(context: Context): String? = null

    /** Sin transporte: en release la sincronizacion manual NO existe (ni cliente de red ni permiso de red). */
    @Suppress("UNUSED_PARAMETER")
    fun manualSync(
        context: Context,
        db: mx.edu.eta15.prefectura.data.local.EtaDatabase,
        clock: java.time.Clock,
        ids: mx.edu.eta15.prefectura.domain.IdGenerator,
        profileId: String,
        policy: mx.edu.eta15.prefectura.domain.OfflinePolicy,
        scope: kotlinx.coroutines.CoroutineScope,
    ): mx.edu.eta15.prefectura.domain.ManualSync = mx.edu.eta15.prefectura.domain.NoManualSync

    @Composable
    fun HomeEntry(onOpen: () -> Unit) = Unit

    @Composable
    @Suppress("UNUSED_PARAMETER")
    fun Screen(onBack: () -> Unit, cache: OfflineSink? = null, onOpenOffline: () -> Unit = {}) = Unit
}
