package mx.edu.eta15.prefectura.data

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Duration
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Esquema versionado: v1 (demostracion local), v2 (cache offline del servidor de pruebas) y v3 (outbox local persistente). Se prueba
 * que los esquemas EXPORTADOS (app/schemas/.../1.json, 2.json y 3.json) coinciden con las entidades y que las migraciones 1 -> 2 y
 * 2 -> 3 (solo agregan columnas y tablas) conservan todos los datos de una instalacion anterior, incluidos perfiles distintos,
 * borradores incompletos, grupos revocados y alumnos inactivos. Nunca migracion destructiva.
 */
@RunWith(AndroidJUnit4::class)
class SchemaMigrationTest {
    private val dbName = "schema-test.db"
    private val clock = MutableClock()
    private val policy = OfflinePolicy(Duration.ofMinutes(10))

    private val deviceA = "dddddddd-0000-4000-8000-00000000000a"
    private val deviceB = "dddddddd-0000-4000-8000-00000000000b"
    private val g1 = "11111111-0000-4000-8000-000000000001"
    private val g2 = "22222222-0000-4000-8000-000000000002"
    private val s1 = "51111111-0000-4000-8000-0000000000a1"
    private val s2 = "52222222-0000-4000-8000-0000000000a2"
    private val s3 = "53333333-0000-4000-8000-0000000000a3"

    @Before
    @After
    fun limpiar() {
        testContext().deleteDatabase(dbName)
    }

    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), EtaDatabase::class.java)

    private fun one(db: SupportSQLiteDatabase, sql: String): String? =
        db.query(sql).use { c -> if (c.moveToFirst()) c.getString(0) else null }

    private fun room(vararg migrations: androidx.room.migration.Migration) =
        Room.databaseBuilder(testContext(), EtaDatabase::class.java, dbName)
            .addMigrations(*migrations)
            .addCallback(EtaDatabase.integrityCallback)
            .build()

    private fun profileOf(device: String) = SandboxIds.profile(device)

    private fun groupOf(device: String, remote: String) = SandboxIds.group(profileOf(device), remote)

    private fun studentOf(device: String, group: String, remote: String) = SandboxIds.student(groupOf(device, group), remote)

    /** Instalacion v2 con DOS perfiles descargados, un grupo revocado, un alumno inactivo y borradores incompletos. Datos ficticios. */
    private fun seedV2(db: SupportSQLiteDatabase) {
        val now = clock.millis()
        for (device in listOf(deviceA, deviceB)) {
            val p = profileOf(device)
            db.execSQL("INSERT INTO profiles (id, displayName, isDemo, source) VALUES ('$p', 'Prefectura ficticia', 0, 'SANDBOX')")
            db.execSQL(
                "INSERT INTO profile_sync (profileId, deviceId, lastServerContactEpochMs, serverSchoolDate, lastDownloadAtEpochMs, authorizedUntilEpochMs, authState, highWaterEpochMs) " +
                    "VALUES ('$p', '$device', $now, '2026-10-27', $now, ${now + policy.validity.toMillis()}, 'ACTIVE', $now)",
            )
            db.execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder, remoteId, authState) VALUES ('${groupOf(device, g1)}', '$p', '1.º A', 1, 0, '$g1', 'ACTIVE')")
            db.execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder, remoteId, authState) VALUES ('${groupOf(device, g2)}', '$p', '1.º B', 1, 1, '$g2', 'REVOKED')")
            db.execSQL("INSERT INTO students (id, groupId, givenNames, familyName, remoteId, active) VALUES ('${studentOf(device, g1, s1)}', '${groupOf(device, g1)}', 'Ana', 'Ficticia', '$s1', 1)")
            db.execSQL("INSERT INTO students (id, groupId, givenNames, familyName, remoteId, active) VALUES ('${studentOf(device, g1, s2)}', '${groupOf(device, g1)}', 'Beto', 'Ficticio', '$s2', 1)")
            db.execSQL("INSERT INTO students (id, groupId, givenNames, familyName, remoteId, active) VALUES ('${studentOf(device, g1, s3)}', '${groupOf(device, g1)}', 'Carla', 'Inactiva', '$s3', 0)")
            db.execSQL("INSERT INTO roster_snapshots (groupId, downloadedAtEpochMs, serverSchoolDate, rosterDigest, studentCount) VALUES ('${groupOf(device, g1)}', $now, '2026-10-27', 'abc', 2)")
            // borrador incompleto (una marca, otra pendiente, la inactiva sin marca) y un borrador del grupo revocado
            db.execSQL("INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs, rosterDigest, needsReview) VALUES ('draft-$device', '$p', '${groupOf(device, g1)}', '2026-10-27', 'req-$device', 1, 1, 'abc', 0)")
            db.execSQL("INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES ('draft-$device', '${groupOf(device, g1)}', '${studentOf(device, g1, s1)}', 'PRESENT', 5)")
            db.execSQL("INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES ('draft-$device', '${groupOf(device, g1)}', '${studentOf(device, g1, s2)}', NULL, NULL)")
            db.execSQL("INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs, needsReview, reviewReason) VALUES ('rev-$device', '$p', '${groupOf(device, g2)}', '2026-10-26', 'rq-$device', 1, 1, 1, 'GROUP_REVOKED')")
        }
    }

    private fun assertV2DataIntact(db: SupportSQLiteDatabase) {
        assertEquals("2", one(db, "SELECT COUNT(*) FROM profiles WHERE source = 'SANDBOX'"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM profile_sync"))
        assertEquals("4", one(db, "SELECT COUNT(*) FROM school_groups"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM school_groups WHERE authState = 'REVOKED'"))
        assertEquals("6", one(db, "SELECT COUNT(*) FROM students"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM students WHERE active = 0"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM roster_snapshots"))
        assertEquals("4", one(db, "SELECT COUNT(*) FROM attendance_drafts"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM attendance_drafts WHERE needsReview = 1 AND reviewReason = 'GROUP_REVOKED'"))
        assertEquals("4", one(db, "SELECT COUNT(*) FROM attendance_marks"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM attendance_marks WHERE status = 'PRESENT'"))
        assertEquals("2", one(db, "SELECT COUNT(*) FROM attendance_marks WHERE status IS NULL")) // los Pendientes siguen Pendientes
        assertEquals("abc", one(db, "SELECT rosterDigest FROM attendance_drafts WHERE id = 'draft-$deviceA'"))
    }

    private fun assertOutboxEmptyAndPresent(db: SupportSQLiteDatabase) {
        assertEquals("0", one(db, "SELECT COUNT(*) FROM sync_operations"))
        assertEquals("0", one(db, "SELECT COUNT(*) FROM sync_operation_marks"))
    }

    @Test
    fun laVersion2ExportadaCoincideConLasEntidadesAnteriores() {
        helper.createDatabase(dbName, 2).close()
        val db = room(EtaDatabase.MIGRATION_2_3)
        try {
            assertEquals(3, db.openHelper.writableDatabase.version) // al abrir migra y valida identidad/esquema
            assertNotNull(db.catalogDao())
        } finally {
            db.close()
        }
    }

    @Test
    fun laVersion3ExportadaCoincideConLasEntidades() {
        helper.createDatabase(dbName, 3).close() // base v3 limpia, creada desde el esquema exportado
        val db = room()
        try {
            assertEquals(3, db.openHelper.writableDatabase.version)
            assertNotNull(db.outboxDao())
            assertOutboxEmptyAndPresent(db.openHelper.writableDatabase)
        } finally {
            db.close()
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
        assertEquals("DEMO", one(migrated, "SELECT source FROM profiles WHERE id = 'p1'"))
        assertEquals("ACTIVE", one(migrated, "SELECT authState FROM school_groups WHERE id = 'g1'"))
        assertEquals(null, one(migrated, "SELECT remoteId FROM school_groups WHERE id = 'g1'"))
        assertEquals("2", one(migrated, "SELECT COUNT(*) FROM students WHERE active = 1"))
        assertEquals("0", one(migrated, "SELECT needsReview FROM attendance_drafts WHERE id = 'd1'"))
        assertEquals(null, one(migrated, "SELECT rosterDigest FROM attendance_drafts WHERE id = 'd1'"))
        assertEquals("PRESENT", one(migrated, "SELECT status FROM attendance_marks WHERE studentId = 's1'"))
        assertEquals("0", one(migrated, "SELECT COUNT(*) FROM roster_snapshots"))
        assertEquals("0", one(migrated, "SELECT COUNT(*) FROM profile_sync"))
        migrated.close()
    }

    @Test
    fun laMigracion2a3ConservaTodosLosDatosYAgregaLaOutboxVacia() {
        helper.createDatabase(dbName, 2).apply {
            seedV2(this)
            close()
        }
        val migrated = helper.runMigrationsAndValidate(dbName, 3, true, EtaDatabase.MIGRATION_2_3)
        try {
            assertV2DataIntact(migrated)
            assertOutboxEmptyAndPresent(migrated)
            // la migracion NO crea operaciones: las capturas anteriores siguen siendo solo borradores
            assertEquals(3, migrated.version)
        } finally {
            migrated.close()
        }
    }

    @Test
    fun laMigracionCompleta1a2a3ConservaLaCapturaDemostracion() {
        helper.createDatabase(dbName, 1).apply {
            execSQL("INSERT INTO profiles (id, displayName, isDemo) VALUES ('p1', 'Demo', 1)")
            execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder) VALUES ('g1', 'p1', '1.º A', 1, 0)")
            execSQL("INSERT INTO students (id, groupId, givenNames, familyName) VALUES ('s1', 'g1', 'Ana', 'Ficticia')")
            execSQL("INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs) VALUES ('d1', 'p1', 'g1', '2026-10-27', 'r1', 1, 1)")
            execSQL("INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES ('d1', 'g1', 's1', 'PRESENT', 5)")
            close()
        }
        val migrated = helper.runMigrationsAndValidate(dbName, 3, true, EtaDatabase.MIGRATION_1_2, EtaDatabase.MIGRATION_2_3)
        try {
            assertEquals("DEMO", one(migrated, "SELECT source FROM profiles WHERE id = 'p1'"))
            assertEquals("PRESENT", one(migrated, "SELECT status FROM attendance_marks WHERE studentId = 's1'"))
            assertEquals("r1", one(migrated, "SELECT requestId FROM attendance_drafts WHERE id = 'd1'"))
            assertOutboxEmptyAndPresent(migrated)
        } finally {
            migrated.close()
        }
    }

    @Test
    fun trasMigrarLaAppLeeLosDatosAnterioresYSigueCapturando() = runBlocking<Unit> {
        helper.createDatabase(dbName, 1).apply {
            execSQL("INSERT INTO profiles (id, displayName, isDemo) VALUES ('p1', 'Demo', 1)")
            execSQL("INSERT INTO school_groups (id, profileId, name, grade, sortOrder) VALUES ('g1', 'p1', '1.º A', 1, 0)")
            execSQL("INSERT INTO students (id, groupId, givenNames, familyName) VALUES ('s1', 'g1', 'Ana', 'Ficticia')")
            close()
        }
        val db = room(EtaDatabase.MIGRATION_1_2, EtaDatabase.MIGRATION_2_3)
        try {
            val repo = LocalAttendanceRepository(db, "p1", MutableClock(), SequentialIds("m"))
            assertEquals(listOf("1.º A"), repo.observeGroups().first().map { it.name })
            val draft = repo.openTodayDraft("g1") as OpenDraftResult.Ready
            assertTrue(repo.setMark(draft.draftId, "s1", AttendanceMark.PRESENT) is SetMarkResult.Saved)
            assertEquals(3, db.openHelper.writableDatabase.version)
        } finally {
            db.close()
        }
    }

    @Test
    fun trasMigrar2a3LaOutboxFuncionaSeCierraYSeReabreConSusOperaciones() = runBlocking<Unit> {
        helper.createDatabase(dbName, 2).apply {
            seedV2(this)
            close()
        }
        val profile = profileOf(deviceA)
        val group = groupOf(deviceA, g1)
        var draft = ""
        var requestId = ""
        // 1.ª apertura: migra, el borrador previo sigue editable, se prepara una operacion local
        room(EtaDatabase.MIGRATION_2_3).let { db ->
            try {
                val repo = LocalAttendanceRepository(db, profile, clock, SequentialIds("m"), access = ProfileAccessGate(db, profile, clock, policy))
                val ready = repo.openTodayDraft(group) as OpenDraftResult.Ready
                draft = ready.draftId
                assertEquals("draft-$deviceA", draft) // el borrador de la instalacion anterior se reutiliza, no se duplica
                assertEquals(SetMarkResult.Saved, repo.setMark(draft, studentOf(deviceA, g1, s2), AttendanceMark.ABSENT))
                val prepared = repo.prepareForSync(draft) as PrepareResult.Prepared
                requestId = prepared.requestId
                assertEquals(OperationState.WAITING_REMOTE_CONTEXT, prepared.state)
                assertEquals(2, prepared.markCount) // la marca previa (v2) y la nueva
                assertTrue(one(db.openHelper.writableDatabase, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_%'")!!.toInt() >= 10)
            } finally {
                db.close() // "se cierra la aplicacion"
            }
        }
        // 2.ª apertura (proceso nuevo): no hay que migrar; todo sigue ahi y el otro perfil no tiene nada
        room(EtaDatabase.MIGRATION_2_3).let { db ->
            try {
                val dao = db.outboxDao()
                val ops = dao.allOf(profile)
                assertEquals(2, ops.size)
                assertEquals(requestId, ops.single { it.kind == "SAVE_MARKS" }.requestId)
                assertEquals(0, dao.count(profileOf(deviceB)))
                val w = db.openHelper.writableDatabase
                // los datos de v2 siguen ahi; solo cambio la marca que se capturo despues (s2: Pendiente -> Ausente)
                assertEquals("6", one(w, "SELECT COUNT(*) FROM students"))
                assertEquals("4", one(w, "SELECT COUNT(*) FROM attendance_drafts"))
                assertEquals("ABSENT", one(w, "SELECT status FROM attendance_marks WHERE studentId = '${studentOf(deviceA, g1, s2)}'"))
                assertEquals("PRESENT", one(w, "SELECT status FROM attendance_marks WHERE studentId = '${studentOf(deviceA, g1, s1)}'"))
                assertEquals("2", one(w, "SELECT COUNT(*) FROM sync_operations"))
                assertEquals("2", one(w, "SELECT COUNT(*) FROM sync_operation_marks"))
            } finally {
                db.close()
            }
        }
    }
}
