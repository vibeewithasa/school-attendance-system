package mx.edu.eta15.prefectura.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Base local de la app de prefectura.
 *
 * - `version = 2`, `exportSchema = true` (esquemas versionados en `app/schemas`). NUNCA se usa
 *   `fallbackToDestructiveMigration`: un cambio de esquema exige una migracion escrita y probada.
 * - Room por si solo NO cifra. En la app real SIEMPRE se abre mediante `SecureStorage` (SQLCipher + clave protegida por
 *   Android Keystore); aqui solo queda el constructor en memoria para pruebas. Cifrar la base NO habilita datos escolares
 *   reales: faltan autenticacion, revocacion y decisiones institucionales (docs/decisions/0005-android-autenticacion-movil.md).
 */
@Database(
    entities = [
        ProfileEntity::class,
        GroupEntity::class,
        StudentEntity::class,
        DraftEntity::class,
        MarkEntity::class,
        RosterSnapshotEntity::class,
        ProfileSyncEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class EtaDatabase : RoomDatabase() {
    abstract fun catalogDao(): CatalogDao

    abstract fun draftDao(): DraftDao

    abstract fun cacheDao(): CacheDao

    companion object {
        /** Reglas que Room no expresa como anotaciones (equivalentes a los CHECK/triggers de PostgreSQL). */
        /**
         * v1 -> v2: cache offline. Solo AGREGA columnas con valor por omision y dos tablas; no recrea ni borra nada, de modo que
         * una instalacion con datos de demostracion o borradores conserva TODO (se prueba en SchemaMigrationTest).
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                listOf(
                    "ALTER TABLE profiles ADD COLUMN source TEXT NOT NULL DEFAULT 'DEMO'",
                    "ALTER TABLE school_groups ADD COLUMN remoteId TEXT",
                    "ALTER TABLE school_groups ADD COLUMN schoolYearId TEXT",
                    "ALTER TABLE school_groups ADD COLUMN schoolYearName TEXT",
                    "ALTER TABLE school_groups ADD COLUMN shift TEXT",
                    "ALTER TABLE school_groups ADD COLUMN authState TEXT NOT NULL DEFAULT 'ACTIVE'",
                    "ALTER TABLE students ADD COLUMN remoteId TEXT",
                    "ALTER TABLE students ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
                    "ALTER TABLE attendance_drafts ADD COLUMN rosterDigest TEXT",
                    "ALTER TABLE attendance_drafts ADD COLUMN needsReview INTEGER NOT NULL DEFAULT 0",
                    "ALTER TABLE attendance_drafts ADD COLUMN reviewReason TEXT",
                    """
                    CREATE TABLE IF NOT EXISTS roster_snapshots (
                        groupId TEXT NOT NULL, downloadedAtEpochMs INTEGER NOT NULL, serverSchoolDate TEXT NOT NULL,
                        rosterDigest TEXT NOT NULL, studentCount INTEGER NOT NULL, PRIMARY KEY(groupId),
                        FOREIGN KEY(groupId) REFERENCES school_groups(id) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                    """
                    CREATE TABLE IF NOT EXISTS profile_sync (
                        profileId TEXT NOT NULL, deviceId TEXT NOT NULL, lastServerContactEpochMs INTEGER NOT NULL,
                        serverSchoolDate TEXT NOT NULL, lastDownloadAtEpochMs INTEGER NOT NULL, authorizedUntilEpochMs INTEGER NOT NULL,
                        authState TEXT NOT NULL DEFAULT 'ACTIVE', highWaterEpochMs INTEGER NOT NULL, PRIMARY KEY(profileId),
                        FOREIGN KEY(profileId) REFERENCES profiles(id) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                ).forEach(db::execSQL)
            }
        }

        val integrityCallback = object : Callback() {
            override fun onOpen(db: SupportSQLiteDatabase) {
                super.onOpen(db)
                INTEGRITY_SQL.forEach(db::execSQL)
            }
        }

        private val INTEGRITY_SQL = listOf(
            // Solo NULL (pendiente), PRESENT o ABSENT son valores de marca.
            """
            CREATE TRIGGER IF NOT EXISTS marks_status_insert BEFORE INSERT ON attendance_marks
            WHEN NEW.status IS NOT NULL AND NEW.status NOT IN ('PRESENT', 'ABSENT')
            BEGIN SELECT RAISE(ABORT, 'estado de marca invalido'); END
            """.trimIndent(),
            """
            CREATE TRIGGER IF NOT EXISTS marks_status_update BEFORE UPDATE OF status ON attendance_marks
            WHEN NEW.status IS NOT NULL AND NEW.status NOT IN ('PRESENT', 'ABSENT')
            BEGIN SELECT RAISE(ABORT, 'estado de marca invalido'); END
            """.trimIndent(),
            // Un borrador nuevo nunca nace en sabado ni domingo (strftime %w: 0 = domingo, 6 = sabado).
            """
            CREATE TRIGGER IF NOT EXISTS drafts_school_day_insert BEFORE INSERT ON attendance_drafts
            WHEN strftime('%w', NEW.schoolDate) IN ('0', '6') OR strftime('%w', NEW.schoolDate) IS NULL
            BEGIN SELECT RAISE(ABORT, 'fecha escolar invalida'); END
            """.trimIndent(),
            // Un borrador nuevo no nace en un grupo cuya autorizacion fue revocada.
            """
            CREATE TRIGGER IF NOT EXISTS drafts_group_revoked_insert BEFORE INSERT ON attendance_drafts
            WHEN (SELECT authState FROM school_groups WHERE id = NEW.groupId) <> 'ACTIVE'
            BEGIN SELECT RAISE(ABORT, 'grupo revocado'); END
            """.trimIndent(),
            // Las marcas de un grupo revocado quedan CONSERVADAS pero congeladas (no se capturan ni se alteran).
            """
            CREATE TRIGGER IF NOT EXISTS marks_group_revoked_update BEFORE UPDATE OF status ON attendance_marks
            WHEN (SELECT authState FROM school_groups WHERE id = NEW.groupId) <> 'ACTIVE'
            BEGIN SELECT RAISE(ABORT, 'grupo revocado'); END
            """.trimIndent(),
            // El padron con el que se hizo un borrador es una referencia historica: una vez fijado no cambia.
            """
            CREATE TRIGGER IF NOT EXISTS drafts_digest_update BEFORE UPDATE OF rosterDigest ON attendance_drafts
            WHEN OLD.rosterDigest IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'padron de referencia inmutable'); END
            """.trimIndent(),
            // La identidad del borrador es inmutable.
            """
            CREATE TRIGGER IF NOT EXISTS drafts_identity_update BEFORE UPDATE OF id, profileId, groupId, schoolDate, requestId ON attendance_drafts
            BEGIN SELECT RAISE(ABORT, 'identidad del borrador inmutable'); END
            """.trimIndent(),
        )

        fun inMemory(context: Context): EtaDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, EtaDatabase::class.java)
                .addMigrations(MIGRATION_1_2)
                .addCallback(integrityCallback)
                .build()
    }
}
