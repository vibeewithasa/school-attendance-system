package mx.edu.eta15.prefectura.mobile

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Clock
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mx.edu.eta15.prefectura.BuildConfig
import mx.edu.eta15.prefectura.data.LocalAttendanceRepository
import mx.edu.eta15.prefectura.data.OfflineCacheStore
import mx.edu.eta15.prefectura.data.OutboxStore
import mx.edu.eta15.prefectura.data.ProfileAccessGate
import mx.edu.eta15.prefectura.data.SandboxIds
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import mx.edu.eta15.prefectura.data.secure.SecureStorage
import mx.edu.eta15.prefectura.domain.AttendanceMark
import mx.edu.eta15.prefectura.domain.IdGenerator
import mx.edu.eta15.prefectura.domain.OfflinePolicy
import mx.edu.eta15.prefectura.domain.OpenDraftResult
import mx.edu.eta15.prefectura.domain.SetMarkResult
import mx.edu.eta15.prefectura.domain.SyncResultKind
import mx.edu.eta15.prefectura.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E del TRANSPORTE MANUAL contra el servidor de PRUEBAS (`pnpm dev:sandbox -- ... --mobile-attendance-read --mobile-attendance-write`,
 * cuentas y alumnos FICTICIOS) con el Keystore, SQLCipher y DPoP REALES del emulador. Solo corre si se pide: `-e e2e sync`. Un guion
 * externo (e2e-sync.mjs) hace los pasos web, apaga y enciende la red, mata procesos y verifica el servidor. Fases (`-e phase ...`):
 *   capture    -> abre el borrador de hoy del grupo `group` (indice) y marca segun `set` ("0:present,2:absent,3:pending").
 *   edit       -> igual que capture pero sobre un borrador ya existente.
 *   sync       -> pulsa "Sincronizar ahora" (la misma ruta que el boton: MobileFeature.manualSync) y espera el resultado.
 *   lossy-sync -> igual que sync, pero la respuesta del guardado se PIERDE despues de que el servidor lo aplico.
 *   state      -> imprime las operaciones y las marcas del grupo (evidencia) sin tocar nada.
 *   other-state-> imprime las operaciones de OTROS perfiles del almacenamiento (aislamiento).
 * Nunca se imprimen tokens, claves ni pruebas DPoP.
 */
@RunWith(AndroidJUnit4::class)
class SandboxSyncE2eTest {
    private val args = InstrumentationRegistry.getArguments()
    private val ctx = testContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clock: Clock = Clock.systemUTC()
    private val policy get() = OfflinePolicy(Duration.ofMinutes(args.getString("validityMinutes")?.toLong() ?: 15))

    private fun say(text: String) = Log.i(TAG, text)

    private fun linked() = FileLinkStore(ctx.noBackupFilesDir).load()?.deviceId ?: error("sin vinculacion")

    private fun profile() = SandboxIds.profile(linked())

    private fun repo(db: EtaDatabase) = LocalAttendanceRepository(db, profile(), clock, IdGenerator.Random, access = ProfileAccessGate(db, profile(), clock, policy))

    /** Misma ruta que el boton "Sincronizar ahora": el motor real con la clave, el HTTP y la sesion DPoP reales. */
    private fun realEngine(db: EtaDatabase, wrap: (AttendanceApi) -> AttendanceApi = { it }): ManualSyncEngine {
        val key = AndroidDeviceKey()
        val jwk = key.publicJwk()
        val http = HttpMobileApi(BuildConfig.MOBILE_BASE_URL, DpopProofBuilder(jwk, key::signDer), jwk)
        val repo = repo(db)
        val store = RoomSyncStore(OutboxStore(db, clock, IdGenerator.Random), profile(), linked(), OfflineCacheStore(db, clock, policy), repo::schoolToday) { repo.prepareForSync(it) }
        val link = FileLinkStore(ctx.noBackupFilesDir)
        return ManualSyncEngine(profile(), store, wrap(http), DeviceSyncSessions(http, clock), { link.load()?.deviceId })
    }

    @Test
    fun fase() = runBlocking<Unit> {
        assumeTrue("e2e=sync", args.getString("e2e") == "sync")
        SecureStorage.loadNativeLibrary()
        val db = SecureStorage(ctx).open()
        try {
            when (val phase = args.getString("phase")) {
                "capture", "edit" -> capture(db)
                "sync" -> sync(db, lossy = false)
                "lossy-sync" -> sync(db, lossy = true)
                "state" -> state(db)
                "prepare" -> prepare(db)
                "ack-fail-on" -> ackFailure(db, on = true)
                "ack-fail-off" -> ackFailure(db, on = false)
                "other-state" -> otherState(db)
                else -> throw AssertionError("fase desconocida: $phase")
            }
        } finally {
            scope.cancel()
            db.close()
        }
    }

    private suspend fun groupOf(db: EtaDatabase) = repo(db).observeGroups().first().sortedBy { it.name }[args.getString("group")?.toInt() ?: 0]

    private suspend fun capture(db: EtaDatabase) {
        val repo = repo(db)
        val group = groupOf(db)
        val draft = (repo.openTodayDraft(group.id) as OpenDraftResult.Ready).draftId
        val roster = repo.observeRoster(group.id).first()
        for (item in args.getString("set").orEmpty().split(",").filter { it.isNotBlank() }) {
            val (index, status) = item.split(":")
            val mark = when (status) {
                "present" -> AttendanceMark.PRESENT
                "absent" -> AttendanceMark.ABSENT
                else -> null
            }
            assertEquals("no se pudo marcar $item", SetMarkResult.Saved, repo.setMark(draft, roster[index.toInt()].id, mark))
        }
        say("CAPTURE group=${group.name} set=${args.getString("set")}")
        dump(db, group.id)
    }

    private suspend fun sync(db: EtaDatabase, lossy: Boolean) {
        val group = groupOf(db)
        val before = db.outboxDao().allOf(profile()).size
        val report = if (lossy) {
            val engine = realEngine(db) { LossyApi(it) }
            engine.run(group.id)
        } else {
            // La ruta REAL del boton: MobileFeature.manualSync + syncNow (un solo ciclo, en segundo plano de la corrutina de la app).
            val sync = MobileFeature.manualSync(ctx, db, clock, IdGenerator.Random, profile(), policy, scope)
            assertTrue("el transporte debe estar disponible en este build de pruebas", sync.available)
            sync.syncNow(group.id)
            withTimeout(120_000) { while (sync.state.value.running || sync.state.value.last == null) delay(200) }
            sync.state.value.last
        }
        say("SYNC group=${group.name} kind=${report?.kind} confirmed=${report?.confirmed} opsBefore=$before")
        dump(db, group.id)
        args.getString("expect")?.let { assertEquals(SyncResultKind.valueOf(it), report?.kind) }
    }

    /** Solo "Preparar para sincronizar" del grupo (accion local): nada se envia. */
    private suspend fun prepare(db: EtaDatabase) {
        val repo = repo(db)
        val group = groupOf(db)
        val draft = repo.observeTodayDraft(group.id).first()!!.draftId
        val result = repo.prepareForSync(draft)
        say("PREPARE group=${group.name} result=${result::class.simpleName}")
        dump(db, group.id)
    }

    /**
     * Fallo REAL de Room en el SQLCipher del dispositivo: un disparador impide guardar el recibo de las marcas (la peticion SI
     * llega al servidor y la respuesta es valida; lo que falla es guardarla). Persiste entre procesos hasta `ack-fail-off`.
     */
    private fun ackFailure(db: EtaDatabase, on: Boolean) {
        val raw = db.openHelper.writableDatabase
        raw.execSQL("DROP TRIGGER IF EXISTS t_e2e_no_ack")
        if (on) {
            raw.execSQL(
                "CREATE TRIGGER t_e2e_no_ack BEFORE UPDATE OF state ON sync_operations WHEN NEW.state = 'ACKNOWLEDGED' AND NEW.kind = 'SAVE_MARKS' " +
                    "BEGIN SELECT RAISE(ABORT, 'fallo de Room inyectado por el E2E'); END",
            )
        }
        say("ACKFAIL on=$on")
    }

    private suspend fun state(db: EtaDatabase) {
        dump(db, groupOf(db).id)
    }

    private suspend fun dump(db: EtaDatabase, groupId: String) {
        val repo = repo(db)
        val ops = db.outboxDao().allOf(profile()).filter { it.groupId == groupId }
        say("OPS " + ops.joinToString(" | ") { "${it.kind}:${it.state}:seq=${it.seq}:attempts=${it.attempts}:ack=${it.ackRevision}:replayed=${it.ackReplayed}:reason=${it.reasonCode}:req=${it.requestId ?: "-"}:day=${it.serverDayId ?: "-"}:exp=${it.expectedRevision ?: "-"}" })
        val draft = repo.observeTodayDraft(groupId).first()
        say("MARKS " + (draft?.rows?.joinToString(",") { it.mark?.name?.lowercase() ?: "pending" } ?: "sin-borrador"))
        say("AUTH state=${db.cacheDao().syncOf(profile())?.authState}")
    }

    private suspend fun otherState(db: EtaDatabase) {
        val mine = profile()
        val others = db.openHelper.readableDatabase.query("SELECT id FROM profiles WHERE source = 'SANDBOX' AND id <> '$mine'").use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        for (other in others) {
            val ops = db.outboxDao().allOf(other)
            say("OTHER ops=${ops.size} states=" + ops.joinToString("|") { "${it.kind}:${it.state}:ack=${it.ackRevision}" })
        }
        say("OTHER-MINE ops=${db.outboxDao().allOf(mine).size}")
    }

    /** Envoltorio SOLO de prueba: el servidor aplica el guardado y la respuesta se pierde (el cliente ve un fallo de red). */
    private class LossyApi(private val inner: AttendanceApi) : AttendanceApi by inner {
        var lost = false

        override suspend fun saveMarks(
            session: MobileSession,
            dayId: String,
            expectedRevision: Int,
            requestId: String,
            marks: List<mx.edu.eta15.prefectura.domain.WireMark>,
        ): ApiResult<SrvSave> {
            val real = inner.saveMarks(session, dayId, expectedRevision, requestId, marks)
            if (!lost && real is ApiResult.Ok) {
                lost = true
                return ApiResult.Failure(0, null)
            }
            return real
        }
    }

    private companion object {
        const val TAG = "ETA15_SYNC"
    }
}
