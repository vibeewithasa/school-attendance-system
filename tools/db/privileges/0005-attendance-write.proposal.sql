\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA en eta15_dev): privilegios minimos de eta15_api sobre la asistencia diaria (tablas `attendance_days`,
-- `attendance_records` y `attendance_events` de la migracion 0010). La linea 1 (\quit) impide ejecutarla completa con psql -f.
-- Requiere 0010 y las propuestas 0002, 0003 y 0004 ya aplicadas, y autorizacion explicita. Se ejecuta con
-- `pnpm db:apply-privileges 0005-attendance-write --sha256=<hash del .apply.sql>` (ensayo con ROLLBACK; con --execute hace COMMIT),
-- nunca pegando SQL a mano.
--
-- PRINCIPIOS: todo POR COLUMNA, tambien SELECT. Una columna futura no es legible ni escribible por la API hasta concederla.
-- Sin DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE ni GRANT OPTION; sin escritura sobre role_permissions/permissions/roles.
--
--   attendance_days     SELECT (todas salvo updated_at)
--                       INSERT (school_year_id, group_id, attendance_date, created_by)   -- nace en borrador, revision 1
--                       UPDATE (status, revision, finalized_by)                          -- guardar (revision+1) y finalizar
--     Fuera de INSERT: id, status, revision, finalized_*, created_at, updated_at (DEFAULT/trigger).
--     Fuera de UPDATE: la identidad, la fecha y `finalized_at` (lo fija el trigger con now(); el cliente no elige la hora).
--   attendance_records  SELECT (todas salvo updated_at)
--                       INSERT (attendance_day_id, school_year_id, enrollment_id, group_assignment_id)  -- nace pendiente
--                       UPDATE (status, marked_by)                                                     -- `marked_at` lo fija el trigger
--   attendance_events   SELECT (todas)
--                       INSERT (attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status,
--                               revision_after)  -- `occurred_at` es DEFAULT now(): la API no elige la hora
--     SIN UPDATE y sin DELETE: el historial solo se agrega (tambien lo impiden los triggers de la 0010, incluso al propietario).
-- Los triggers de la 0010 son SECURITY INVOKER: usan estos privilegios y los ya aprobados sobre groups, school_years, enrollments,
-- students y student_group_assignments (lectura; FOR SHARE ademas necesita algun UPDATE de columna sobre la tabla bloqueada:
-- groups/school_years/enrollments/student_group_assignments/users/prefect_group_assignments ya lo tienen, y esta propuesta lo da en
-- attendance_days). Las FK las comprueba PostgreSQL como propietario.
-- IDEMPOTENTE (GRANT lo es). Reversible con el REVOKE de abajo. Verificable con 0005-attendance-write.verify.sql.
-- ========================================================================================================

GRANT SELECT (id, school_year_id, group_id, attendance_date, status, revision, created_by, finalized_by, finalized_at, created_at) ON attendance_days TO eta15_api;
GRANT INSERT (school_year_id, group_id, attendance_date, created_by) ON attendance_days TO eta15_api;
GRANT UPDATE (status, revision, finalized_by) ON attendance_days TO eta15_api;
GRANT SELECT (id, attendance_day_id, school_year_id, enrollment_id, group_assignment_id, status, marked_by, marked_at, created_at) ON attendance_records TO eta15_api;
GRANT INSERT (attendance_day_id, school_year_id, enrollment_id, group_assignment_id) ON attendance_records TO eta15_api;
GRANT UPDATE (status, marked_by) ON attendance_records TO eta15_api;
GRANT SELECT (id, attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after, occurred_at) ON attendance_events TO eta15_api;
GRANT INSERT (attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after) ON attendance_events TO eta15_api;

-- Reversion (solo si se decide retirar el acceso de la API a estas tablas):
--   REVOKE ALL ON attendance_days, attendance_records, attendance_events FROM eta15_api;
