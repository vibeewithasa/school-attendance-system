package mx.edu.eta15.prefectura.dev

/** Release: sin comprobacion de red alguna (la app de release no declara el permiso INTERNET en la etapa 1). */
object DevHealthCheck {
    const val AVAILABLE = false

    suspend fun check(): HealthResult = HealthResult.NotAvailable
}
