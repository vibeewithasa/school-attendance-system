package mx.edu.eta15.prefectura.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/*
 * Esquema Room v2 (solo datos SINTETICOS; ver docs/architecture/android-prefectura.md). La v2 agrega la CACHE OFFLINE del servidor de
 * PRUEBAS (grupos y padron autorizados) sin tocar las tablas de la v1 mas que con columnas nuevas y sin borrar nada.
 *
 * Integridad en la propia base (no solo en Kotlin), igual que en PostgreSQL:
 *  - un alumno pertenece a un grupo y un grupo a un perfil;
 *  - un borrador pertenece a un grupo DEL MISMO perfil (llave foranea compuesta);
 *  - una marca pertenece a un borrador y a un alumno DEL MISMO grupo (dos llaves foraneas compuestas);
 *  - un alumno aparece una sola vez por borrador (llave primaria compuesta) y hay un borrador por perfil+grupo+fecha;
 *  - la marca solo vale NULL (pendiente), PRESENT o ABSENT (disparadores en EtaDatabase).
 */

@Entity(tableName = "profiles")
data class ProfileEntity(
    @PrimaryKey val id: String,
    val displayName: String,
    val isDemo: Boolean,
    /** DEMO = datos locales de demostracion; SANDBOX = datos descargados del servidor de pruebas. Nunca se mezclan. */
    @ColumnInfo(defaultValue = "'DEMO'") val source: String = SOURCE_DEMO,
) {
    companion object {
        const val SOURCE_DEMO = "DEMO"
        const val SOURCE_SANDBOX = "SANDBOX"
    }
}

@Entity(
    tableName = "school_groups",
    foreignKeys = [
        ForeignKey(
            entity = ProfileEntity::class,
            parentColumns = ["id"],
            childColumns = ["profileId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("profileId"), Index(value = ["id", "profileId"], unique = true)],
)
data class GroupEntity(
    @PrimaryKey val id: String,
    val profileId: String,
    val name: String,
    val grade: Int,
    val sortOrder: Int,
    /** Identificador del grupo en el servidor (el id local lleva el perfil como prefijo). NULL en la demostracion. */
    val remoteId: String? = null,
    val schoolYearId: String? = null,
    val schoolYearName: String? = null,
    val shift: String? = null,
    /** ACTIVE o REVOKED (el grupo dejo de estar autorizado: se bloquea su padron y se conservan los borradores). */
    @ColumnInfo(defaultValue = "'ACTIVE'") val authState: String = AUTH_ACTIVE,
) {
    companion object {
        const val AUTH_ACTIVE = "ACTIVE"
        const val AUTH_REVOKED = "REVOKED"
    }
}

@Entity(
    tableName = "students",
    foreignKeys = [
        ForeignKey(
            entity = GroupEntity::class,
            parentColumns = ["id"],
            childColumns = ["groupId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("groupId"), Index(value = ["id", "groupId"], unique = true)],
)
data class StudentEntity(
    @PrimaryKey val id: String,
    val groupId: String,
    val givenNames: String,
    val familyName: String,
    val remoteId: String? = null,
    /** 0 = el alumno ya no aparece en el padron descargado (se conserva la fila: los borradores previos la referencian). */
    @ColumnInfo(defaultValue = "1") val active: Int = 1,
)

@Entity(
    tableName = "attendance_drafts",
    foreignKeys = [
        ForeignKey(
            entity = GroupEntity::class,
            parentColumns = ["id", "profileId"],
            childColumns = ["groupId", "profileId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index(value = ["profileId", "groupId", "schoolDate"], unique = true),
        Index(value = ["requestId"], unique = true),
        Index(value = ["id", "groupId"], unique = true),
        Index(value = ["groupId", "profileId"]),
    ],
)
data class DraftEntity(
    @PrimaryKey val id: String,
    val profileId: String,
    val groupId: String,
    /** Fecha escolar ISO (aaaa-mm-dd) de DEMOSTRACION; no es una fecha oficial. */
    val schoolDate: String,
    /** Identificador estable de la operacion (futuro requestId idempotente). Hoy no se envia. */
    val requestId: String,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
    /** Huella del padron con el que se creo el borrador (la v1 y la demostracion la dejan en NULL). */
    val rosterDigest: String? = null,
    /** 1 = hay una discrepancia (p. ej. el padron cambio) que una persona debe revisar; el borrador no se modifica. */
    @ColumnInfo(defaultValue = "0") val needsReview: Int = 0,
    val reviewReason: String? = null,
)

@Entity(
    tableName = "attendance_marks",
    primaryKeys = ["draftId", "studentId"],
    foreignKeys = [
        ForeignKey(
            entity = DraftEntity::class,
            parentColumns = ["id", "groupId"],
            childColumns = ["draftId", "groupId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = StudentEntity::class,
            parentColumns = ["id", "groupId"],
            childColumns = ["studentId", "groupId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["studentId", "groupId"]), Index(value = ["draftId", "groupId"])],
)
data class MarkEntity(
    val draftId: String,
    val groupId: String,
    val studentId: String,
    /** NULL = pendiente; "PRESENT" o "ABSENT" = marca definitiva de captura. */
    val status: String?,
    val markedAtEpochMs: Long?,
)

/**
 * Ultima descarga COMPLETA del padron de un grupo. El servidor no entrega una version del padron: la huella es SHA-256 local del
 * conjunto de alumnos descargado (identificador, nombres) y sirve solo para detectar cambios entre descargas.
 */
@Entity(
    tableName = "roster_snapshots",
    foreignKeys = [
        ForeignKey(
            entity = GroupEntity::class,
            parentColumns = ["id"],
            childColumns = ["groupId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
)
data class RosterSnapshotEntity(
    @PrimaryKey val groupId: String,
    val downloadedAtEpochMs: Long,
    /** "asOf" del servidor (fecha escolar America/Mazatlan en el momento de la descarga). */
    val serverSchoolDate: String,
    val rosterDigest: String,
    val studentCount: Int,
)

/** Estado de sincronizacion y autorizacion conocida de un perfil descargado (una fila por perfil SANDBOX). */
@Entity(
    tableName = "profile_sync",
    foreignKeys = [
        ForeignKey(
            entity = ProfileEntity::class,
            parentColumns = ["id"],
            childColumns = ["profileId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
)
data class ProfileSyncEntity(
    @PrimaryKey val profileId: String,
    /** Dispositivo del servidor al que pertenece el perfil (la cache es de esa identidad y de ninguna otra). */
    val deviceId: String,
    val lastServerContactEpochMs: Long,
    val serverSchoolDate: String,
    val lastDownloadAtEpochMs: Long,
    /** Fin de la vigencia offline de DEMOSTRACION (SANDBOX ONLY; la escuela no ha aprobado ninguna politica). */
    val authorizedUntilEpochMs: Long,
    /** ACTIVE, DEVICE_REVOKED o ACCOUNT_BLOCKED: lo ultimo que el servidor informo. Offline no puede conocerse un cambio posterior. */
    @ColumnInfo(defaultValue = "'ACTIVE'") val authState: String = "ACTIVE",
    /** Mayor instante visto en este dispositivo: si el reloj retrocede, se detecta y se exige reconexion. */
    val highWaterEpochMs: Long,
)

/** Proyecciones de lectura (no son tablas). */
data class GroupRow(
    val id: String,
    val name: String,
    val grade: Int,
    val studentCount: Int,
    val markedToday: Int,
    val hasDraftToday: Int,
    val authState: String,
    val downloadedAtEpochMs: Long?,
    val needsReview: Int,
)

data class RosterRow(
    val studentId: String,
    val givenNames: String,
    val familyName: String,
    val status: String?,
)
