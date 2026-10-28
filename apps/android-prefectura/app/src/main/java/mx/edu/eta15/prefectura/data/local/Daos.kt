package mx.edu.eta15.prefectura.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface CatalogDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertProfile(profile: ProfileEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertGroups(groups: List<GroupEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertStudents(students: List<StudentEntity>)

    @Query("SELECT * FROM profiles WHERE id = :profileId")
    fun observeProfile(profileId: String): Flow<ProfileEntity?>

    @Query("SELECT COUNT(*) FROM profiles")
    suspend fun profileCount(): Int

    /** Borrado local controlado: elimina el perfil y, en cascada, grupos, alumnos, borradores y marcas. */
    @Query("DELETE FROM profiles")
    suspend fun deleteAllProfiles()

    /** Borrado local controlado de UN perfil (cierre de sesion/cambio de titular): los demas perfiles no se tocan. */
    @Query("DELETE FROM profiles WHERE id = :profileId")
    suspend fun deleteProfile(profileId: String): Int

    @Query(
        """
        SELECT g.id AS id, g.name AS name, g.grade AS grade,
               (SELECT COUNT(*) FROM students s WHERE s.groupId = g.id AND s.active = 1) AS studentCount,
               (SELECT COUNT(*) FROM attendance_marks m
                  JOIN attendance_drafts d ON d.id = m.draftId
                 WHERE d.groupId = g.id AND d.profileId = :profileId AND d.schoolDate = :date
                   AND m.status IS NOT NULL) AS markedToday,
               (SELECT COUNT(*) FROM attendance_drafts d
                 WHERE d.groupId = g.id AND d.profileId = :profileId AND d.schoolDate = :date) AS hasDraftToday,
               g.authState AS authState,
               (SELECT r.downloadedAtEpochMs FROM roster_snapshots r WHERE r.groupId = g.id) AS downloadedAtEpochMs,
               (SELECT COUNT(*) FROM attendance_drafts d
                 WHERE d.groupId = g.id AND d.profileId = :profileId AND d.needsReview = 1) AS needsReview
          FROM school_groups g
         WHERE g.profileId = :profileId
         ORDER BY g.sortOrder, g.name
        """,
    )
    fun observeGroups(profileId: String, date: String): Flow<List<GroupRow>>

    @Query("SELECT name FROM school_groups WHERE id = :groupId AND profileId = :profileId")
    fun observeGroupName(profileId: String, groupId: String): Flow<String?>

    @Query(
        """
        SELECT s.* FROM students s
          JOIN school_groups g ON g.id = s.groupId
         WHERE s.groupId = :groupId AND g.profileId = :profileId AND s.active = 1
         ORDER BY s.familyName, s.givenNames, s.id
        """,
    )
    fun observeStudents(profileId: String, groupId: String): Flow<List<StudentEntity>>

    @Query(
        """
        SELECT s.* FROM students s
          JOIN school_groups g ON g.id = s.groupId
         WHERE s.groupId = :groupId AND g.profileId = :profileId AND s.active = 1
        """,
    )
    suspend fun studentsOf(profileId: String, groupId: String): List<StudentEntity>

    @Query("SELECT COUNT(*) FROM school_groups WHERE id = :groupId AND profileId = :profileId")
    suspend fun groupExists(profileId: String, groupId: String): Int

    @Query("SELECT authState FROM school_groups WHERE id = :groupId AND profileId = :profileId")
    suspend fun groupAuthState(profileId: String, groupId: String): String?

    @Query("SELECT authState FROM school_groups WHERE id = :groupId AND profileId = :profileId")
    fun observeGroupAuthState(profileId: String, groupId: String): Flow<String?>

    @Query("SELECT rosterDigest FROM roster_snapshots WHERE groupId = :groupId")
    suspend fun rosterDigestOf(groupId: String): String?
}

/** Persistencia de la CACHE OFFLINE (perfiles SANDBOX). Nunca usa REPLACE: borraria en cascada borradores y marcas. */
@Dao
interface CacheDao {
    @Upsert
    suspend fun upsertProfile(profile: ProfileEntity)

    @Upsert
    suspend fun upsertGroup(group: GroupEntity)

    @Upsert
    suspend fun upsertStudents(students: List<StudentEntity>)

    @Upsert
    suspend fun upsertSnapshot(snapshot: RosterSnapshotEntity)

    @Upsert
    suspend fun upsertSync(sync: ProfileSyncEntity)

    @Query("SELECT * FROM school_groups WHERE profileId = :profileId")
    suspend fun groupsOf(profileId: String): List<GroupEntity>

    @Query("SELECT id FROM students WHERE groupId = :groupId AND active = 1")
    suspend fun activeStudentIds(groupId: String): List<String>

    /** Alumnos que ya no figuran en el padron descargado: se desactivan (no se borran: los borradores previos los referencian). */
    @Query("UPDATE students SET active = 0 WHERE groupId = :groupId AND active = 1 AND id NOT IN (:keep)")
    suspend fun deactivateMissing(groupId: String, keep: List<String>): Int

    @Query("UPDATE students SET active = 0 WHERE groupId = :groupId AND active = 1")
    suspend fun deactivateAll(groupId: String): Int

    @Query("UPDATE school_groups SET authState = 'REVOKED' WHERE profileId = :profileId AND id = :groupId")
    suspend fun revokeGroup(profileId: String, groupId: String): Int

    /** Marca para revision los borradores hechos con OTRO padron; no toca sus marcas. */
    @Query(
        """
        UPDATE attendance_drafts SET needsReview = 1, reviewReason = :reason
         WHERE profileId = :profileId AND groupId = :groupId AND rosterDigest IS NOT NULL AND rosterDigest <> :digest AND needsReview = 0
        """,
    )
    suspend fun flagDraftsForReview(profileId: String, groupId: String, digest: String, reason: String): Int

    @Query("UPDATE attendance_drafts SET needsReview = 1, reviewReason = :reason WHERE profileId = :profileId AND groupId = :groupId AND needsReview = 0")
    suspend fun flagAllDraftsOfGroup(profileId: String, groupId: String, reason: String): Int

    @Query("SELECT * FROM profile_sync WHERE profileId = :profileId")
    suspend fun syncOf(profileId: String): ProfileSyncEntity?

    @Query("SELECT * FROM profile_sync WHERE profileId = :profileId")
    fun observeSync(profileId: String): Flow<ProfileSyncEntity?>

    @Query("UPDATE profile_sync SET authState = :state, lastServerContactEpochMs = :at WHERE profileId = :profileId")
    suspend fun setAuthState(profileId: String, state: String, at: Long): Int

    @Query("UPDATE profile_sync SET highWaterEpochMs = :at WHERE profileId = :profileId AND highWaterEpochMs < :at")
    suspend fun raiseHighWater(profileId: String, at: Long): Int

    @Query("SELECT COUNT(*) FROM profiles WHERE id = :profileId")
    suspend fun profileExists(profileId: String): Int

    @Query("SELECT COUNT(*) FROM attendance_drafts WHERE profileId = :profileId")
    suspend fun draftCount(profileId: String): Int

    /** Borrado EXPLICITO de un perfil descargado (grupos, padrones, borradores y marcas en cascada). Nunca ocurre solo. */
    @Query("DELETE FROM profiles WHERE id = :profileId AND source = 'SANDBOX'")
    suspend fun purgeSandboxProfile(profileId: String): Int
}

@Dao
interface DraftDao {
    @Query(
        "SELECT id FROM attendance_drafts WHERE profileId = :profileId AND groupId = :groupId AND schoolDate = :date",
    )
    suspend fun findDraftId(profileId: String, groupId: String, date: String): String?

    @Query("SELECT * FROM attendance_drafts WHERE id = :draftId AND profileId = :profileId")
    suspend fun findDraft(profileId: String, draftId: String): DraftEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertDraft(draft: DraftEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertMarks(marks: List<MarkEntity>)

    @Query(
        "SELECT * FROM attendance_drafts WHERE profileId = :profileId AND groupId = :groupId AND schoolDate = :date",
    )
    fun observeDraft(profileId: String, groupId: String, date: String): Flow<DraftEntity?>

    @Query(
        """
        SELECT s.id AS studentId, s.givenNames AS givenNames, s.familyName AS familyName, m.status AS status
          FROM attendance_marks m
          JOIN students s ON s.id = m.studentId
         WHERE m.draftId = :draftId
         ORDER BY s.familyName, s.givenNames, s.id
        """,
    )
    fun observeRows(draftId: String): Flow<List<RosterRow>>

    @Query(
        "UPDATE attendance_marks SET status = :status, markedAtEpochMs = :markedAt WHERE draftId = :draftId AND studentId = :studentId",
    )
    suspend fun updateMark(draftId: String, studentId: String, status: String?, markedAt: Long?): Int

    @Query("UPDATE attendance_drafts SET updatedAtEpochMs = :updatedAt WHERE id = :draftId")
    suspend fun touchDraft(draftId: String, updatedAt: Long): Int
}
