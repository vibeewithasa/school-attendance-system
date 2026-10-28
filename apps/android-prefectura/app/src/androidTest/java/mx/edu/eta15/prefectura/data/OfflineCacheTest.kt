package mx.edu.eta15.prefectura.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.SequentialIds
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.local.ProfileEntity
import mx.edu.eta15.prefectura.domain.AccessBlock
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.OfflineAccess
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.seedProfile
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cache offline del servidor de PRUEBAS en Room real (instrumentada). Todo con datos FICTICIOS. Cubre: descarga todo-o-nada,
 * aislamiento por identidad, separacion demo/sandbox, revocaciones, cambios de padron, vigencia offline de demostracion, reloj,
 * fin de semana y borrado explicito. La persistencia cifrada tras reiniciar se prueba en [OfflineCacheEncryptedTest].
 */
@RunWith(AndroidJUnit4::class)
class OfflineCacheTest {
    private val clock = MutableClock()
    private val policy = OfflinePolicy(Duration.ofMinutes(10))
    private lateinit var db: EtaDatabase
    private lateinit var store: OfflineCacheStore

    private val deviceA = "dddddddd-0000-4000-8000-00000000000a"
    private val deviceB = "dddddddd-0000-4000-8000-00000000000b"
    private val g1 = "11111111-0000-4000-8000-000000000001"
    private val g2 = "22222222-0000-4000-8000-000000000002"
    private val s1 = "51111111-0000-4000-8000-000000000001"
    private val s2 = "52222222-0000-4000-8000-000000000002"
    private val s3 = "53333333-0000-4000-8000-000000000003"
    private val s4 = "54444444-0000-4000-8000-000000000004"
    private val day = "2026-10-27"

    @Before
    fun setUp() {
        db = EtaDatabase.inMemory(testContext())
        store = OfflineCacheStore(db, clock, policy)
    }

    @After
    fun tearDown() = db.close()

    private fun student(id: String, given: String) = DownloadedStudent(id, given, "Ficticio")

    private fun group(id: String, label: String, vararg students: DownloadedStudent) =
        DownloadedGroup(id, label, 1, label.takeLast(1), "matutino", "aaaaaaaa-0000-4000-8000-0000000000aa", "2026-2027", students.toList())

    private fun spec(device: String, vararg groups: DownloadedGroup, revoked: Set<String> = emptySet(), serverDate: String = day) =
        DownloadSpec(device, "Prefectura ficticia", serverDate, groups.toList(), revoked)

    private fun repo(device: String, ids: SequentialIds = SequentialIds("d")): LocalAttendanceRepository {
        val profile = SandboxIds.profile(device)
        return LocalAttendanceRepository(db, profile, clock, ids, access = ProfileAccessGate(db, profile, clock, policy))
    }

    private suspend fun downloadBasic(device: String = deviceA) =
        store.commit(
            spec(
                device,
                group(g1, "1.º A", student(s1, "Ana"), student(s2, "Beto")),
                group(g2, "1.º B", student(s3, "Carla")),
            ),
        )

    private fun gid(device: String, remote: String) = SandboxIds.group(SandboxIds.profile(device), remote)

    // ---------------------------------------------------------------- descarga y consulta

    @Test
    fun descargaGuardaGruposPadronYMomentoDeDescarga() = runBlocking {
        val r = downloadBasic()
        assertEquals(CommitResult(2, 0, 0, 0), r)
        val repo = repo(deviceA)
        val groups = repo.observeGroups().first()
        assertEquals(listOf("1.º A", "1.º B"), groups.map { it.name })
        assertEquals(listOf(2, 1), groups.map { it.studentCount })
        assertTrue(groups.all { it.downloadedAt == Instant.ofEpochMilli(clock.millis()) && !it.revoked })
        assertEquals(listOf("Ana Ficticio", "Beto Ficticio"), repo.observeRoster(gid(deviceA, g1)).first().map { it.displayName })
        val sync = repo.observeSyncInfo().first()!!
        assertEquals(Instant.ofEpochMilli(clock.millis()), sync.lastDownloadAt)
        assertEquals(day, sync.serverSchoolDate.toString())
        assertTrue(repo.observeAccess().first() is OfflineAccess.Active)
    }

    @Test
    fun descargaRepetidaEsIdempotenteYNoMarcaRevisiones() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val draft = (repo.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        repo.setMark(draft, SandboxIds.student(gid(deviceA, g1), s1), AttendanceMark.PRESENT)
        val again = downloadBasic()
        assertEquals(CommitResult(2, 0, 0, 0), again)
        assertEquals(1, db.cacheDao().draftCount(SandboxIds.profile(deviceA)))
        assertFalse(repo.observeGroups().first().any { it.needsReview })
    }

    // ---------------------------------------------------------------- todo o nada

    @Test
    fun unaDescargaInvalidaNoCambiaNadaDeLaCacheAnterior() = runBlocking {
        downloadBasic()
        val before = repo(deviceA).observeGroups().first()
        val bad = spec(
            deviceA,
            group(g1, "1.º A", student(s1, "Ana"), student(s1, "Ana repetida")), // alumno duplicado
            group(g2, "1.º B", student(s3, "Carla")),
        )
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.commit(bad) } }
        assertEquals(before, repo(deviceA).observeGroups().first())
        assertEquals(listOf("Ana Ficticio", "Beto Ficticio"), repo(deviceA).observeRoster(gid(deviceA, g1)).first().map { it.displayName })
        val dupGroups = spec(deviceA, group(g1, "1.º A", student(s1, "Ana")), group(g1, "1.º A", student(s2, "Beto")))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.commit(dupGroups) } }
        assertEquals(before, repo(deviceA).observeGroups().first())
    }

    // ---------------------------------------------------------------- aislamiento

    @Test
    fun dosIdentidadesNoVenLosDatosDeLaOtraAunqueCompartanElGrupoDelServidor() = runBlocking {
        downloadBasic(deviceA)
        store.commit(spec(deviceB, group(g1, "1.º A", student(s1, "Ana"), student(s4, "Dario"))))
        val a = repo(deviceA)
        val b = repo(deviceB)
        assertEquals(2, a.observeGroups().first().size)
        assertEquals(1, b.observeGroups().first().size)
        assertEquals(listOf("Ana Ficticio", "Dario Ficticio"), b.observeRoster(gid(deviceB, g1)).first().map { it.displayName })
        // el grupo de B no existe para A ni al reves, ni siquiera con el identificador local del otro
        assertEquals(OpenDraftResult.GroupNotFound, a.openTodayDraft(gid(deviceB, g1)))
        assertTrue(a.observeRoster(gid(deviceB, g1)).first().isEmpty())
        val draftB = (b.openTodayDraft(gid(deviceB, g1)) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.NotFound, a.setMark(draftB, SandboxIds.student(gid(deviceB, g1), s1), AttendanceMark.ABSENT))
    }

    @Test
    fun laDemostracionYLosDatosDescargadosSonPerfilesDistintos() = runBlocking {
        val demo = db.seedProfile("demo-perfil", listOf(3))
        downloadBasic()
        val sandbox = repo(deviceA)
        val demoRepo = LocalAttendanceRepository(db, "demo-perfil", clock, SequentialIds("x"))
        assertEquals(2, sandbox.observeGroups().first().size)
        assertEquals(1, demoRepo.observeGroups().first().size)
        assertEquals(OpenDraftResult.GroupNotFound, sandbox.openTodayDraft(demo[0].id))
        assertEquals(OpenDraftResult.GroupNotFound, demoRepo.openTodayDraft(gid(deviceA, g1)))
        assertEquals(OfflineAccess.NotApplicable, demoRepo.observeAccess().first())
        assertNull(demoRepo.observeSyncInfo().first())
        // el borrado explicito solo alcanza perfiles descargados: la demostracion no se puede purgar por esta via
        assertEquals(0, db.cacheDao().purgeSandboxProfile("demo-perfil"))
        assertEquals(1, demoRepo.observeGroups().first().size)
    }

    // ---------------------------------------------------------------- captura sin conexion

    @Test
    fun laCapturaSeGuardaEnRoomConElPadronDeReferenciaYLosPendientesSeConservan() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val open = repo.openTodayDraft(g) as OpenDraftResult.Ready
        assertEquals(SetMarkResult.Saved, repo.setMark(open.draftId, SandboxIds.student(g, s1), AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(open.draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT))
        val draft = repo.observeTodayDraft(g).first()!!
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT), draft.rows.map { it.mark })
        assertEquals(1, db.cacheDao().draftCount(SandboxIds.profile(deviceA)))
        assertEquals(db.catalogDao().rosterDigestOf(g), db.draftDao().findDraft(SandboxIds.profile(deviceA), open.draftId)!!.rosterDigest)
        // un alumno sin marca sigue Pendiente
        assertEquals(SetMarkResult.Saved, repo.setMark(open.draftId, SandboxIds.student(g, s2), null))
        assertEquals(listOf(AttendanceMark.PRESENT, null), repo.observeTodayDraft(g).first()!!.rows.map { it.mark })
        // el identificador de la operacion es estable (preparacion del futuro requestId; hoy no se envia)
        assertEquals(draft.requestId, repo.observeTodayDraft(g).first()!!.requestId)
        assertFalse(draft.needsReview)
    }

    @Test
    fun enFinDeSemanaNoSeAbreUnaListaNuevaAunConAccesoVigente() = runBlocking {
        clock.now = MutableClock.SATURDAY
        store.commit(spec(deviceA, group(g1, "1.º A", student(s1, "Ana")), serverDate = "2026-10-31"))
        val repo = repo(deviceA)
        assertTrue(repo.observeAccess().first() is OfflineAccess.Active)
        assertTrue(repo.openTodayDraft(gid(deviceA, g1)) is OpenDraftResult.NotSchoolDay)
    }

    // ---------------------------------------------------------------- padron cambiado
    @Test
    fun siElPadronCambiaElBorradorSeMarcaParaRevisionSinModificarSusMarcas() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val draftId = (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId
        repo.setMark(draftId, SandboxIds.student(g, s1), AttendanceMark.PRESENT)
        repo.setMark(draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT)
        val digestBefore = db.draftDao().findDraft(SandboxIds.profile(deviceA), draftId)!!.rosterDigest
        // despues: Beto fue dado de baja o transferido y llego Dario
        val r = store.commit(
            spec(deviceA, group(g1, "1.º A", student(s1, "Ana"), student(s4, "Dario")), group(g2, "1.º B", student(s3, "Carla"))),
        )
        assertEquals(1, r.changedRosters)
        assertEquals(1, r.draftsFlagged)
        // el padron actual ya no incluye a Beto y si a Dario...
        assertEquals(listOf("Ana Ficticio", "Dario Ficticio"), repo.observeRoster(g).first().map { it.displayName })
        // ... pero el borrador conserva EXACTAMENTE lo capturado (incluido Beto), sin cambios silenciosos
        val draft = repo.observeTodayDraft(g).first()!!
        assertEquals(listOf("Ana Ficticio", "Beto Ficticio"), draft.rows.map { it.student.displayName })
        assertEquals(listOf(AttendanceMark.PRESENT, AttendanceMark.ABSENT), draft.rows.map { it.mark })
        assertTrue(draft.needsReview)
        assertEquals("ROSTER_CHANGED", draft.reviewReason)
        assertTrue(repo.observeGroups().first().first { it.id == g }.needsReview)
        // la referencia del padron usado es historica: no cambia
        assertEquals(digestBefore, db.draftDao().findDraft(SandboxIds.profile(deviceA), draftId)!!.rosterDigest)
        // y no se puede reescribir
        val failure = runCatching { db.openHelper.writableDatabase.execSQL("UPDATE attendance_drafts SET rosterDigest = 'otro' WHERE id = '$draftId'") }
        assertTrue(failure.isFailure)
    }

    @Test
    fun alumnoTransferidoDeGrupoQuedaConIdentificadoresLocalesDistintosPorGrupo() = runBlocking {
        downloadBasic()
        // Beto pasa del grupo A al B
        store.commit(spec(deviceA, group(g1, "1.º A", student(s1, "Ana")), group(g2, "1.º B", student(s3, "Carla"), student(s2, "Beto"))))
        val repo = repo(deviceA)
        assertEquals(listOf("Ana Ficticio"), repo.observeRoster(gid(deviceA, g1)).first().map { it.displayName })
        assertEquals(listOf("Beto Ficticio", "Carla Ficticio"), repo.observeRoster(gid(deviceA, g2)).first().map { it.displayName })
        assertEquals(setOf(SandboxIds.student(gid(deviceA, g2), s2)), repo.observeRoster(gid(deviceA, g2)).first().map { it.id }.filter { it.endsWith(s2) }.toSet())
    }

    // ---------------------------------------------------------------- revocaciones

    @Test
    fun unGrupoQuePierdeLaAsignacionSeBloqueaConservandoBorradoresYMarcas() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val draftId = (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId
        repo.setMark(draftId, SandboxIds.student(g, s1), AttendanceMark.PRESENT)
        // al reconectar el servidor ya no devuelve el grupo A
        val r = store.commit(spec(deviceA, group(g2, "1.º B", student(s3, "Carla"))))
        assertEquals(1, r.groupsRevoked)
        assertEquals(1, r.draftsFlagged)
        val groups = repo.observeGroups().first()
        assertTrue(groups.first { it.id == g }.revoked)
        assertFalse(groups.first { it.id == gid(deviceA, g2) }.revoked)
        assertTrue("padron ajeno bloqueado", repo.observeRoster(g).first().isEmpty())
        assertEquals(OpenDraftResult.GroupRevoked, repo.openTodayDraft(g))
        assertEquals(SetMarkResult.GroupRevoked, repo.setMark(draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT))
        // las marcas siguen ahi (el borrador se conserva) y lo dice como pendiente de revision
        val draft = repo.observeTodayDraft(g).first()!!
        assertEquals(AttendanceMark.PRESENT, draft.rows.first { it.student.id.endsWith(s1) }.mark)
        assertTrue(draft.needsReview)
        assertEquals("GROUP_REVOKED", draft.reviewReason)
        // la base misma rechaza capturar en un grupo revocado
        assertTrue(runCatching { db.draftDao().updateMark(draftId, SandboxIds.student(g, s2), "ABSENT", 1L) }.isFailure)
    }

    @Test
    fun unGrupoQueVuelveASerAutorizadoSeReactivaSinPerderBorradores() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val draftId = (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId
        store.commit(spec(deviceA, group(g2, "1.º B", student(s3, "Carla")))) // A revocado
        downloadBasic() // A vuelve
        assertFalse(repo.observeGroups().first().first { it.id == g }.revoked)
        assertEquals(draftId, (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId)
    }

    @Test
    fun elServidorPuedeInformarGrupoNoEncontradoDuranteLaDescarga() = runBlocking {
        downloadBasic()
        val r = store.commit(spec(deviceA, group(g1, "1.º A", student(s1, "Ana")), revoked = setOf(g2)))
        assertEquals(1, r.groupsRevoked)
        assertTrue(repo(deviceA).observeGroups().first().first { it.id == gid(deviceA, g2) }.revoked)
    }

    @Test
    fun dispositivoRevocadoBloqueaTodoYConservaLosBorradores() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val draftId = (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId
        repo.setMark(draftId, SandboxIds.student(g, s1), AttendanceMark.PRESENT)
        assertTrue(store.markAuthState(deviceA, OfflineCacheStore.AUTH_DEVICE_REVOKED))
        assertEquals(OfflineAccess.Blocked(AccessBlock.DEVICE_REVOKED), repo.observeAccess().first())
        assertEquals(OpenDraftResult.AccessBlocked(AccessBlock.DEVICE_REVOKED), repo.openTodayDraft(g))
        assertEquals(SetMarkResult.AccessBlocked(AccessBlock.DEVICE_REVOKED), repo.setMark(draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT))
        assertTrue(repo.observeRoster(g).first().isEmpty())
        assertEquals(1, db.cacheDao().draftCount(SandboxIds.profile(deviceA)))
        assertEquals(AttendanceMark.PRESENT, db.draftDao().observeRows(draftId).first().first { it.studentId.endsWith(s1) }.status?.let { AttendanceMark.valueOf(it) })
        // la cuenta bloqueada se distingue
        store.markAuthState(deviceA, OfflineCacheStore.AUTH_ACCOUNT_BLOCKED)
        assertEquals(OfflineAccess.Blocked(AccessBlock.ACCOUNT_BLOCKED), repo.observeAccess().first())
        // otra identidad no resulta afectada
        downloadBasic(deviceB)
        assertTrue(repo(deviceB).observeAccess().first() is OfflineAccess.Active)
        assertFalse(store.markAuthState("dddddddd-0000-4000-8000-0000000000ff", OfflineCacheStore.AUTH_DEVICE_REVOKED)) // perfil inexistente
    }

    // ---------------------------------------------------------------- vigencia y reloj

    @Test
    fun alVencerLaVigenciaDeDemostracionSeBloqueaLoProtegidoSinBorrarNada() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val draftId = (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId
        repo.setMark(draftId, SandboxIds.student(g, s1), AttendanceMark.PRESENT)
        clock.now = clock.now.plus(Duration.ofMinutes(9))
        assertTrue(repo.observeAccess().first() is OfflineAccess.Active)
        clock.now = clock.now.plus(Duration.ofMinutes(2)) // 11 min > 10 min de vigencia
        assertEquals(OfflineAccess.Blocked(AccessBlock.EXPIRED), repo.observeAccess().first())
        assertEquals(OpenDraftResult.AccessBlocked(AccessBlock.EXPIRED), repo.openTodayDraft(g))
        assertEquals(SetMarkResult.AccessBlocked(AccessBlock.EXPIRED), repo.setMark(draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT))
        assertTrue(repo.observeRoster(g).first().isEmpty())
        // nada se borro: el borrador y sus marcas siguen y los grupos siguen listados
        assertEquals(1, db.cacheDao().draftCount(SandboxIds.profile(deviceA)))
        assertEquals(2, repo.observeGroups().first().size)
        // reconectar y volver a validar renueva la vigencia
        downloadBasic()
        assertTrue(repo.observeAccess().first() is OfflineAccess.Active)
        assertTrue(repo.setMark(draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT) is SetMarkResult.Saved)
    }

    @Test
    fun unaSesionMovilVencidaNoEsUnaConcesionOfflineYElRelojAtrasadoSeDetecta() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        val g = gid(deviceA, g1)
        val draftId = (repo.openTodayDraft(g) as OpenDraftResult.Ready).draftId // registra el instante visto
        repo.setMark(draftId, SandboxIds.student(g, s1), AttendanceMark.PRESENT)
        // el telefono "retrocede" 1 hora: no se confia en la fecha
        clock.now = clock.now.minus(Duration.ofHours(1))
        assertEquals(OfflineAccess.Blocked(AccessBlock.CLOCK_SUSPECT), repo.observeAccess().first())
        assertEquals(SetMarkResult.AccessBlocked(AccessBlock.CLOCK_SUSPECT), repo.setMark(draftId, SandboxIds.student(g, s2), AttendanceMark.ABSENT))
        // una diferencia pequena (dentro de la tolerancia) no bloquea
        clock.now = clock.now.plus(Duration.ofHours(1)).minus(Duration.ofSeconds(30))
        assertTrue(repo.observeAccess().first() is OfflineAccess.Active)
    }

    @Test
    fun laFechaDelTelefonoDistintaALaDelServidorSeMarcaComoNoConfirmada() = runBlocking {
        downloadBasic()
        val repo = repo(deviceA)
        assertEquals(true, (repo.observeAccess().first() as OfflineAccess.Active).dateConfirmed)
        clock.now = clock.now.plus(Duration.ofHours(8)) // cruza la medianoche en Mazatlan, dentro de la vigencia de 10 min? no: se amplia
        val longPolicy = OfflinePolicy(Duration.ofDays(1))
        val longStore = OfflineCacheStore(db, clock, longPolicy)
        longStore.commit(spec(deviceB, group(g1, "1.º A", student(s1, "Ana")), serverDate = day))
        val repoB = LocalAttendanceRepository(db, SandboxIds.profile(deviceB), clock, SequentialIds("b"), access = ProfileAccessGate(db, SandboxIds.profile(deviceB), clock, longPolicy))
        clock.now = clock.now.plus(Duration.ofHours(10))
        assertEquals(false, (repoB.observeAccess().first() as OfflineAccess.Active).dateConfirmed)
    }

    // ---------------------------------------------------------------- borrado explicito

    @Test
    fun elBorradoDeLosDatosDescargadosEsExplicitoYSoloAfectaAEseDispositivo() = runBlocking {
        downloadBasic(deviceA)
        downloadBasic(deviceB)
        val repoA = repo(deviceA)
        val draft = (repoA.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        repoA.setMark(draft, SandboxIds.student(gid(deviceA, g1), s1), AttendanceMark.PRESENT)
        assertTrue(store.hasCache(deviceA))
        assertTrue(store.purge(deviceA))
        assertFalse(store.hasCache(deviceA))
        assertEquals(0, db.cacheDao().draftCount(SandboxIds.profile(deviceA)))
        assertTrue(store.hasCache(deviceB)) // la otra identidad intacta
        assertEquals(2, repo(deviceB).observeGroups().first().size)
        assertNotNull(db.cacheDao().syncOf(SandboxIds.profile(deviceB)))
        assertNull(db.cacheDao().syncOf(SandboxIds.profile(deviceA)))
    }

    @Test
    fun noSePuedeConvertirUnPerfilDemoEnDescargadoNiViceversa() = runBlocking {
        db.catalogDao().insertProfile(ProfileEntity(SandboxIds.profile(deviceA), "Falso", isDemo = true))
        // un perfil con ese identificador que no es SANDBOX: el borrado explicito no lo toca
        assertEquals(0, db.cacheDao().purgeSandboxProfile(SandboxIds.profile(deviceA)))
        Unit
    }
}
