package mx.edu.eta15.prefectura.demo

import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.domain.IdGenerator

/**
 * Release: NO hay modo demostracion. Esta version no contiene datos ficticios ni forma de activarlos; el perfil de
 * demostracion jamas se crea. (La implementacion real vive solo en `src/debug`.)
 */
object DemoMode {
    const val ENABLED = false

    @Suppress("UNUSED_PARAMETER")
    suspend fun seedIfEmpty(db: EtaDatabase, ids: IdGenerator = IdGenerator.Random) = Unit

    @Suppress("UNUSED_PARAMETER")
    suspend fun reset(db: EtaDatabase, ids: IdGenerator = IdGenerator.Random) = Unit
}
