package mx.edu.eta15.prefectura.data.local

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/*
 * Esquema Room v1 (solo datos SINTETICOS en la etapa 1; ver docs/architecture/android-prefectura.md).
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
)

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
)

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

/** Proyecciones de lectura (no son tablas). */
data class GroupRow(
    val id: String,
    val name: String,
    val grade: Int,
    val studentCount: Int,
    val markedToday: Int,
    val hasDraftToday: Int,
)

data class RosterRow(
    val studentId: String,
    val givenNames: String,
    val familyName: String,
    val status: String?,
)
