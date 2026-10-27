package mx.edu.eta15.prefectura.dev

/** Resultado de la comprobacion OPCIONAL de `/health` del backend de desarrollo (solo debug, solo emulador). */
sealed interface HealthResult {
    /** `/health` respondio 200. Solo indica que el proceso HTTP responde: NO es una sesion ni una sincronizacion. */
    data object Responding : HealthResult

    data object Unreachable : HealthResult

    data class UnexpectedStatus(val code: Int) : HealthResult

    /** Release: esta version no incluye la comprobacion. */
    data object NotAvailable : HealthResult
}
