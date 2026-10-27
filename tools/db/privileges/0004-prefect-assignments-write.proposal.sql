\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA en eta15_dev): privilegios minimos de eta15_api sobre las asignaciones de grupos a prefectura (tabla
-- `prefect_group_assignments` de la migracion 0009). La linea 1 (\quit) impide ejecutarla completa con psql -f. Requiere 0009 y
-- las propuestas 0002 y 0003 ya aplicadas, y autorizacion explicita. Se ejecuta con
-- `pnpm db:apply-privileges 0004-prefect-assignments-write --sha256=<hash del .apply.sql>` (ensayo con ROLLBACK; con --execute
-- hace COMMIT), nunca pegando SQL a mano.
--
-- PRINCIPIOS: todo POR COLUMNA, tambien SELECT. Una columna futura no es legible ni escribible por la API hasta concederla.
-- Sin DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE ni GRANT OPTION; sin escritura sobre role_permissions/permissions/roles.
--
--   prefect_group_assignments  SELECT (todas salvo updated_at)
--                              INSERT (user_id, school_year_id, group_id, starts_on, ends_on, created_by)
--                              UPDATE (ends_on, revoked_by, revocation_reason)
--     Fuera de INSERT: id, created_at, updated_at (DEFAULT/trigger) y toda la revocacion (nace sin ella).
--     Fuera de UPDATE: la identidad, el inicio y `revoked_at` (lo fija el trigger con now(); el cliente no elige la hora).
-- Los triggers de la 0009 son SECURITY INVOKER: usan estos privilegios y los ya aprobados sobre users, user_roles, roles, groups y
-- school_years (lectura; FOR SHARE ademas necesita algun UPDATE de columna sobre la tabla bloqueada: users/user_roles/groups/
-- school_years ya lo tienen, y esta propuesta lo da en prefect_group_assignments). Las FK las comprueba PostgreSQL como propietario.
-- IDEMPOTENTE (GRANT lo es). Reversible con el REVOKE de abajo. Verificable con 0004-prefect-assignments-write.verify.sql.
-- ========================================================================================================

GRANT SELECT (id, user_id, school_year_id, group_id, starts_on, ends_on, created_by, revoked_at, revoked_by, revocation_reason, created_at) ON prefect_group_assignments TO eta15_api;
GRANT INSERT (user_id, school_year_id, group_id, starts_on, ends_on, created_by) ON prefect_group_assignments TO eta15_api;
GRANT UPDATE (ends_on, revoked_by, revocation_reason) ON prefect_group_assignments TO eta15_api;

-- Reversion (solo si se decide retirar el acceso de la API a esta tabla):
--   REVOKE ALL ON prefect_group_assignments FROM eta15_api;
