package mx.edu.eta15.prefectura.data.secure

/**
 * Fallos del almacenamiento protegido. La politica es FAIL CLOSED: ante cualquiera de ellos la app NO abre una base
 * vacia, NO regenera claves y NO borra nada; muestra el error y espera una accion explicita. Los mensajes jamas incluyen
 * material de claves ni rutas internas.
 */
sealed class StorageException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** Existe una base cifrada (o una clave envuelta) pero falta la clave de Android Keystore o el archivo envuelto. */
    class KeyMissing(message: String) : StorageException(message)

    /** Android invalido la clave (p. ej. cambio del bloqueo de pantalla o restablecimiento de credenciales). */
    class KeyInvalidated(cause: Throwable?) : StorageException("La clave del almacenamiento fue invalidada por el sistema", cause)

    /** El archivo con la clave envuelta esta danado o fue alterado (falla la autenticacion AES-GCM). */
    class KeyCorrupt(cause: Throwable? = null) : StorageException("La clave protegida esta danada o fue alterada", cause)

    /** Android Keystore no esta disponible o fallo una operacion criptografica del sistema. */
    class KeystoreUnavailable(cause: Throwable?) : StorageException("Android Keystore no esta disponible", cause)

    /** La base existe pero no se pudo abrir con la clave (clave equivocada o archivo danado). */
    class DatabaseUnreadable(cause: Throwable? = null) : StorageException("No se pudo abrir la base cifrada", cause)

    /** Hay una base anterior sin cifrar que no se reconoce (no es la version 1 conocida): no se toca. */
    class UnknownLegacyFormat(message: String) : StorageException(message)

    /** La conversion de la base anterior fallo; la base anterior queda intacta. */
    class ConversionFailed(message: String, cause: Throwable? = null) : StorageException(message, cause)
}
