package mx.edu.eta15.prefectura.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Base local de la app de prefectura.
 *
 * - `version = 1`, `exportSchema = true` (esquemas versionados en `app/schemas`). NUNCA se usa
 *   `fallbackToDestructiveMigration`: un cambio de esquema exige una migracion escrita y probada.
 * - Room por si solo NO cifra los datos en reposo. En la etapa 1 solo se guardan datos sinteticos; el cifrado y la
 *   gestion de llaves (Android Keystore) deben disenarse ANTES de cargar datos escolares reales
 *   (ver docs/decisions/0005-android-autenticacion-movil.md).
 */
@Database(
    entities = [
        ProfileEntity::class,
        GroupEntity::class,
        StudentEntity::class,
        DraftEntity::class,
        MarkEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class EtaDatabase : RoomDatabase() {
    abstract fun catalogDao(): CatalogDao

    abstract fun draftDao(): DraftDao

    companion object {
        const val NAME = "eta15_local.db"

        /** Reglas que Room no expresa como anotaciones (equivalentes a los CHECK/triggers de PostgreSQL). */
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
            // La identidad del borrador es inmutable.
            """
            CREATE TRIGGER IF NOT EXISTS drafts_identity_update BEFORE UPDATE OF id, profileId, groupId, schoolDate, requestId ON attendance_drafts
            BEGIN SELECT RAISE(ABORT, 'identidad del borrador inmutable'); END
            """.trimIndent(),
        )

        fun build(context: Context): EtaDatabase =
            Room.databaseBuilder(context.applicationContext, EtaDatabase::class.java, NAME)
                .addCallback(integrityCallback)
                .build()

        fun inMemory(context: Context): EtaDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, EtaDatabase::class.java)
                .addCallback(integrityCallback)
                .build()
    }
}
