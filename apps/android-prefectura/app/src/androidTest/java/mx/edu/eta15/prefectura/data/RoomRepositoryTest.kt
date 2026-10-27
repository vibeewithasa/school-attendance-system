package mx.edu.eta15.prefectura.data

import android.database.sqlite.SQLiteConstraintException
import androidx.room.Room
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SeededGroup
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.seedProfile
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RoomRepositoryTest {
    private lateinit var db: EtaDatabase
    private lateinit var clock: MutableClock
    private lateinit var repo: LocalAttendanceRepository
    private lateinit var groups: List<SeededGroup>

    @Before
    fun setUp() = runBlocking {
        db = EtaDatabase.inMemory(testContext())
        clock = MutableClock()
        groups = db.seedProfile("p1", listOf(3, 2, 0))
        repo = LocalAttendanceRepository(db, "p1", clock, SequentialIds("d"), dateRefreshMs = 50)
    }

    @After
    fun tearDown() = db.close()

    private fun count(table: String): Int =
        db.openHelper.readableDatabase.query(SimpleSQLiteQuery("SELECT COUNT(*) FROM $table")).use {
            it.moveToFirst()
            it.getInt(0)
        }

    private fun execFails(sql: String, vararg args: Any?): Boolean = try {
        db.openHelper.writableDatabase.execSQL(sql, args)
        false
    } catch (e: android.database.SQLException) {
        true
    }

    // ---- Borradores ----

    @Test
    fun crearBorradorGuardaUnaMarcaPendientePorAlumno() = runBlocking {
        val g = groups[0]
        val r = repo.openTodayDraft(g.id) as OpenDraftResult.Ready
        assertTrue(r.created)
        assertEquals(1, count("attendance_drafts"))
        assertEquals(3, count("attendance_marks"))
        val draft = repo.observeTodayDraft(g.id).first()!!
        assertEquals(LocalDate.of(2026, 10, 27), draft.schoolDate)
        assertEquals(3, draft.summary.pending)
        assertEquals(g.studentIds.toSet(), draft.rows.map { it.student.id }.toSet())
    }

    @Test
    fun abrirDeNuevoDevuelveElMismoBorradorSinDuplicar() = runBlocking {
        val g = groups[0]
        val a = repo.openTodayDraft(g.id) as OpenDraftResult.Ready
        val b = repo.openTodayDraft(g.id) as OpenDraftResult.Ready
        assertEquals(a.draftId, b.draftId)
        assertFalse(b.created)
        assertEquals(1, count("attendance_drafts"))
        assertEquals(3, count("attendance_marks"))
    }

    @Test
    fun aperturasConcurrentesCreanUnSoloBorrador() = runBlocking {
        val g = groups[0]
        val results = (1..12).map { async(Dispatchers.IO) { repo.openTodayDraft(g.id) } }.awaitAll()
        assertTrue(results.all { it is OpenDraftResult.Ready })
        assertEquals(1, results.map { (it as OpenDraftResult.Ready).draftId }.toSet().size)
        assertEquals(1, results.count { (it as OpenDraftResult.Ready).created })
        assertEquals(1, count("attendance_drafts"))
        assertEquals(3, count("attendance_marks"))
    }

    @Test
    fun grupoSinAlumnosNoAbreBorrador() = runBlocking {
        assertEquals(OpenDraftResult.EmptyRoster, repo.openTodayDraft(groups[2].id))
        assertEquals(0, count("attendance_drafts"))
    }

    @Test
    fun grupoInexistenteNoAbreBorrador() = runBlocking {
        assertEquals(OpenDraftResult.GroupNotFound, repo.openTodayDraft("no-existe"))
        assertEquals(0, count("attendance_drafts"))
    }

    // ---- Marcas ----

    @Test
    fun marcarPresenteAusenteYQuitarSeGuardaYSeObserva() = runBlocking {
        val g = groups[0]
        val draftId = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        val (s1, s2, s3) = g.studentIds
        assertEquals(SetMarkResult.Saved, repo.setMark(draftId, s1, AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(draftId, s2, AttendanceMark.ABSENT))
        var summary = repo.observeTodayDraft(g.id).first()!!.summary
        assertEquals(Triple(1, 1, 1), Triple(summary.present, summary.absent, summary.pending))
        // modificar una marca y dejar otra pendiente
        assertEquals(SetMarkResult.Saved, repo.setMark(draftId, s1, AttendanceMark.ABSENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(draftId, s2, null))
        summary = repo.observeTodayDraft(g.id).first()!!.summary
        assertEquals(Triple(0, 1, 2), Triple(summary.present, summary.absent, summary.pending))
        assertEquals(3, summary.total) // el padron congelado no cambia
        assertNotNull(s3)
    }

    @Test
    fun unAlumnoDeOtroGrupoNoSePuedeMarcarEnElBorrador() = runBlocking {
        val draftId = (repo.openTodayDraft(groups[0].id) as OpenDraftResult.Ready).draftId
        val foreign = groups[1].studentIds.first()
        assertEquals(SetMarkResult.NotFound, repo.setMark(draftId, foreign, AttendanceMark.PRESENT))
    }

    @Test
    fun elProgresoDeGruposRefleja_lasMarcasDeHoy() = runBlocking {
        val g = groups[0]
        val draftId = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        repo.setMark(draftId, g.studentIds[0], AttendanceMark.PRESENT)
        repo.setMark(draftId, g.studentIds[1], AttendanceMark.ABSENT)
        val row = repo.observeGroups().first().first { it.id == g.id }
        assertEquals(3, row.studentCount)
        assertEquals(2, row.markedToday)
        assertTrue(row.hasDraftToday)
        assertFalse(repo.observeGroups().first().first { it.id == groups[1].id }.hasDraftToday)
    }

    // ---- Fechas ----

    @Test
    fun enSabadoNoSeAbrenListasNuevas() = runBlocking {
        clock.now = MutableClock.SATURDAY
        val r = repo.openTodayDraft(groups[0].id)
        assertEquals(OpenDraftResult.NotSchoolDay(LocalDate.of(2026, 10, 31)), r)
        assertEquals(0, count("attendance_drafts"))
    }

    @Test
    fun trasLaMedianocheElBorradorDeAyerYaNoSeModifica() = runBlocking {
        val g = groups[0]
        val draftId = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        repo.setMark(draftId, g.studentIds[0], AttendanceMark.PRESENT)
        clock.now = MutableClock.WEDNESDAY_AFTER_MIDNIGHT
        assertEquals(SetMarkResult.DraftNotEditable, repo.setMark(draftId, g.studentIds[1], AttendanceMark.PRESENT))
        assertNull(repo.observeTodayDraft(g.id).first()) // hoy (miercoles) aun no hay borrador
        val tomorrow = repo.openTodayDraft(g.id) as OpenDraftResult.Ready
        assertTrue(tomorrow.created)
        assertTrue(tomorrow.draftId != draftId)
        // el de ayer conserva lo capturado
        val kept = db.openHelper.readableDatabase.query(
            SimpleSQLiteQuery("SELECT COUNT(*) FROM attendance_marks WHERE draftId = ? AND status IS NOT NULL", arrayOf(draftId)),
        ).use { it.moveToFirst(); it.getInt(0) }
        assertEquals(1, kept)
    }

    @Test
    fun cambiarElRelojHaciaAtrasNoReabreUnBorradorDeOtroDia() = runBlocking {
        val g = groups[0]
        clock.now = MutableClock.WEDNESDAY_AFTER_MIDNIGHT
        val wed = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        clock.now = MutableClock.TUESDAY // alguien retrasa el reloj
        assertEquals(SetMarkResult.DraftNotEditable, repo.setMark(wed, g.studentIds[0], AttendanceMark.PRESENT))
    }

    // ---- Aislamiento por perfil ----

    @Test
    fun unPerfilNoVeNiModificaDatosDeOtro() = runBlocking {
        val other = db.seedProfile("p2", listOf(4), prefix = "p2")
        val repo2 = LocalAttendanceRepository(db, "p2", clock, SequentialIds("e"))
        assertEquals(listOf("p2-g1"), repo2.observeGroups().first().map { it.id })
        assertEquals(listOf("p1-g1", "p1-g2", "p1-g3"), repo.observeGroups().first().map { it.id })
        assertEquals(OpenDraftResult.GroupNotFound, repo2.openTodayDraft(groups[0].id))
        assertTrue(repo2.observeRoster(groups[0].id).first().isEmpty())
        val draft1 = (repo.openTodayDraft(groups[0].id) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.NotFound, repo2.setMark(draft1, groups[0].studentIds[0], AttendanceMark.PRESENT))
        assertNull(repo2.observeTodayDraft(groups[0].id).first())
        assertEquals(4, repo2.observeRoster(other[0].id).first().size)
    }

    // ---- Integridad en la base ----

    @Test
    fun unaMarcaConAlumnoDeOtroGrupoViolaLaLlaveForanea() = runBlocking {
        val draftId = (repo.openTodayDraft(groups[0].id) as OpenDraftResult.Ready).draftId
        assertTrue(
            execFails(
                "INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES (?, ?, ?, NULL, NULL)",
                draftId, groups[0].id, groups[1].studentIds[0],
            ),
        )
    }

    @Test
    fun noPuedeHaberDosBorradoresDelMismoGrupoYFecha() = runBlocking {
        repo.openTodayDraft(groups[0].id)
        assertTrue(
            execFails(
                "INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs) VALUES ('x', 'p1', ?, '2026-10-27', 'rid-x', 0, 0)",
                groups[0].id,
            ),
        )
        assertEquals(1, count("attendance_drafts"))
    }

    @Test
    fun unAlumnoNoApareceDosVecesEnUnBorrador() = runBlocking {
        val g = groups[0]
        val draftId = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        assertTrue(
            execFails(
                "INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES (?, ?, ?, NULL, NULL)",
                draftId, g.id, g.studentIds[0],
            ),
        )
    }

    @Test
    fun unBorradorDeOtroPerfilNoPuedeApuntarAUnGrupoAjeno() = runBlocking {
        db.seedProfile("p2", listOf(1), prefix = "p2")
        // grupo de p1 con perfil p2: la llave foranea compuesta (groupId, profileId) lo impide
        assertTrue(
            execFails(
                "INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs) VALUES ('y', 'p2', ?, '2026-10-27', 'rid-y', 0, 0)",
                groups[0].id,
            ),
        )
    }

    @Test
    fun soloPendientePresenteYAusenteSonValoresDeMarca() = runBlocking {
        val g = groups[0]
        val draftId = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        assertTrue(execFails("UPDATE attendance_marks SET status = 'LATE' WHERE draftId = ?", draftId))
        assertTrue(
            execFails(
                "INSERT INTO attendance_marks (draftId, groupId, studentId, status, markedAtEpochMs) VALUES (?, ?, ?, 'EXCUSED', NULL)",
                "nuevo", g.id, g.studentIds[0],
            ),
        )
        assertFalse(execFails("UPDATE attendance_marks SET status = 'PRESENT' WHERE draftId = ? AND studentId = ?", draftId, g.studentIds[0]))
    }

    @Test
    fun noSeCreanBorradoresEnSabadoNiDomingoYLaIdentidadEsInmutable() = runBlocking {
        val g = groups[0]
        for (date in listOf("2026-10-31", "2026-11-01", "no-es-fecha")) {
            assertTrue(
                date,
                execFails(
                    "INSERT INTO attendance_drafts (id, profileId, groupId, schoolDate, requestId, createdAtEpochMs, updatedAtEpochMs) VALUES (?, 'p1', ?, ?, ?, 0, 0)",
                    "w-$date", g.id, date, "r-$date",
                ),
            )
        }
        val draftId = (repo.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        assertTrue(execFails("UPDATE attendance_drafts SET schoolDate = '2026-10-26' WHERE id = ?", draftId))
        assertTrue(execFails("UPDATE attendance_drafts SET requestId = 'otro' WHERE id = ?", draftId))
    }

    @Test
    fun elBorradoLocalControladoEliminaTodoEnCascada() = runBlocking {
        repo.openTodayDraft(groups[0].id)
        db.catalogDao().deleteAllProfiles()
        for (t in listOf("profiles", "school_groups", "students", "attendance_drafts", "attendance_marks")) {
            assertEquals(t, 0, count(t))
        }
    }

    @Test
    fun elDaoNoPermiteInsertarDuplicadosPorClavePrimaria() = runBlocking {
        try {
            db.catalogDao().insertProfile(
                mx.edu.eta15.prefectura.data.local.ProfileEntity("p1", "duplicado", isDemo = true),
            )
            fail("Debio rechazar el perfil duplicado")
        } catch (_: SQLiteConstraintException) {
        }
    }

    // ---- Persistencia ----

    @Test
    fun losBorradoresSobrevivenAlCerrarYReabrirLaBase() = runBlocking {
        val name = "persist-test.db"
        val ctx = testContext()
        ctx.deleteDatabase(name)
        fun open() = Room.databaseBuilder(ctx, EtaDatabase::class.java, name).addCallback(EtaDatabase.integrityCallback).build()
        var file = open()
        val g = file.seedProfile("pp", listOf(2)).first()
        val r1 = LocalAttendanceRepository(file, "pp", clock, SequentialIds("f"))
        val draftId = (r1.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId
        r1.setMark(draftId, g.studentIds[0], AttendanceMark.ABSENT)
        file.close() // como cerrar la app
        file = open()
        val r2 = LocalAttendanceRepository(file, "pp", clock, SequentialIds("g"))
        val reopened = r2.observeTodayDraft(g.id).first()!!
        assertEquals(draftId, reopened.draftId)
        assertEquals(AttendanceMark.ABSENT, reopened.rows.first { it.student.id == g.studentIds[0] }.mark)
        assertEquals(1, reopened.summary.pending)
        assertEquals(draftId, (r2.openTodayDraft(g.id) as OpenDraftResult.Ready).draftId) // sigue sin duplicarse
        file.close()
        assertTrue(ctx.deleteDatabase(name))
    }
}
