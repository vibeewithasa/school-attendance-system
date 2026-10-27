package mx.edu.eta15.prefectura.demo

import androidx.room.withTransaction
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.local.GroupEntity
import mx.edu.eta15.prefectura.data.local.ProfileEntity
import mx.edu.eta15.prefectura.data.local.StudentEntity
import mx.edu.eta15.prefectura.domain.IdGenerator

/**
 * DemoDataSource (SOLO debug): datos 100 % ficticios. No hay nombres de alumnos reales, no se consulta ningun servidor
 * ni `eta15_dev`, no se simula una sesion escolar valida y no existe ninguna clave de acceso.
 * En release esta clase es otra (no-op): ver `src/release`.
 */
object DemoMode {
    const val ENABLED = true

    private data class DemoGroup(val name: String, val grade: Int, val students: Int)

    private val groups = listOf(
        DemoGroup("1° A", 1, 12),
        DemoGroup("1° B", 1, 10),
        DemoGroup("2° A", 2, 14),
        DemoGroup("3° A", 3, 30), // grupo largo para probar el desplazamiento
        DemoGroup("3° B", 3, 9),
    )

    /** Crea el perfil y los grupos de demostracion si la base esta vacia (idempotente). */
    suspend fun seedIfEmpty(db: EtaDatabase, ids: IdGenerator = IdGenerator.Random) {
        db.withTransaction {
            val catalog = db.catalogDao()
            if (catalog.profileCount() > 0) return@withTransaction
            catalog.insertProfile(ProfileEntity(DEMO_PROFILE_ID, "Prefecta de demostración (ficticia)", isDemo = true))
            groups.forEachIndexed { index, g ->
                val groupId = ids.newId()
                catalog.insertGroups(listOf(GroupEntity(groupId, DEMO_PROFILE_ID, g.name, g.grade, index)))
                val label = g.name.replace("° ", "").replace(" ", "")
                catalog.insertStudents(
                    (1..g.students).map { n ->
                        StudentEntity(
                            id = ids.newId(),
                            groupId = groupId,
                            givenNames = "Alumno %02d".format(n),
                            familyName = "Ficticio $label",
                        )
                    },
                )
            }
        }
    }

    /** Borrado local controlado + nueva carga de demostracion (identificadores nuevos). */
    suspend fun reset(db: EtaDatabase, ids: IdGenerator = IdGenerator.Random) {
        db.withTransaction { db.catalogDao().deleteAllProfiles() }
        seedIfEmpty(db, ids)
    }
}
