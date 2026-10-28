package mx.edu.eta15.prefectura.data

import android.database.sqlite.SQLiteConstraintException
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Duration
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mx.edu.eta15.prefectura.MutableClock
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.OperationKind
import mx.edu.eta15.prefectura.domain.OperationState
import mx.edu.eta15.prefectura.domain.OutboxCanonical
import mx.edu.eta15.prefectura.domain.OutboxReasons
import mx.edu.eta15.prefectura.domain.PrepareResult
import mx.edu.eta15.prefectura.domain.Refusal
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.domain.WireMark
import mx.edu.eta15.prefectura.testContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * OUTBOX local (esquema Room v3) en Room real. Todo con datos FICTICIOS; ningun codigo de esta clase usa red. Los estados que en el
 * futuro dependeran del transporte (SENDING, ACKNOWLEDGED...) se SIMULAN con las transiciones de [OutboxStore] que solo existen
 * para pruebas.
 */
@RunWith(AndroidJUnit4::class)
class OutboxStoreTest {
    private val clock = MutableClock()
    private val policy = OfflinePolicy(Duration.ofMinutes(10))
    private lateinit var db: EtaDatabase
    private lateinit var cache: OfflineCacheStore
    private lateinit var outbox: OutboxStore

    private val deviceA = "dddddddd-0000-4000-8000-00000000000a"
    private val deviceB = "dddddddd-0000-4000-8000-00000000000b"
    private val g1 = "11111111-0000-4000-8000-000000000001"
    private val g2 = "22222222-0000-4000-8000-000000000002"
    private val s1 = "51111111-0000-4000-8000-0000000000a1"
    private val s2 = "52222222-0000-4000-8000-0000000000a2"
    private val s3 = "53333333-0000-4000-8000-0000000000a3"
    private val s4 = "54444444-0000-4000-8000-0000000000a4"
    private val tuesday = "2026-10-27"

    /** UUID deterministas, en minuscula, como los del servidor. */
    private class UuidIds(private val seed: String = "ob") : IdGenerator {
        private var n = 0

        override fun newId(): String = UUID.nameUUIDFromBytes("$seed-${++n}".toByteArray()).toString()
    }

    @Before
    fun setUp() {
        db = EtaDatabase.inMemory(testContext())
        cache = OfflineCacheStore(db, clock, policy)
        outbox = OutboxStore(db, clock, UuidIds())
    }

    @After
    fun tearDown() = db.close()

    private fun student(id: String, given: String) = DownloadedStudent(id, given, "Ficticio")

    private fun group(id: String, label: String, vararg students: DownloadedStudent) =
        DownloadedGroup(id, label, 1, label.takeLast(1), "matutino", "aaaaaaaa-0000-4000-8000-0000000000aa", "2026-2027", students.toList())

    private fun spec(device: String, vararg groups: DownloadedGroup, revoked: Set<String> = emptySet(), serverDate: String = tuesday) =
        DownloadSpec(device, "Prefectura ficticia", serverDate, groups.toList(), revoked)

    private fun gid(device: String, remote: String) = SandboxIds.group(SandboxIds.profile(device), remote)

    private fun sid(device: String, remoteGroup: String, remoteStudent: String) = SandboxIds.student(gid(device, remoteGroup), remoteStudent)

    private val idsByDevice = mutableMapOf<String, IdGenerator>()

    private fun repo(device: String, ids: IdGenerator = idsByDevice.getOrPut(device) { UuidIds("r-$device") }): LocalAttendanceRepository {
        val profile = SandboxIds.profile(device)
        return LocalAttendanceRepository(db, profile, clock, ids, access = ProfileAccessGate(db, profile, clock, policy))
    }

    private suspend fun download(device: String = deviceA, serverDate: String = tuesday) = cache.commit(
        spec(
            device,
            group(g1, "1.º A", student(s1, "Ana"), student(s2, "Beto"), student(s3, "Carla")),
            group(g2, "1.º B", student(s4, "Diana")),
            serverDate = serverDate,
        ),
    )

    /** Abre el borrador de hoy del grupo 1 y marca s1 Presente y s2 Ausente (s3 queda Pendiente). */
    private suspend fun capture(repo: LocalAttendanceRepository, device: String = deviceA): String {
        val draft = (repo.openTodayDraft(gid(device, g1)) as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, sid(device, g1, s1), AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, sid(device, g1, s2), AttendanceMark.ABSENT))
        return draft
    }

    private fun ops(device: String = deviceA, remote: String = g1, date: String = tuesday) =
        runBlocking { outbox.operationsOf(SandboxIds.profile(device), gid(device, remote), date) }

    private fun state(op: mx.edu.eta15.prefectura.data.local.SyncOperationEntity) = OperationState.valueOf(op.state)

    private fun sql(statement: String) = db.openHelper.writableDatabase.execSQL(statement)

    private fun scalar(query: String): String? =
        db.openHelper.readableDatabase.query(query).use { c -> if (c.moveToFirst()) c.getString(0) else null }

    private suspend fun prepared(repo: LocalAttendanceRepository, draft: String) = repo.prepareForSync(draft) as PrepareResult.Prepared

    // ------------------------------------------------------------------------------------- intencion y atomicidad

    @Test
    fun cambiarUnaMarcaCreaLaIntencionEnLaMismaTransaccion() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = (repo.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        assertTrue(ops().isEmpty()) // sin marcas no hay nada que preparar
        repo.setMark(draft, sid(deviceA, g1, s1), AttendanceMark.PRESENT)
        val intent = ops().single()
        assertEquals(OperationState.LOCAL_ONLY, state(intent))
        assertEquals(OperationKind.SAVE_MARKS.name, intent.kind)
        assertNull(intent.requestId) // sin identidad de red: es solo una intencion
        assertNull(intent.contentHash)
        assertEquals(g1, intent.remoteGroupId)
        assertEquals(SandboxIds.profile(deviceA), intent.profileId)
        assertEquals(deviceA, intent.deviceId)
        // mas marcas NO crean otra intencion
        repo.setMark(draft, sid(deviceA, g1, s2), AttendanceMark.ABSENT)
        assertEquals(1, ops().size)
        // volver al estado de antes retira la intencion (es desechable)
        repo.setMark(draft, sid(deviceA, g1, s1), null)
        repo.setMark(draft, sid(deviceA, g1, s2), null)
        assertTrue(ops().isEmpty())
        val summary = repo.observeOutbox(gid(deviceA, g1)).first()!!
        assertEquals(0, summary.localMarks)
        assertFalse(summary.unsealedChanges)
    }

    @Test
    fun laDemostracionLocalNoTieneOutbox() = runBlocking<Unit> {
        db.cacheDao().upsertProfile(
            mx.edu.eta15.prefectura.data.local.ProfileEntity("demo", "Demo", isDemo = true),
        )
        db.catalogDao().insertGroups(listOf(mx.edu.eta15.prefectura.data.local.GroupEntity("dg", "demo", "1.º A", 1, 0)))
        db.catalogDao().insertStudents(listOf(mx.edu.eta15.prefectura.data.local.StudentEntity("ds", "dg", "Ana", "Ficticia")))
        val demo = LocalAttendanceRepository(db, "demo", clock, UuidIds("demo"))
        val draft = (demo.openTodayDraft("dg") as OpenDraftResult.Ready).draftId
        assertEquals(SetMarkResult.Saved, demo.setMark(draft, "ds", AttendanceMark.PRESENT))
        assertEquals(0, db.outboxDao().count("demo"))
        assertEquals(PrepareResult.Refused(Refusal.NotSandbox), demo.prepareForSync(draft))
        assertNull(demo.observeOutbox("dg").first())
        // y la base lo impide aunque alguien lo intente por otro camino: la demostracion no puede convertirse en escritura real
        assertThrows(SQLiteConstraintException::class.java) {
            sql(
                """
                INSERT INTO sync_operations (id, profileId, deviceId, groupId, remoteGroupId, schoolDate, draftId, kind, seq, state, createdAtEpochMs, updatedAtEpochMs)
                VALUES ('x', 'demo', 'demo', 'dg', 'dg', '$tuesday', '$draft', 'SAVE_MARKS', 1, 'LOCAL_ONLY', 1, 1)
                """.trimIndent(),
            )
        }
    }

    // ------------------------------------------------------------------------------------------------------- sellado

    @Test
    fun prepararSellaUnaOperacionCompletaConPayloadMinimoEnMinusculas() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val result = prepared(repo, draft)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, result.state) // falta la lista del servidor: NO READY
        assertEquals(OutboxReasons.WAITING_OPEN, result.reason)
        assertEquals(2, result.markCount)

        val all = ops()
        assertEquals(setOf(OperationKind.OPEN.name, OperationKind.SAVE_MARKS.name), all.map { it.kind }.toSet())
        val open = all.single { it.kind == OperationKind.OPEN.name }
        val save = all.single { it.kind == OperationKind.SAVE_MARKS.name }
        // OPEN: se identifica por grupo y fecha, sin requestId ni payload; ya esta completa
        assertEquals(OperationState.READY, state(open))
        assertNull(open.requestId)
        assertEquals(g1, open.remoteGroupId)
        assertEquals(tuesday, open.schoolDate)
        // SAVE_MARKS: identidad sellada, dependencia explicita y SIN contexto remoto inventado
        assertEquals(result.requestId, save.requestId)
        assertEquals(result.requestId, result.requestId.lowercase())
        assertEquals(open.id, save.dependsOnOperationId)
        assertNull(save.serverDayId)
        assertNull(save.expectedRevision)
        assertEquals(2, save.markCount)
        assertEquals(OutboxCanonical.SCHEMA_VERSION, save.schemaVersion)
        assertEquals("SERVER_CONFIRMED", save.dateProvenance)
        val payload = outbox.payloadOf(save.id)
        assertEquals(listOf(WireMark(s1, "present"), WireMark(s2, "absent")), payload) // s3 Pendiente NO viaja
        assertEquals(OutboxCanonical.marksHash(payload), save.contentHash)
        // los datos locales siguen intactos y editables
        assertEquals(1, repo.observeTodayDraft(gid(deviceA, g1)).first()!!.summary.pending)
        assertFalse(repo.observeOutbox(gid(deviceA, g1)).first()!!.unsealedChanges)
    }

    @Test
    fun prepararDosVecesSinCambiosNoCreaOtraOperacionNiOtroRequestId() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val first = prepared(repo, draft)
        val before = ops()
        val second = repo.prepareForSync(draft)
        assertTrue(second is PrepareResult.AlreadyPrepared)
        assertEquals(first.operationId, (second as PrepareResult.AlreadyPrepared).operationId)
        assertEquals(before, ops())
        assertEquals(1, ops().count { it.requestId == first.requestId })
    }

    @Test
    fun sinMarcasNoHayNadaQuePreparar() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = (repo.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        assertEquals(PrepareResult.Refused(Refusal.NothingToPrepare), repo.prepareForSync(draft))
        assertTrue(ops().isEmpty())
    }

    @Test
    fun unaEdicionPosteriorConservaLaOperacionSelladaYRegistraLaNuevaIntencion() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val first = prepared(repo, draft)
        val sealedBefore = ops().single { it.kind == "SAVE_MARKS" }
        val payloadBefore = outbox.payloadOf(first.operationId)
        // la prefecta cambia una marca despues de preparar
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, sid(deviceA, g1, s1), AttendanceMark.ABSENT))
        val afterEdit = ops()
        // lo sellado NO cambio ni un bit...
        assertEquals(sealedBefore, afterEdit.single { it.id == first.operationId })
        assertEquals(payloadBefore, outbox.payloadOf(first.operationId))
        // ...y la edicion quedo registrada como una NUEVA intencion sin sellar (sin segunda operacion READY)
        val intent = afterEdit.single { it.state == OperationState.LOCAL_ONLY.name }
        assertNull(intent.requestId)
        assertTrue(repo.observeOutbox(gid(deviceA, g1)).first()!!.unsealedChanges)
        assertEquals(0, afterEdit.count { it.kind == "SAVE_MARKS" && it.state == OperationState.READY.name })
        // al preparar de nuevo: otra operacion con OTRO requestId; la anterior (sin enviar) queda reemplazada y CONSERVADA
        val second = prepared(repo, draft)
        assertNotEquals(first.requestId, second.requestId)
        assertEquals(intent.id, second.operationId) // la intencion se sello: no hay una operacion extra
        val old = ops().single { it.id == first.operationId }
        assertEquals(OperationState.SUPERSEDED.name, old.state)
        assertEquals(second.operationId, old.supersededByOperationId)
        assertEquals(old.requestId, first.requestId) // no se reutiliza ni se borra
        assertEquals(1, ops().count { it.kind == "SAVE_MARKS" && !state(it).isTerminal })
        assertEquals(WireMark(s1, "absent"), outbox.payloadOf(second.operationId).first())
    }

    @Test
    fun unaOperacionYaSelladaEsInmutableEnLaBase() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val op = prepared(repo, draft).operationId
        // identidad sellada
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET requestId = 'otro' WHERE id = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET contentHash = 'x' WHERE id = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET markCount = 9 WHERE id = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET dateProvenance = 'DEVICE_UNCONFIRMED' WHERE id = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET groupId = 'otro' WHERE id = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET profileId = 'sbx.otro' WHERE id = '$op'") }
        // payload sellado
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operation_marks SET status = 'absent' WHERE operationId = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("DELETE FROM sync_operation_marks WHERE operationId = '$op'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("INSERT INTO sync_operation_marks (operationId, studentRemoteId, status) VALUES ('$op', '$s3', 'present')") }
        // ninguna operacion sellada se borra
        assertThrows(SQLiteConstraintException::class.java) { sql("DELETE FROM sync_operations WHERE id = '$op'") }
        // el payload original sigue intacto
        assertEquals(listOf(WireMark(s1, "present"), WireMark(s2, "absent")), outbox.payloadOf(op))
    }

    @Test
    fun elPayloadSoloAdmiteAlumnosDelBorradorEnMinusculaYEstadosDelServidor() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = (repo.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        repo.setMark(draft, sid(deviceA, g1, s1), AttendanceMark.PRESENT) // crea la intencion
        val intent = ops().single().id
        val insert = { id: String, status: String ->
            sql("INSERT INTO sync_operation_marks (operationId, studentRemoteId, status) VALUES ('$intent', '$id', '$status')")
        }
        assertThrows(SQLiteConstraintException::class.java) { insert(s1.uppercase(), "present") } // mayusculas
        assertThrows(SQLiteConstraintException::class.java) { insert(s1, "PRESENT") } // formato del servidor: minuscula
        assertThrows(SQLiteConstraintException::class.java) { insert(s1, "pending") } // Pendiente no es una orden
        assertThrows(SQLiteConstraintException::class.java) { insert("sbx.dispositivo.alumno", "present") }
        assertThrows(SQLiteConstraintException::class.java) { insert(s4, "present") } // alumno de OTRO grupo
        insert(s1, "present") // el valido si entra
        assertEquals(1, outbox.payloadOf(intent).size)
    }

    // ------------------------------------------------------------------------------------------------ rollback

    @Test
    fun siFallaElSelladoNoQuedaNadaAMedias() = runBlocking<Unit> {
        download()
        val first = repo(deviceA)
        val draft = capture(first)
        val firstOp = prepared(first, draft)
        // segundo sellado: el generador devuelve un requestId YA usado => el indice UNIQUE aborta a mitad de la transaccion
        repo(deviceA).setMark(draft, sid(deviceA, g1, s1), AttendanceMark.ABSENT)
        val duplicate = OutboxStore(db, clock, object : IdGenerator { override fun newId() = firstOp.requestId })
        val intentBefore = ops().single { it.state == OperationState.LOCAL_ONLY.name }
        val rowsBefore = ops()
        val result = duplicate.prepare(SandboxIds.profile(deviceA), draft, java.time.LocalDate.parse(tuesday), true)
        assertEquals(PrepareResult.LocalError, result)
        // nada cambio: ni payload parcial, ni la operacion anterior reemplazada, ni la intencion sellada a medias
        assertEquals(rowsBefore, ops())
        assertEquals(0, outbox.payloadOf(intentBefore.id).size)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT.name, ops().single { it.id == firstOp.operationId }.state)
        // las marcas del borrador siguen completas
        assertEquals(AttendanceMark.ABSENT, repo(deviceA).observeTodayDraft(gid(deviceA, g1)).first()!!.rows.first { it.student.id == sid(deviceA, g1, s1) }.mark)
        // y un intento correcto posterior funciona
        assertTrue(repo(deviceA).prepareForSync(draft) is PrepareResult.Prepared)
    }

    // --------------------------------------------------------------------------------- dependencias y maquina de estados

    @Test
    fun noPuedeSerREADYSinPayloadSelladoNiContextoNiConfirmacionDeLaDependencia() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val save = prepared(repo, draft).operationId
        // sin contexto remoto (dayId y revision) la base rechaza READY
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'READY' WHERE id = '$save'") }
        // con contexto, pero con la OPEN todavia sin confirmar por el servidor, tambien
        assertThrows(SQLiteConstraintException::class.java) { runBlocking { outbox.resolveContext(save, "dia-1", 1) } }
        // transiciones fuera de la maquina de estados
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'SENDING' WHERE id = '$save'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'ACKNOWLEDGED' WHERE id = '$save'") }
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT.name, ops().single { it.id == save }.state)
    }

    @Test
    fun cicloSimuladoOpenConfirmadaLuegoMarksListasConContextoSinCambiarLaIdentidad() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val save = prepared(repo, draft)
        val identity = ops().single { it.id == save.operationId }
        val open = ops().single { it.kind == "OPEN" }.id
        // --- simulacion del transporte futuro (no existe codigo de produccion que haga esto) ---
        assertTrue(outbox.beginSending(open))
        assertTrue(outbox.acknowledge(open, "dia-servidor-1", 1, 0, replayed = false))
        assertTrue(outbox.resolveContext(save.operationId, "dia-servidor-1", 1))
        val ready = ops().single { it.id == save.operationId }
        assertEquals(OperationState.READY.name, ready.state)
        assertEquals("dia-servidor-1", ready.serverDayId)
        assertEquals(1, ready.expectedRevision)
        // el contexto se completo SIN alterar la identidad sellada
        assertEquals(identity.requestId, ready.requestId)
        assertEquals(identity.contentHash, ready.contentHash)
        assertEquals(identity.markCount, ready.markCount)
        assertEquals(identity.sealedAtEpochMs, ready.sealedAtEpochMs)
        // una sola operacion lista o en envio por grupo y fecha
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'READY', serverDayId = 'x', expectedRevision = 1 WHERE id = '$open'") }
        assertTrue(outbox.beginSending(save.operationId))
        assertEquals(1, ops().single { it.id == save.operationId }.attempts)
        // el contexto no cambia mientras se envia
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET expectedRevision = 9 WHERE id = '${save.operationId}'") }
        assertTrue(outbox.acknowledge(save.operationId, "dia-servidor-1", 2, 2, replayed = false))
        val acked = ops().single { it.id == save.operationId }
        assertEquals(2, acked.ackRevision)
        // un recibo es terminal e inmutable
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'READY' WHERE id = '${save.operationId}'") }
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET ackRevision = 5 WHERE id = '${save.operationId}'") }
    }

    @Test
    fun unRecibosIncompletoNoSePuedeRegistrar() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        prepared(repo, capture(repo))
        val open = ops().single { it.kind == "OPEN" }.id
        outbox.beginSending(open)
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'ACKNOWLEDGED' WHERE id = '$open'") } // sin revision ni fecha de recibo
    }

    @Test
    fun unSendingPersistidoTrasReiniciarNuncaEsExito() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        prepared(repo, capture(repo))
        val open = ops().single { it.kind == "OPEN" }.id
        assertTrue(outbox.beginSending(open))
        // "el proceso murio": al abrir de nuevo, el resultado es DESCONOCIDO
        assertEquals(1, outbox.recoverAfterRestart())
        val recovered = ops().single { it.id == open }
        assertEquals(OperationState.RETRYABLE_ERROR.name, recovered.state)
        assertEquals(OutboxReasons.RESULT_UNKNOWN_AFTER_RESTART, recovered.reasonCode)
        assertNull(recovered.ackRevision)
        assertEquals(0, outbox.recoverAfterRestart()) // idempotente
        // y no puede descartarse como si nunca hubiera salido
        assertThrows(SQLiteConstraintException::class.java) { runBlocking { outbox.discard(open, confirmedByPerson = true) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { outbox.discard(open, confirmedByPerson = false) } }
    }

    @Test
    fun descartarExigeConfirmacionYConservaLaFila() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val save = prepared(repo, capture(repo)).operationId
        assertThrows(IllegalArgumentException::class.java) { runBlocking { outbox.discard(save, confirmedByPerson = false) } }
        assertTrue(outbox.discard(save, confirmedByPerson = true))
        val row = ops().single { it.id == save }
        assertEquals(OperationState.DISCARDED.name, row.state)
        assertNotNull(row.requestId) // conservada, no borrada
        assertEquals(2, outbox.payloadOf(save).size)
    }

    // ---------------------------------------------------- Pendiente no es una orden de borrar lo ya confirmado

    @Test
    fun unaMarcaConfirmadaPorElServidorNoVuelveAPendienteSoloCambiaEntrePresenteYAusente() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val save = prepared(repo, draft).operationId
        val open = ops().single { it.kind == "OPEN" }.id
        outbox.beginSending(open); outbox.acknowledge(open, "dia-1", 1, 0, false)
        outbox.resolveContext(save, "dia-1", 1); outbox.beginSending(save); outbox.acknowledge(save, "dia-1", 2, 2, false)
        // quitar la marca de s1 (ya confirmada) NO se permite
        assertEquals(SetMarkResult.UnmarkAfterAck, repo.setMark(draft, sid(deviceA, g1, s1), null))
        assertEquals(AttendanceMark.PRESENT, repo.observeTodayDraft(gid(deviceA, g1)).first()!!.rows.first { it.student.id == sid(deviceA, g1, s1) }.mark)
        // cambiarla entre Presente y Ausente si; un alumno sin confirmar (s3) si puede quedar Pendiente
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, sid(deviceA, g1, s1), AttendanceMark.ABSENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, sid(deviceA, g1, s3), AttendanceMark.PRESENT))
        assertEquals(SetMarkResult.Saved, repo.setMark(draft, sid(deviceA, g1, s3), null))
        // la nueva operacion hereda el contexto confirmado y NO lleva ninguna orden de borrar
        val next = repo.prepareForSync(draft) as PrepareResult.Prepared
        assertEquals(OperationState.READY, next.state)
        val row = ops().single { it.id == next.operationId }
        assertEquals("dia-1", row.serverDayId)
        assertEquals(2, row.expectedRevision) // la revision que confirmo el servidor, no una inventada
        assertEquals(save, row.dependsOnOperationId)
        assertEquals(listOf(WireMark(s1, "absent"), WireMark(s2, "absent")), outbox.payloadOf(next.operationId))
    }

    // ------------------------------------------------------------------------------------------------ fecha y padron

    @Test
    fun conLaFechaSinConfirmarNingunaOperacionQuedaLista() = runBlocking<Unit> {
        download(serverDate = "2026-10-26") // el servidor confirmo ayer, el telefono dice hoy
        val repo = repo(deviceA)
        val draft = capture(repo)
        val result = prepared(repo, draft)
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT, result.state)
        assertEquals(OutboxReasons.DATE_UNCONFIRMED, result.reason)
        val all = ops()
        assertEquals("DEVICE_UNCONFIRMED", all.single { it.kind == "SAVE_MARKS" }.dateProvenance)
        val open = all.single { it.kind == "OPEN" }
        assertEquals(OperationState.WAITING_REMOTE_CONTEXT.name, open.state)
        assertEquals(OutboxReasons.DATE_UNCONFIRMED, open.reasonCode)
    }

    @Test
    fun unaCapturaDeAyerSeConservaEnRevisionYNuncaSeConvierteEnHoy() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val marksBefore = repo.observeTodayDraft(gid(deviceA, g1)).first()!!.rows
        clock.now = MutableClock.WEDNESDAY_AFTER_MIDNIGHT // cruzo la medianoche (Mazatlan)
        download(serverDate = "2026-10-28") // y el servidor confirma el nuevo dia: el acceso esta vigente
        // ni siquiera con acceso activo y fecha "confirmada" se prepara como una operacion ordinaria
        val result = repo.prepareForSync(draft)
        assertTrue(result is PrepareResult.Prepared)
        result as PrepareResult.Prepared
        assertEquals(OperationState.NEEDS_REVIEW, result.state)
        assertEquals(OutboxReasons.DATE_HISTORIC, result.reason)
        val all = ops()
        assertEquals(tuesday, all.single { it.kind == "SAVE_MARKS" }.schoolDate) // la fecha NO se movio a hoy
        assertEquals(OperationState.NEEDS_REVIEW.name, all.single { it.kind == "OPEN" }.state)
        assertEquals(0, all.count { it.state == OperationState.READY.name })
        // las marcas del borrador de ayer siguen ahi y el borrador ya no se edita
        assertEquals(SetMarkResult.DraftNotEditable, repo.setMark(draft, sid(deviceA, g1, s3), AttendanceMark.PRESENT))
        assertEquals(marksBefore.map { it.mark }, repo.observeTodayDraft(gid(deviceA, g1)).first()?.rows?.map { it.mark } ?: marksBefore.map { it.mark })
    }

    @Test
    fun siElPadronCambioLaOperacionSinEnviarQuedaEnRevisionSinTocarLasMarcas() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val op = prepared(repo, draft).operationId
        val payload = outbox.payloadOf(op)
        // el servidor entrega otro padron (s4 se incorpora): el borrador y la operacion se marcan, nada se modifica
        val changed = cache.commit(
            spec(deviceA, group(g1, "1.º A", student(s1, "Ana"), student(s2, "Beto"), student(s3, "Carla"), student(s4, "Nuevo")), group(g2, "1.º B", student(s4, "Diana"))),
        )
        assertTrue(changed.changedRosters >= 1)
        val row = ops().single { it.id == op }
        assertEquals(OperationState.NEEDS_REVIEW.name, row.state)
        assertEquals(OutboxReasons.ROSTER_CHANGED, row.reasonCode)
        assertEquals(payload, outbox.payloadOf(op)) // payload inmutable
        // preparar de nuevo un borrador marcado para revision: se conserva en NEEDS_REVIEW
        repo.setMark(draft, sid(deviceA, g1, s3), AttendanceMark.PRESENT)
        val again = repo.prepareForSync(draft) as PrepareResult.Prepared
        assertEquals(OperationState.NEEDS_REVIEW, again.state)
    }

    @Test
    fun unAlumnoQueYaNoEstaEnElPadronDejaLaOperacionEnRevision() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        // el padron nuevo ya no trae a s2 (que tiene marca): queda inactivo, no se borra
        cache.commit(spec(deviceA, group(g1, "1.º A", student(s1, "Ana"), student(s3, "Carla")), group(g2, "1.º B", student(s4, "Diana"))))
        val result = repo.prepareForSync(draft) as PrepareResult.Prepared
        assertEquals(OperationState.NEEDS_REVIEW, result.state)
        assertEquals(2, outbox.payloadOf(result.operationId).size) // el payload conserva lo capturado
    }

    @Test
    fun unGrupoRevocadoConservaBorradorYOperacionesYNoPermiteSellarMas() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        val op = prepared(repo, draft).operationId
        val open = ops().single { it.kind == "OPEN" }.id
        assertEquals(OperationState.READY.name, ops().single { it.id == open }.state)
        // el servidor deja de autorizar el grupo 1
        cache.commit(spec(deviceA, group(g2, "1.º B", student(s4, "Diana")), revoked = setOf(g1)))
        val all = ops()
        assertEquals(setOf(op, open), all.map { it.id }.toSet()) // nada se borro
        assertTrue(all.all { it.state == OperationState.NEEDS_REVIEW.name && it.reasonCode == OutboxReasons.GROUP_REVOKED })
        assertEquals(2, db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM attendance_marks WHERE draftId = '$draft' AND status IS NOT NULL").use { c -> c.moveToFirst(); c.getInt(0) })
        assertEquals(PrepareResult.Refused(Refusal.GroupRevoked), repo.prepareForSync(draft))
        // y la base impide volver a dejarlas listas para enviar
        assertThrows(SQLiteConstraintException::class.java) { sql("UPDATE sync_operations SET state = 'READY' WHERE id = '$open'") }
    }

    @Test
    fun siElServidorInformaDispositivoRevocadoLoQueEstabaListoExigeVolverAAutenticar() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        prepared(repo, capture(repo))
        val open = ops().single { it.kind == "OPEN" }
        assertEquals(OperationState.READY.name, open.state)
        cache.markAuthState(deviceA, OfflineCacheStore.AUTH_DEVICE_REVOKED)
        val after = ops().single { it.id == open.id }
        assertEquals(OperationState.AUTH_REQUIRED.name, after.state)
        assertEquals(OfflineCacheStore.AUTH_DEVICE_REVOKED, after.reasonCode)
        // sin acceso, preparar mas cosas tambien se bloquea
        assertTrue(repo.prepareForSync("x") is PrepareResult.AccessBlocked)
    }

    @Test
    fun masDe200MarcasNoSePreparan() = runBlocking<Unit> {
        val many = (1..201).map { student("61111111-0000-4000-8000-%012x".format(it), "Alumno$it") }
        cache.commit(spec(deviceA, group(g1, "1.º A", *many.toTypedArray())))
        val repo = repo(deviceA)
        val draft = (repo.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        many.forEach { repo.setMark(draft, SandboxIds.student(gid(deviceA, g1), it.remoteId), AttendanceMark.PRESENT) }
        assertEquals(PrepareResult.Refused(Refusal.TooManyMarks(201)), repo.prepareForSync(draft))
        assertEquals(0, db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM sync_operation_marks").use { c -> c.moveToFirst(); c.getInt(0) })
    }

    // ------------------------------------------------------------------------------------------------- aislamiento

    @Test
    fun dosPerfilesEnElMismoTelefonoNoVenNiTocanLasOperacionesDelOtro() = runBlocking<Unit> {
        download(deviceA)
        download(deviceB)
        val a = repo(deviceA)
        val b = repo(deviceB)
        val draftA = capture(a, deviceA)
        val draftB = capture(b, deviceB)
        val opA = prepared(a, draftA).operationId
        val opB = prepared(b, draftB).operationId
        assertNotEquals(opA, opB)
        // cada perfil solo ve lo suyo, incluso con los MISMOS identificadores remotos de grupo y alumnos
        val profileA = SandboxIds.profile(deviceA)
        val profileB = SandboxIds.profile(deviceB)
        assertTrue(db.outboxDao().allOf(profileA).all { it.profileId == profileA && it.deviceId == deviceA })
        assertTrue(db.outboxDao().allOf(profileB).all { it.profileId == profileB && it.deviceId == deviceB })
        assertNull(db.outboxDao().find(profileB, opA))
        assertNull(db.outboxDao().find(profileA, opB))
        assertEquals(PrepareResult.DraftNotFound, b.prepareForSync(draftA)) // otro perfil no sella el borrador ajeno
        assertEquals(SetMarkResult.NotFound, b.setMark(draftA, sid(deviceA, g1, s1), AttendanceMark.ABSENT))
        assertTrue(a.observeOutbox(gid(deviceB, g1)).first() == null) // y no ve el resumen del otro
        // la base impide que una operacion declare un dispositivo que no es el de su perfil
        assertThrows(SQLiteConstraintException::class.java) {
            sql(
                """
                INSERT INTO sync_operations (id, profileId, deviceId, groupId, remoteGroupId, schoolDate, draftId, kind, seq, state, createdAtEpochMs, updatedAtEpochMs)
                VALUES ('falsa', '$profileA', '$deviceB', '${gid(deviceA, g1)}', '$g1', '$tuesday', '$draftA', 'SAVE_MARKS', 99, 'LOCAL_ONLY', 1, 1)
                """.trimIndent(),
            )
        }
        // revocar o purgar uno no toca al otro
        cache.markAuthState(deviceA, OfflineCacheStore.AUTH_DEVICE_REVOKED)
        assertEquals(OperationState.READY.name, db.outboxDao().operationsOf(profileB, gid(deviceB, g1), tuesday).single { it.kind == "OPEN" }.state)
        assertTrue(cache.purge(deviceA))
        assertEquals(0, db.outboxDao().count(profileA))
        assertEquals(2, db.outboxDao().count(profileB))
    }

    @Test
    fun variasFechasYVariosGruposTienenSuPropioOrdenLocalYDependencias() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val d1 = capture(repo)
        val d2 = (repo.openTodayDraft(gid(deviceA, g2)) as OpenDraftResult.Ready).draftId
        repo.setMark(d2, sid(deviceA, g2, s4), AttendanceMark.ABSENT)
        prepared(repo, d1)
        prepared(repo, d2)
        clock.now = MutableClock.WEDNESDAY_AFTER_MIDNIGHT.plusSeconds(8 * 3600) // miercoles por la manana
        download(serverDate = "2026-10-28")
        val wed = (repo.openTodayDraft(gid(deviceA, g1)) as OpenDraftResult.Ready).draftId
        repo.setMark(wed, sid(deviceA, g1, s3), AttendanceMark.PRESENT)
        // el borrador del miercoles es otro y su preparacion no mezcla nada con el del martes
        val prep = repo.prepareForSync(wed) as PrepareResult.Prepared
        val wedOps = ops(date = "2026-10-28")
        assertEquals(setOf("OPEN", "SAVE_MARKS"), wedOps.map { it.kind }.toSet())
        assertTrue(wedOps.all { it.schoolDate == "2026-10-28" })
        assertEquals(1, outbox.payloadOf(prep.operationId).size)
        assertEquals(2, ops(date = tuesday).count { it.kind in setOf("OPEN", "SAVE_MARKS") })
        assertEquals(2, ops(remote = g2, date = tuesday).size)
        // cada (perfil, grupo, fecha) tiene su propia numeracion local
        assertEquals(listOf(1, 2), ops(date = tuesday).map { it.seq }.sorted())
        assertEquals(listOf(1, 2), wedOps.map { it.seq }.sorted())
    }

    @Test
    fun borrarElPerfilBorraSusOperacionesYSoloEsaAccionExplicitaLoHace() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        prepared(repo, capture(repo))
        assertEquals(2, db.outboxDao().count(SandboxIds.profile(deviceA)))
        assertTrue(cache.purge(deviceA))
        assertEquals(0, db.outboxDao().count(SandboxIds.profile(deviceA)))
        assertEquals("0", scalar("SELECT COUNT(*) FROM sync_operation_marks"))
    }

    // ----------------------------------------------------------------------------------------------- lectura de la UI

    @Test
    fun elResumenMuestraMarcasLocalesCambiosSinPrepararYOperaciones() = runBlocking<Unit> {
        download()
        val repo = repo(deviceA)
        val draft = capture(repo)
        var summary = repo.observeOutbox(gid(deviceA, g1)).first()!!
        assertEquals(2, summary.localMarks)
        assertTrue(summary.unsealedChanges)
        assertEquals(0, summary.preparedOperations)
        prepared(repo, draft)
        summary = repo.observeOutbox(gid(deviceA, g1)).first()!!
        assertFalse(summary.unsealedChanges)
        assertEquals(1, summary.preparedOperations)
        assertTrue(summary.waitingContext)
        assertFalse(summary.readyForFutureSend) // las marcas esperan el contexto del servidor
        assertFalse(summary.needsReview)
        repo.setMark(draft, sid(deviceA, g1, s3), AttendanceMark.PRESENT)
        assertTrue(repo.observeOutbox(gid(deviceA, g1)).first()!!.unsealedChanges)
    }
}
