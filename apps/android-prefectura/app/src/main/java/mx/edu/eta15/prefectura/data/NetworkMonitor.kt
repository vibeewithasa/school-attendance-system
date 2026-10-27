package mx.edu.eta15.prefectura.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Estado de red SOLO informativo. Tener red NO significa que exista sincronizacion: en la etapa 1 no se envia nada.
 * La captura local nunca depende de este valor.
 */
interface NetworkMonitor {
    val isOnline: Flow<Boolean>

    /** Utilidad para pruebas. */
    class Fake(initial: Boolean) : NetworkMonitor {
        private val state = MutableStateFlow(initial)
        override val isOnline: Flow<Boolean> = state

        fun set(value: Boolean) {
            state.value = value
        }
    }

    object Unknown : NetworkMonitor {
        override val isOnline: Flow<Boolean> = MutableStateFlow(false)
    }
}

class AndroidNetworkMonitor(context: Context) : NetworkMonitor {
    private val manager = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    override val isOnline: Flow<Boolean> = callbackFlow {
        fun current(): Boolean {
            val caps = manager.getNetworkCapabilities(manager.activeNetwork)
            return caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(current()) }
            override fun onLost(network: Network) { trySend(current()) }
            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) { trySend(current()) }
        }
        trySend(current())
        manager.registerDefaultNetworkCallback(callback)
        awaitClose { manager.unregisterNetworkCallback(callback) }
    }.distinctUntilChanged()
}
