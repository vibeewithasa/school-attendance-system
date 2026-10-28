package mx.edu.eta15.prefectura.data.secure

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import mx.edu.eta15.prefectura.data.local.EtaDatabase
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

/**
 * Abre la base local CIFRADA (Room + SQLCipher) y administra su ciclo de vida. Politica FAIL CLOSED:
 *
 * | Base cifrada | Clave envuelta | Clave Keystore | Resultado                                                      |
 * |--------------|----------------|----------------|----------------------------------------------------------------|
 * | si           | si             | si             | se abre; si no abre (clave erronea/archivo danado) => error    |
 * | si           | falta alguna   | -              | ERROR `KeyMissing`: no se crea clave ni base nueva ni se borra |
 * | no           | -              | -              | se crea clave nueva; si hay base anterior sin cifrar se CONVIERTE |
 *
 * Una base anterior sin cifrar (`eta15_local.db`, solo datos de demostracion) se convierte copiando todas las filas a un
 * archivo temporal cifrado, verificando conteos, integridad, llaves foraneas y una huella SHA-256 del contenido, y solo
 * entonces se renombra de forma atomica y se retira la copia sin cifrar. Si algo falla, la base anterior queda intacta.
 * Nunca se usa para informacion escolar real (la app no la tiene en esta etapa).
 */
class SecureStorage(
    private val context: Context,
    private val vault: KeyVault = KeystoreKeyVault(context),
    private val secureName: String = SECURE_NAME,
    private val legacyName: String = LEGACY_NAME,
) {
    private val secureFile get() = context.getDatabasePath(secureName)
    private val legacyFile get() = context.getDatabasePath(legacyName)
    private val tmpName get() = "$secureName.converting"

    /**
     * Abre (o crea) la base cifrada. Operacion bloqueante: llamar fuera del hilo principal. Esta serializada en TODO el proceso: el
     * primer arranque puede abrirse desde dos sitios a la vez (el contenedor de la aplicacion y un reintento) y, sin el cerrojo, uno
     * retira la clave que el otro acaba de crear y la base queda cifrada con una clave perdida (auditoria 45, reproducido con una prueba).
     */
    fun open(): EtaDatabase = synchronized(OPEN_LOCK) { openSerialized() }

    private fun openSerialized(): EtaDatabase {
        loadNativeLibrary()
        cleanupInterruptedConversion()
        if (secureFile.exists()) {
            if (!vault.hasWrappedKey() || !vault.hasKeystoreKey()) {
                throw StorageException.KeyMissing("Existe la base cifrada pero falta su clave: no se crea una nueva ni se borra nada")
            }
            val key = vault.load()
            try {
                val db = openRoom(secureName, key)
                // Conversion terminada pero interrumpida antes de retirar la copia sin cifrar.
                if (legacyFile.exists()) shredDatabaseFiles(legacyFile)
                return db
            } finally {
                key.fill(0)
            }
        }
        // Sin base cifrada: ninguna base protegida depende de las piezas de clave, asi que unas piezas inconsistentes
        // (p. ej. un primer arranque interrumpido) se pueden rehacer sin perder nada.
        val key = if (vault.hasWrappedKey() && vault.hasKeystoreKey()) {
            vault.load()
        } else {
            vault.destroy()
            vault.createAndStore()
        }
        try {
            if (legacyFile.exists()) convertLegacy(key)
            return openRoom(secureName, key)
        } finally {
            key.fill(0)
        }
    }

    /**
     * Borrado local EXPLICITO y autorizado: elimina la base cifrada, los restos de conversion, la base anterior y las
     * claves. La base debe estar cerrada. Nunca se llama de forma automatica ante un error.
     */
    fun wipeAll() {
        deleteDatabaseFiles(secureFile)
        deleteDatabaseFiles(context.getDatabasePath(tmpName))
        deleteDatabaseFiles(legacyFile)
        vault.destroy()
    }

    // ---------------------------------------------------------------- Room cifrada

    private fun openRoom(name: String, key: ByteArray): EtaDatabase {
        // Clave en formato binario de SQLCipher x'<64 hex>': se usa directamente (sin derivacion PBKDF2, ya es aleatoria).
        val factory = SupportOpenHelperFactory(rawKeyPassphrase(key))
        val db = Room.databaseBuilder(context, EtaDatabase::class.java, name)
            .openHelperFactory(factory)
            .addMigrations(EtaDatabase.MIGRATION_1_2, EtaDatabase.MIGRATION_2_3)
            .addCallback(EtaDatabase.integrityCallback)
            .build()
        try {
            db.openHelper.writableDatabase // fuerza la apertura: clave erronea o archivo danado fallan AQUI
        } catch (e: Exception) {
            runCatching { db.close() }
            throw StorageException.DatabaseUnreadable(e)
        }
        return db
    }

    // ---------------------------------------------------------------- conversion de la base anterior

    private fun convertLegacy(key: ByteArray) {
        val legacy = legacyFile
        if (!hasPlainSqliteHeader(legacy)) {
            throw StorageException.UnknownLegacyFormat("La base anterior no es una base SQLite sin cifrar reconocida: no se modifica")
        }
        val tmp = context.getDatabasePath(tmpName)
        deleteDatabaseFiles(tmp)
        val source = try {
            SQLiteDatabase.openDatabase(legacy.path, null, SQLiteDatabase.OPEN_READWRITE)
        } catch (e: Exception) {
            throw StorageException.ConversionFailed("No se pudo leer la base anterior", e)
        }
        try {
            if (source.version !in LEGACY_VERSIONS) {
                throw StorageException.UnknownLegacyFormat("La base anterior tiene una version de esquema desconocida: no se modifica")
            }
            if (!pragmaIsOk(source, "PRAGMA integrity_check")) {
                throw StorageException.ConversionFailed("La base anterior no pasa la comprobacion de integridad")
            }
            // v1 = instalaciones de la etapa 1; v2 solo existe para pruebas (la cache offline v2 nace ya cifrada).
            val tables = if (source.version >= 2) TABLES + TABLES_V2 else TABLES
            // La verificacion compara SOLO las columnas que existian en la base anterior: la v2 agrega columnas con valor por
            // omision (no son parte de lo que se convierte) y no deben hacer fallar la comparacion de contenido.
            val columns = tables.associateWith { columnsOf(source, it.name) }
            val sourceDigests = tables.associateWith { digest(source, it, columns.getValue(it)) }
            val sourceCounts = tables.associateWith { count(source, it.name) }

            val target = openRoom(tmpName, key)
            try {
                val dst = target.openHelper.writableDatabase
                dst.beginTransaction()
                try {
                    for (t in tables) copyTable(source, dst, t)
                    dst.setTransactionSuccessful()
                } finally {
                    dst.endTransaction()
                }
                dst.query("PRAGMA wal_checkpoint(TRUNCATE)").use { it.moveToFirst() }
            } finally {
                target.close()
            }
            // Verificacion sobre el archivo YA persistido y reabierto con la clave.
            val check = openRoom(tmpName, key)
            try {
                val dst = check.openHelper.writableDatabase
                dst.query("PRAGMA foreign_key_check").use { c ->
                    if (c.count != 0) throw StorageException.ConversionFailed("La copia cifrada viola llaves foraneas")
                }
                dst.query("PRAGMA integrity_check").use { c ->
                    if (!c.moveToFirst() || c.getString(0) != "ok") throw StorageException.ConversionFailed("La copia cifrada no pasa la integridad")
                }
                for (t in tables) {
                    val n = dst.query("SELECT COUNT(*) FROM ${t.name}").use { c -> c.moveToFirst(); c.getInt(0) }
                    if (n != sourceCounts.getValue(t)) throw StorageException.ConversionFailed("Conteo distinto en ${t.name}")
                }
                for (t in tables) {
                    if (!digestOf(dst.query(selectAll(t, columns.getValue(t))), t).contentEquals(sourceDigests.getValue(t))) {
                        throw StorageException.ConversionFailed("El contenido de ${t.name} no coincide")
                    }
                }
            } finally {
                check.close()
            }
        } catch (e: StorageException) {
            deleteDatabaseFiles(tmp) // la base anterior queda intacta
            throw e
        } catch (e: Exception) {
            deleteDatabaseFiles(tmp)
            throw StorageException.ConversionFailed("Fallo la conversion a almacenamiento cifrado", e)
        } finally {
            source.close()
        }
        // Todo verificado: sin -wal/-shm residuales y renombrado atomico; solo entonces se retira la copia sin cifrar.
        File(tmp.path + "-wal").delete()
        File(tmp.path + "-shm").delete()
        File(tmp.path + "-journal").delete()
        Files.move(tmp.toPath(), secureFile.toPath(), StandardCopyOption.ATOMIC_MOVE)
        shredDatabaseFiles(legacy)
    }

    private data class Table(val name: String, val orderBy: String)

    private fun selectAll(t: Table, columns: List<String>? = null) =
        "SELECT ${columns?.joinToString(", ") ?: "*"} FROM ${t.name} ORDER BY ${t.orderBy}"

    private fun columnsOf(db: SQLiteDatabase, table: String): List<String> =
        db.rawQuery("PRAGMA table_info($table)", null).use { c -> buildList { while (c.moveToNext()) add(c.getString(1)) } }

    private fun copyTable(source: SQLiteDatabase, dst: androidx.sqlite.db.SupportSQLiteDatabase, t: Table) {
        source.rawQuery(selectAll(t), null).use { c ->
            while (c.moveToNext()) {
                val values = ContentValues()
                for (i in 0 until c.columnCount) {
                    val col = c.getColumnName(i)
                    when (c.getType(i)) {
                        Cursor.FIELD_TYPE_NULL -> values.putNull(col)
                        Cursor.FIELD_TYPE_INTEGER -> values.put(col, c.getLong(i))
                        Cursor.FIELD_TYPE_FLOAT -> values.put(col, c.getDouble(i))
                        Cursor.FIELD_TYPE_BLOB -> values.put(col, c.getBlob(i))
                        else -> values.put(col, c.getString(i))
                    }
                }
                if (dst.insert(t.name, SQLiteDatabase.CONFLICT_ABORT, values) < 0) {
                    throw StorageException.ConversionFailed("No se pudo copiar una fila de ${t.name}")
                }
            }
        }
    }

    private fun count(db: SQLiteDatabase, table: String): Int =
        db.rawQuery("SELECT COUNT(*) FROM $table", null).use { it.moveToFirst(); it.getInt(0) }

    private fun pragmaIsOk(db: SQLiteDatabase, sql: String): Boolean =
        db.rawQuery(sql, null).use { it.moveToFirst() && it.getString(0) == "ok" }

    private fun digest(db: SQLiteDatabase, t: Table, columns: List<String>): ByteArray =
        digestOf(db.rawQuery(selectAll(t, columns), null), t)

    private fun digestOf(cursor: Cursor, @Suppress("UNUSED_PARAMETER") t: Table): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        cursor.use { c ->
            while (c.moveToNext()) {
                for (i in 0 until c.columnCount) {
                    val cell = when (c.getType(i)) {
                        Cursor.FIELD_TYPE_NULL -> "N"
                        Cursor.FIELD_TYPE_INTEGER -> "I" + c.getLong(i)
                        Cursor.FIELD_TYPE_FLOAT -> "F" + c.getDouble(i)
                        Cursor.FIELD_TYPE_BLOB -> "B" + c.getBlob(i).joinToString("") { "%02x".format(it) }
                        else -> "S" + c.getString(i)
                    }
                    md.update(cell.toByteArray(Charsets.UTF_8))
                    md.update(0x1F)
                }
                md.update(0x1E)
            }
        }
        return md.digest()
    }

    // ---------------------------------------------------------------- archivos

    private fun cleanupInterruptedConversion() {
        // Un archivo temporal es de una conversion interrumpida ANTES del renombrado: la base anterior sigue intacta.
        val tmp = context.getDatabasePath(tmpName)
        if (!secureFile.exists()) deleteDatabaseFiles(tmp)
    }

    companion object {
        /** Cerrojo de todo el proceso para abrir/crear la base y su clave (ver [open]). */
        private val OPEN_LOCK = Any()

        /** Base cifrada. */
        const val SECURE_NAME = "eta15_secure.db"

        /** Base anterior SIN cifrar de las instalaciones debug de la etapa 1 (solo datos de demostracion). */
        const val LEGACY_NAME = "eta15_local.db"

        private val LEGACY_VERSIONS = 1..2

        // Orden de copia = orden de dependencias de llaves foraneas.
        private val TABLES = listOf(
            Table("profiles", "id"),
            Table("school_groups", "id"),
            Table("students", "id"),
            Table("attendance_drafts", "id"),
            Table("attendance_marks", "draftId, studentId"),
        )

        // Tablas de la v2 (cache offline), tambien en orden de dependencias.
        private val TABLES_V2 = listOf(
            Table("roster_snapshots", "groupId"),
            Table("profile_sync", "profileId"),
        )

        private val PLAIN_HEADER = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)

        @Volatile
        private var nativeLoaded = false

        fun loadNativeLibrary() {
            if (!nativeLoaded) {
                synchronized(this) {
                    if (!nativeLoaded) {
                        System.loadLibrary("sqlcipher")
                        nativeLoaded = true
                    }
                }
            }
        }

        /** `x'<hex>'` como bytes ASCII (formato de clave binaria de SQLCipher). Quien llama debe poner a cero el resultado. */
        internal fun rawKeyPassphrase(key: ByteArray): ByteArray {
            require(key.size == 32) { "La clave debe ser de 256 bits" }
            val hex = "0123456789abcdef"
            val out = ByteArray(2 + key.size * 2 + 1)
            out[0] = 'x'.code.toByte()
            out[1] = '\''.code.toByte()
            key.forEachIndexed { i, b ->
                out[2 + i * 2] = hex[(b.toInt() shr 4) and 0xF].code.toByte()
                out[3 + i * 2] = hex[b.toInt() and 0xF].code.toByte()
            }
            out[out.size - 1] = '\''.code.toByte()
            return out
        }

        fun hasPlainSqliteHeader(file: File): Boolean = try {
            file.inputStream().use { input ->
                val head = ByteArray(PLAIN_HEADER.size)
                input.read(head) == head.size && head.contentEquals(PLAIN_HEADER)
            }
        } catch (_: java.io.IOException) {
            false
        }

        fun deleteDatabaseFiles(file: File) {
            for (suffix in DB_SUFFIXES) File(file.path + suffix).delete()
        }

        /**
         * Sobrescribe con ceros y elimina una base (y sus -wal/-shm/-journal) que contenia datos EN CLARO. Es de MEJOR
         * ESFUERZO: en almacenamiento flash (wear-leveling, journaling del sistema de archivos, copias del controlador)
         * borrar o sobrescribir un archivo NO garantiza que los bloques anteriores sean irrecuperables. Por eso la
         * conversion solo se admite con datos de demostracion y el cifrado de la base nueva es la proteccion real.
         */
        fun shredDatabaseFiles(file: File) {
            for (suffix in DB_SUFFIXES) {
                val f = File(file.path + suffix)
                if (!f.exists()) continue
                runCatching {
                    java.io.RandomAccessFile(f, "rws").use { raf ->
                        val zeros = ByteArray(8192)
                        var left = raf.length()
                        raf.seek(0)
                        while (left > 0) {
                            val n = minOf(left, zeros.size.toLong()).toInt()
                            raf.write(zeros, 0, n)
                            left -= n
                        }
                        raf.fd.sync()
                    }
                }
                f.delete()
            }
        }

        private val DB_SUFFIXES = listOf("", "-wal", "-shm", "-journal")
    }
}
