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
    ],
    version = 1,
    exportSchema = true,
)
abstract class EtaDatabase : RoomDatabase() {
    abstract fun catalogDao(): CatalogDao

    abstract fun draftDao(): DraftDao

    companion object {
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

        fun inMemory(context: Context): EtaDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, EtaDatabase::class.java)
                .addCallback(integrityCallback)
                .build()
    }
}
