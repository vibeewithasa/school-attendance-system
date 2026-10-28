package mx.edu.eta15.prefectura.data

import androidx.room.Room
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.testContext
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.MutableClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Esquema versionado: v1 (demostracion local) y v2 (cache offline del servidor de pruebas). Se prueba que los esquemas EXPORTADOS
 * (app/schemas/.../1.json y 2.json) coinciden con las entidades y que la MIGRACION 1 -> 2 (solo agrega columnas y tablas) conserva
 * todos los datos de una instalacion anterior y deja los valores por omision correctos. Nunca migracion destructiva.
 */
@RunWith(AndroidJUnit4::class)
class SchemaMigrationTest {
    private val dbName = "schema-test.db"

    @org.junit.Before
    @org.junit.After
    fun limpiar() {
        testContext().deleteDatabase(dbName)
    }

    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), EtaDatabase::class.java)

    @Test
    fun laVersion2ExportadaCoincideConLasEntidades() {
        helper.createDatabase(dbName, 2).close()
        val db = Room.databaseBuilder(testContext(), EtaDatabase::class.java, dbName)
            .addCallback(EtaDatabase.integrityCallback)
            .build()
        try {
            val version = db.openHelper.writableDatabase.version // abre y valida identidad/esquema
            assertEquals(2, version)
            assertNotNull(db.catalogDao())
        } finally {
            db.close()
            testContext().deleteDatabase(dbName)
        }
    }

    @Test
    fun laMigracion1a2ConservaDatosYDejaValoresPorOmision() {
        // Instalacion anterior (v1) con un perfil de demostracion, un grupo, alumnos, un borrador y una marca.
        helper.createDatabase(dbName, 1).apply {
            execSQL("INSERT INTO profiles (id, displayName, isDemo) VALUES ('p1', 'Demo', 1)")
            execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder) VALUES ('g1', 'p1', '1.º A', 1, 0)")
            execSQL("INSERT INTO students (id, groupId, givenNames, familyName) VALUES ('s1', 'g1', 'Ana', 'Ficticia'), ('s2', 'g1', 'Beto', 'Ficticio')")
            execSQL("INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs) VALUES ('d1', 'p1', 'g1', '2026-10-27', 'r1', 1, 1)")
            execSQL("INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES ('d1', 'g1', 's1', 'PRESENT', 5), ('d1', 'g1', 's2', NULL, NULL)")
            close()
        }
        val migrated = helper.runMigrationsAndValidate(dbName, 2, true, EtaDatabase.MIGRATION_1_2)
        fun one(sql: String): String? = migrated.query(sql).use { c -> if (c.moveToFirst()) c.getString(0) else null }
        assertEquals("DEMO", one("SELECT source FROM profiles WHERE id = 'p1'"))
        assertEquals("ACTIVE", one("SELECT authState FROM school_groups WHERE id = 'g1'"))
        assertEquals(null, one("SELECT remoteId FROM school_groups WHERE id = 'g1'"))
        assertEquals("2", one("SELECT COUNT(*) FROM students WHERE active = 1"))
        assertEquals("0", one("SELECT needsReview FROM attendance_drafts WHERE id = 'd1'"))
        assertEquals(null, one("SELECT rosterDigest FROM attendance_drafts WHERE id = 'd1'"))
        assertEquals("PRESENT", one("SELECT status FROM attendance_marks WHERE studentId = 's1'"))
        assertEquals("0", one("SELECT COUNT(*) FROM roster_snapshots"))
        assertEquals("0", one("SELECT COUNT(*) FROM profile_sync"))
        migrated.close()
    }

    @Test
    fun trasMigrarLaAppLeeLosDatosAnterioresYSigueCapturando() = runBlocking {
        helper.createDatabase(dbName, 1).apply {
            execSQL("INSERT INTO profiles (id, displayName, isDemo) VALUES ('p1', 'Demo', 1)")
            execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder) VALUES ('g1', 'p1', '1.º A', 1, 0)")
            execSQL("INSERT INTO students (id, groupId, givenNames, familyName) VALUES ('s1', 'g1', 'Ana', 'Ficticia')")
            close()
        }
        val db = Room.databaseBuilder(testContext(), EtaDatabase::class.java, dbName)
            .addMigrations(EtaDatabase.MIGRATION_1_2)
            .addCallback(EtaDatabase.integrityCallback)
            .build()
        try {
            val repo = mx.edu.eta15.prefectura.data.LocalAttendanceRepository(db, "p1", MutableClock(), SequentialIds("m"))
            assertEquals(listOf("1.º A"), repo.observeGroups().first().map { it.name })
            val draft = repo.openTodayDraft("g1") as OpenDraftResult.Ready
            assertTrue(repo.setMark(draft.draftId, "s1", AttendanceMark.PRESENT) is mx.edu.eta15.prefectura.domain.SetMarkResult.Saved)
            assertEquals(2, db.openHelper.writableDatabase.version)
        } finally {
            db.close()
        }
    }
}
