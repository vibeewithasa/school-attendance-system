package mx.edu.eta15.prefectura.data

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Esquema versionado. Hoy solo existe la version 1, asi que no hay migraciones que probar; esta prueba comprueba que el
 * esquema EXPORTADO (app/schemas/.../1.json) coincide con las entidades: Room valida el esquema al abrir la base creada
 * desde el JSON. Cuando exista la version 2 se agrega aqui `runMigrationsAndValidate` (nunca migracion destructiva).
 */
@RunWith(AndroidJUnit4::class)
class SchemaMigrationTest {
    private val dbName = "schema-test.db"

    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), EtaDatabase::class.java)

    @Test
    fun laVersion1ExportadaCoincideConLasEntidades() {
        helper.createDatabase(dbName, 1).close()
        val db = Room.databaseBuilder(testContext(), EtaDatabase::class.java, dbName)
            .addCallback(EtaDatabase.integrityCallback)
            .build()
        try {
            val version = db.openHelper.writableDatabase.version // abre y valida identidad/esquema
            assertEquals(1, version)
            assertNotNull(db.catalogDao())
        } finally {
            db.close()
            testContext().deleteDatabase(dbName)
        }
    }
}
