package mx.edu.eta15.prefectura.dev

import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mx.edu.eta15.prefectura.BuildConfig

/**
 * SOLO debug. GET sin credenciales ni datos a `/health` (10.0.2.2 = localhost del equipo anfitrion visto desde el
 * emulador). No toca endpoints protegidos, no envia ni recibe datos escolares y no cambia nada en el servidor.
 * Si el servidor no esta disponible, la app local sigue funcionando.
 */
object DevHealthCheck {
    const val AVAILABLE = true

    suspend fun check(): HealthResult = withContext(Dispatchers.IO) {
        try {
            val connection = URL(BuildConfig.DEV_HEALTH_URL).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "GET"
                connection.connectTimeout = 2_000
                connection.readTimeout = 2_000
                connection.useCaches = false
                val code = connection.responseCode
                if (code == 200) HealthResult.Responding else HealthResult.UnexpectedStatus(code)
            } finally {
                connection.disconnect()
            }
        } catch (_: java.io.IOException) {
            HealthResult.Unreachable
        }
    }
}
