\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA en eta15_dev): privilegios minimos de eta15_api sobre alumnos, matriculas e historial de grupo
-- (tablas de la migracion 0007). La linea 1 (\quit) impide ejecutarla completa con psql -f. Requiere la migracion 0007
-- aplicada y autorizacion explicita. Se ejecuta con `pnpm db:apply-privileges 0003-students-write --sha256=<hash del .apply.sql>`
-- (ensayo con ROLLBACK; con --execute hace COMMIT), nunca pegando SQL a mano.
--
-- PRINCIPIOS: todo POR COLUMNA, tambien SELECT. Una columna futura (p. ej. un dato adicional que se apruebe mas adelante) NO es
-- legible ni escribible por la API hasta que se conceda expresamente. Sin DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE ni
-- GRANT OPTION; sin escritura sobre role_permissions/permissions/roles; la API no es propietaria de nada.
--
--   students                   SELECT (todas las columnas actuales)  INSERT (given_names, family_name, school_code)
--                              UPDATE (given_names, family_name, school_code, is_active)
--                              Fuera: id, created_at, updated_at (DEFAULT y trigger; la API no los escribe).
--   enrollments                SELECT (todas)  INSERT (student_id, school_year_id, starts_on)  UPDATE (ends_on)
--                              La unica transicion es la baja; el resto es inmutable tambien por trigger.
--   student_group_assignments  SELECT (todas salvo updated_at)  INSERT (enrollment_id, school_year_id, group_id, starts_on)
--                              UPDATE (ends_on)  (solo cierre)
-- Los triggers de la 0007 son SECURITY INVOKER: usan estos mismos privilegios (SELECT ... FOR SHARE requiere ademas algun
-- UPDATE de columna sobre la tabla bloqueada, que estos GRANT incluyen). Las FK las comprueba PostgreSQL como propietario.
-- IDEMPOTENTE (GRANT lo es). Reversible con los REVOKE de abajo. Verificable con 0003-students-write.verify.sql (solo lectura).
-- ========================================================================================================

GRANT SELECT (id, given_names, family_name, school_code, is_active, created_at, updated_at) ON students TO eta15_api;
GRANT INSERT (given_names, family_name, school_code) ON students TO eta15_api;
GRANT UPDATE (given_names, family_name, school_code, is_active) ON students TO eta15_api;
GRANT SELECT (id, student_id, school_year_id, starts_on, ends_on, created_at, updated_at) ON enrollments TO eta15_api;
GRANT INSERT (student_id, school_year_id, starts_on) ON enrollments TO eta15_api;
GRANT UPDATE (ends_on) ON enrollments TO eta15_api;
GRANT SELECT (id, enrollment_id, school_year_id, group_id, starts_on, ends_on, created_at) ON student_group_assignments TO eta15_api;
GRANT INSERT (enrollment_id, school_year_id, group_id, starts_on) ON student_group_assignments TO eta15_api;
GRANT UPDATE (ends_on) ON student_group_assignments TO eta15_api;

-- Reversion (solo si se decide retirar el acceso de la API a estas tablas):
--   REVOKE ALL ON students, enrollments, student_group_assignments FROM eta15_api;
