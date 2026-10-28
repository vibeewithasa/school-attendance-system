package mx.edu.eta15.prefectura.data.local

import mx.edu.eta15.prefectura.domain.OutboxTransitions

/**
 * SQL de la OUTBOX (esquema v3): la migracion 2 -> 3 y los disparadores de integridad. Las reglas que Room no expresa como
 * anotaciones se imponen en la base (no solo en Kotlin), como las de la v1 y la v2: ninguna ruta de codigo puede saltarlas.
 */
internal object OutboxSql {
    /** Crea las tablas nuevas EXACTAMENTE como las genera Room (copiado de `app/schemas/.../3.json`; lo valida SchemaMigrationTest). */
    val CREATE_V3: List<String> = listOf(
        """
        CREATE TABLE IF NOT EXISTS `sync_operations` (`id` TEXT NOT NULL, `profileId` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `groupId` TEXT NOT NULL, `remoteGroupId` TEXT NOT NULL, `schoolDate` TEXT NOT NULL, `draftId` TEXT NOT NULL, `kind` TEXT NOT NULL, `seq` INTEGER NOT NULL, `state` TEXT NOT NULL, `reasonCode` TEXT, `dependsOnOperationId` TEXT, `supersededByOperationId` TEXT, `requestId` TEXT, `contentHash` TEXT, `markCount` INTEGER, `sealedAtEpochMs` INTEGER, `schemaVersion` INTEGER, `rosterDigestAtSeal` TEXT, `dateProvenance` TEXT, `serverDayId` TEXT, `expectedRevision` INTEGER, `attempts` INTEGER NOT NULL DEFAULT 0, `lastAttemptAtEpochMs` INTEGER, `nextAttemptAtEpochMs` INTEGER, `lastHttpStatus` INTEGER, `lastServerCode` TEXT, `ackRevision` INTEGER, `ackedAtEpochMs` INTEGER, `ackChanged` INTEGER, `ackReplayed` INTEGER, `createdAtEpochMs` INTEGER NOT NULL, `updatedAtEpochMs` INTEGER NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`groupId`, `profileId`) REFERENCES `school_groups`(`id`, `profileId`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`draftId`, `groupId`) REFERENCES `attendance_drafts`(`id`, `groupId`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`dependsOnOperationId`) REFERENCES `sync_operations`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL , FOREIGN KEY(`supersededByOperationId`) REFERENCES `sync_operations`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL )
        """.trimIndent(),
        """
        CREATE UNIQUE INDEX IF NOT EXISTS `index_sync_operations_requestId` ON `sync_operations` (`requestId`)
        """.trimIndent(),
        """
        CREATE UNIQUE INDEX IF NOT EXISTS `index_sync_operations_profileId_groupId_schoolDate_seq` ON `sync_operations` (`profileId`, `groupId`, `schoolDate`, `seq`)
        """.trimIndent(),
        """
        CREATE INDEX IF NOT EXISTS `index_sync_operations_profileId_state` ON `sync_operations` (`profileId`, `state`)
        """.trimIndent(),
        """
        CREATE INDEX IF NOT EXISTS `index_sync_operations_draftId_groupId` ON `sync_operations` (`draftId`, `groupId`)
        """.trimIndent(),
        """
        CREATE INDEX IF NOT EXISTS `index_sync_operations_groupId_profileId` ON `sync_operations` (`groupId`, `profileId`)
        """.trimIndent(),
        """
        CREATE INDEX IF NOT EXISTS `index_sync_operations_dependsOnOperationId` ON `sync_operations` (`dependsOnOperationId`)
        """.trimIndent(),
        """
        CREATE INDEX IF NOT EXISTS `index_sync_operations_supersededByOperationId` ON `sync_operations` (`supersededByOperationId`)
        """.trimIndent(),
        """
        CREATE TABLE IF NOT EXISTS `sync_operation_marks` (`operationId` TEXT NOT NULL, `studentRemoteId` TEXT NOT NULL, `status` TEXT NOT NULL, PRIMARY KEY(`operationId`, `studentRemoteId`), FOREIGN KEY(`operationId`) REFERENCES `sync_operations`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )
        """.trimIndent(),
    )

    private val ALLOWED_PAIRS: String = OutboxTransitions.sqlPairs().joinToString(", ") { "'$it'" }

    private const val TERMINAL = "('ACKNOWLEDGED', 'SUPERSEDED', 'DISCARDED')"

    private val NAME = Regex("""CREATE TRIGGER IF NOT EXISTS (\w+)""")
    private val SPACES = Regex("""\s+""")

    private fun normalized(sql: String) = sql.replace("IF NOT EXISTS ", "").trim().replace(SPACES, " ")

    /**
     * Reinstala SOLO los disparadores de la outbox cuyo texto cambio (o faltan): una regla corregida en una nueva version de la app
     * no puede quedarse con la definicion anterior por el `IF NOT EXISTS`. Si todos coinciden no escribe NADA (abrir la base no la
     * modifica).
     */
    fun reinstallChanged(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        val stored = HashMap<String, String>()
        db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_%'").use { c ->
            while (c.moveToNext()) stored[c.getString(0)] = c.getString(1).orEmpty()
        }
        for (sql in TRIGGERS) {
            val name = NAME.find(sql)!!.groupValues[1]
            if (stored[name]?.let { it.trim().replace(SPACES, " ") } == normalized(sql)) continue
            db.execSQL("DROP TRIGGER IF EXISTS $name")
            db.execSQL(sql)
        }
    }

    val TRIGGERS: List<String> = listOf(
        // ------------------------------------------------------------------------------------------------ alta de una operacion
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_insert_guard BEFORE INSERT ON sync_operations
        BEGIN
          SELECT RAISE(ABORT, 'perfil y dispositivo no coinciden') WHERE NEW.profileId <> 'sbx.' || NEW.deviceId;
          SELECT RAISE(ABORT, 'la outbox solo existe para perfiles sandbox')
           WHERE COALESCE((SELECT source FROM profiles WHERE id = NEW.profileId), '') <> 'SANDBOX';
          SELECT RAISE(ABORT, 'tipo de operacion invalido') WHERE NEW.kind NOT IN ('OPEN', 'SAVE_MARKS');
          SELECT RAISE(ABORT, 'estado inicial invalido')
           WHERE NEW.state NOT IN ('LOCAL_ONLY', 'WAITING_REMOTE_CONTEXT', 'READY', 'NEEDS_REVIEW');
          SELECT RAISE(ABORT, 'una intencion nace sin sellar y en LOCAL_ONLY')
           WHERE NEW.kind = 'SAVE_MARKS' AND (NEW.state <> 'LOCAL_ONLY' OR NEW.sealedAtEpochMs IS NOT NULL OR NEW.requestId IS NOT NULL
                 OR NEW.contentHash IS NOT NULL OR NEW.markCount IS NOT NULL OR NEW.serverDayId IS NOT NULL OR NEW.expectedRevision IS NOT NULL);
          SELECT RAISE(ABORT, 'OPEN nace sellado, sin payload ni requestId')
           WHERE NEW.kind = 'OPEN' AND (NEW.state = 'LOCAL_ONLY' OR NEW.sealedAtEpochMs IS NULL OR NEW.requestId IS NOT NULL
                 OR NEW.contentHash IS NOT NULL OR NEW.markCount IS NOT NULL OR NEW.dependsOnOperationId IS NOT NULL);
          SELECT RAISE(ABORT, 'grupo del servidor distinto')
           WHERE NEW.remoteGroupId IS NOT (SELECT remoteId FROM school_groups WHERE id = NEW.groupId AND profileId = NEW.profileId);
          SELECT RAISE(ABORT, 'el borrador no corresponde al perfil, grupo y fecha')
           WHERE NOT EXISTS (SELECT 1 FROM attendance_drafts d WHERE d.id = NEW.draftId AND d.profileId = NEW.profileId
                               AND d.groupId = NEW.groupId AND d.schoolDate = NEW.schoolDate);
          SELECT RAISE(ABORT, 'ya existe la operacion OPEN de ese grupo y fecha')
           WHERE NEW.kind = 'OPEN' AND EXISTS (SELECT 1 FROM sync_operations o WHERE o.profileId = NEW.profileId
                                                AND o.groupId = NEW.groupId AND o.schoolDate = NEW.schoolDate AND o.kind = 'OPEN');
          SELECT RAISE(ABORT, 'ya hay una intencion sin sellar para ese borrador')
           WHERE NEW.kind = 'SAVE_MARKS' AND EXISTS (SELECT 1 FROM sync_operations o WHERE o.draftId = NEW.draftId
                                                      AND o.kind = 'SAVE_MARKS' AND o.state = 'LOCAL_ONLY');
          SELECT RAISE(ABORT, 'ya hay una operacion lista o en envio para ese grupo y fecha')
           WHERE NEW.state IN ('READY', 'SENDING') AND EXISTS (SELECT 1 FROM sync_operations o WHERE o.profileId = NEW.profileId
                 AND o.groupId = NEW.groupId AND o.schoolDate = NEW.schoolDate AND o.state IN ('READY', 'SENDING'));
        END
        """.trimIndent(),
        // ----------------------------------------------------------------------------------------------------- identidad
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_identity_update
        BEFORE UPDATE OF id, profileId, deviceId, groupId, remoteGroupId, schoolDate, draftId, kind, seq, createdAtEpochMs ON sync_operations
        BEGIN SELECT RAISE(ABORT, 'identidad de la operacion inmutable'); END
        """.trimIndent(),
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_sealed_update
        BEFORE UPDATE OF requestId, contentHash, markCount, sealedAtEpochMs, schemaVersion, rosterDigestAtSeal, dateProvenance ON sync_operations
        WHEN OLD.sealedAtEpochMs IS NOT NULL AND (
              NEW.requestId IS NOT OLD.requestId OR NEW.contentHash IS NOT OLD.contentHash OR NEW.markCount IS NOT OLD.markCount
           OR NEW.sealedAtEpochMs IS NOT OLD.sealedAtEpochMs OR NEW.schemaVersion IS NOT OLD.schemaVersion
           OR NEW.rosterDigestAtSeal IS NOT OLD.rosterDigestAtSeal OR NEW.dateProvenance IS NOT OLD.dateProvenance)
        BEGIN SELECT RAISE(ABORT, 'operacion sellada inmutable'); END
        """.trimIndent(),
        // El sellado de una intencion exige payload completo, huella, requestId y el numero exacto de marcas.
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_seal_check
        BEFORE UPDATE OF sealedAtEpochMs ON sync_operations
        WHEN OLD.sealedAtEpochMs IS NULL AND NEW.sealedAtEpochMs IS NOT NULL AND NEW.kind = 'SAVE_MARKS'
        BEGIN
          SELECT RAISE(ABORT, 'sellado incompleto')
           WHERE NEW.requestId IS NULL OR NEW.contentHash IS NULL OR NEW.markCount IS NULL OR NEW.schemaVersion IS NULL
              OR NEW.dateProvenance IS NULL OR NEW.markCount < 1 OR NEW.markCount > 200
              OR (SELECT COUNT(*) FROM sync_operation_marks p WHERE p.operationId = NEW.id) <> NEW.markCount;
        END
        """.trimIndent(),
        // Una operacion terminal no cambia mas (las referencias entre operaciones no cuentan: las pone una llave foranea al borrar).
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_terminal_update
        BEFORE UPDATE OF state, reasonCode, serverDayId, expectedRevision, attempts, lastAttemptAtEpochMs, nextAttemptAtEpochMs,
                         lastHttpStatus, lastServerCode, ackRevision, ackedAtEpochMs, ackChanged, ackReplayed ON sync_operations
        WHEN OLD.state IN $TERMINAL
        BEGIN SELECT RAISE(ABORT, 'operacion terminal inmutable'); END
        """.trimIndent(),
        // El contexto remoto YA CONOCIDO no cambia mientras la operacion esta en envio (el que aprende la respuesta de OPEN parte de nulo).
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_context_update
        BEFORE UPDATE OF serverDayId, expectedRevision ON sync_operations
        WHEN OLD.state = 'SENDING'
          AND ((OLD.serverDayId IS NOT NULL AND NEW.serverDayId IS NOT OLD.serverDayId)
            OR (OLD.expectedRevision IS NOT NULL AND NEW.expectedRevision IS NOT OLD.expectedRevision))
        BEGIN SELECT RAISE(ABORT, 'contexto remoto inmutable durante el envio'); END
        """.trimIndent(),
        // ----------------------------------------------------------------------------------------- maquina de estados
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_state_update
        BEFORE UPDATE OF state ON sync_operations
        WHEN OLD.state <> NEW.state
        BEGIN
          SELECT RAISE(ABORT, 'transicion de estado invalida') WHERE (OLD.state || '>' || NEW.state) NOT IN ($ALLOWED_PAIRS);
          SELECT RAISE(ABORT, 'una intencion solo sale de LOCAL_ONLY sellada')
           WHERE OLD.state = 'LOCAL_ONLY' AND NEW.kind = 'SAVE_MARKS' AND NEW.sealedAtEpochMs IS NULL
             AND NEW.state NOT IN ('SUPERSEDED', 'DISCARDED');
          SELECT RAISE(ABORT, 'una operacion de marcas lista exige payload sellado y contexto remoto')
           WHERE NEW.kind = 'SAVE_MARKS' AND NEW.state IN ('READY', 'SENDING')
             AND (NEW.requestId IS NULL OR NEW.sealedAtEpochMs IS NULL OR NEW.serverDayId IS NULL OR NEW.expectedRevision IS NULL);
          SELECT RAISE(ABORT, 'el recibo del servidor esta incompleto')
           WHERE NEW.state = 'ACKNOWLEDGED' AND (NEW.ackRevision IS NULL OR NEW.ackedAtEpochMs IS NULL
                 OR (NEW.kind = 'SAVE_MARKS' AND NEW.serverDayId IS NULL));
          SELECT RAISE(ABORT, 'la operacion de la que depende aun no esta confirmada')
           WHERE NEW.state = 'READY' AND NEW.dependsOnOperationId IS NOT NULL
             AND COALESCE((SELECT o.state FROM sync_operations o WHERE o.id = NEW.dependsOnOperationId), '') <> 'ACKNOWLEDGED';
          SELECT RAISE(ABORT, 'ya hay una operacion lista o en envio para ese grupo y fecha')
           WHERE NEW.state IN ('READY', 'SENDING') AND EXISTS (SELECT 1 FROM sync_operations o WHERE o.profileId = NEW.profileId
                 AND o.groupId = NEW.groupId AND o.schoolDate = NEW.schoolDate AND o.state IN ('READY', 'SENDING') AND o.id <> NEW.id);
          SELECT RAISE(ABORT, 'el grupo ya no esta autorizado')
           WHERE NEW.state IN ('READY', 'SENDING')
             AND COALESCE((SELECT g.authState FROM school_groups g WHERE g.id = NEW.groupId AND g.profileId = NEW.profileId), '') <> 'ACTIVE';
        END
        """.trimIndent(),
        // ----------------------------------------------------------------------------------------------------- borrado
        """
        CREATE TRIGGER IF NOT EXISTS sync_ops_delete_guard BEFORE DELETE ON sync_operations
        WHEN OLD.state <> 'LOCAL_ONLY' AND EXISTS (SELECT 1 FROM profiles WHERE id = OLD.profileId)
        BEGIN SELECT RAISE(ABORT, 'las operaciones no se borran'); END
        """.trimIndent(),
        // ------------------------------------------------------------------------------------------------ payload sellado
        """
        CREATE TRIGGER IF NOT EXISTS sync_marks_insert_guard BEFORE INSERT ON sync_operation_marks
        BEGIN
          SELECT RAISE(ABORT, 'identificador de alumno invalido') WHERE length(NEW.studentRemoteId) <> 36 OR NEW.studentRemoteId <> lower(NEW.studentRemoteId);
          SELECT RAISE(ABORT, 'estado de marca invalido') WHERE NEW.status NOT IN ('present', 'absent');
          SELECT RAISE(ABORT, 'solo las operaciones de marcas llevan payload')
           WHERE COALESCE((SELECT o.kind FROM sync_operations o WHERE o.id = NEW.operationId), '') <> 'SAVE_MARKS';
          SELECT RAISE(ABORT, 'payload ya sellado')
           WHERE (SELECT o.sealedAtEpochMs FROM sync_operations o WHERE o.id = NEW.operationId) IS NOT NULL;
          SELECT RAISE(ABORT, 'alumno fuera del padron del borrador')
           WHERE NOT EXISTS (SELECT 1 FROM sync_operations o JOIN attendance_marks m ON m.draftId = o.draftId
                               JOIN students s ON s.id = m.studentId
                              WHERE o.id = NEW.operationId AND s.remoteId = NEW.studentRemoteId);
        END
        """.trimIndent(),
        """
        CREATE TRIGGER IF NOT EXISTS sync_marks_update_guard BEFORE UPDATE ON sync_operation_marks
        BEGIN SELECT RAISE(ABORT, 'payload sellado inmutable'); END
        """.trimIndent(),
        """
        CREATE TRIGGER IF NOT EXISTS sync_marks_delete_guard BEFORE DELETE ON sync_operation_marks
        WHEN EXISTS (SELECT 1 FROM sync_operations o WHERE o.id = OLD.operationId)
        BEGIN SELECT RAISE(ABORT, 'payload sellado inmutable'); END
        """.trimIndent(),
    )
}
