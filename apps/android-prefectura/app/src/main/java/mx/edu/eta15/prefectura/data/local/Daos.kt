package mx.edu.eta15.prefectura.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
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

    @Query(
        """
        SELECT g.id AS id, g.name AS name, g.grade AS grade,
               (SELECT COUNT(*) FROM students s WHERE s.groupId = g.id) AS studentCount,
               (SELECT COUNT(*) FROM attendance_marks m
                  JOIN attendance_drafts d ON d.id = m.draftId
                 WHERE d.groupId = g.id AND d.profileId = :profileId AND d.schoolDate = :date
                   AND m.status IS NOT NULL) AS markedToday,
               (SELECT COUNT(*) FROM attendance_drafts d
                 WHERE d.groupId = g.id AND d.profileId = :profileId AND d.schoolDate = :date) AS hasDraftToday
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
         WHERE s.groupId = :groupId AND g.profileId = :profileId
         ORDER BY s.familyName, s.givenNames, s.id
        """,
    )
    fun observeStudents(profileId: String, groupId: String): Flow<List<StudentEntity>>

    @Query(
        """
        SELECT s.* FROM students s
          JOIN school_groups g ON g.id = s.groupId
         WHERE s.groupId = :groupId AND g.profileId = :profileId
        """,
    )
    suspend fun studentsOf(profileId: String, groupId: String): List<StudentEntity>

    @Query("SELECT COUNT(*) FROM school_groups WHERE id = :groupId AND profileId = :profileId")
    suspend fun groupExists(profileId: String, groupId: String): Int
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
