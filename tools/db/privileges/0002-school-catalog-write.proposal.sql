\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA en eta15_dev): escritura del catalogo escolar para eta15_api (ciclos y grupos).
-- La linea 1 (\quit) impide ejecutarla completa con psql -f. Requiere autorizacion explicita antes de aplicarse.
-- Las pruebas del clúster desechable (test/helpers/api-cluster.ts, opcion catalogWrite) aplican EXACTAMENTE las sentencias
-- GRANT de este archivo y luego el script de verificacion 0002-school-catalog-write.verify.sql.
--
-- POR QUE: hoy eta15_api solo tiene SELECT sobre school_years y groups (ver roles-postgresql.md). Los endpoints
-- /catalog/* leen sin cambios, pero crear o modificar ciclos y grupos exige estos privilegios. Mientras no se apliquen, la
-- API responde 503 CATALOG_WRITE_UNAVAILABLE a las mutaciones del catalogo (nunca amplia privilegios por su cuenta).
--
-- ALCANCE (minimo), INSERT y UPDATE ambos POR COLUMNA, exactamente las que usan los servicios del catalogo:
--   * school_years  INSERT (name, starts_on, ends_on)                       <- createSchoolYear
--                   UPDATE (name, starts_on, ends_on, is_active)            <- updateSchoolYear / activar / desactivar
--   * groups        INSERT (school_year_id, grade, code, shift, expected_entry_time)   <- createGroup
--                   UPDATE (code, shift, expected_entry_time, is_active)    <- updateGroup
--   Quedan FUERA a proposito: id, created_at, updated_at (los fijan el DEFAULT y el trigger set_updated_at; la API no puede
--   escribirlos), is_active en el alta (nace con su DEFAULT) y, en groups, school_year_id y grade en UPDATE (un grupo
--   pertenece a su ciclo y grado para siempre: la base se lo impide al rol de la API).
--   NUNCA: DELETE, TRUNCATE, REFERENCES, TRIGGER, ni escritura sobre role_permissions/permissions/roles, ni CREATE, ni
--   membresia en eta15_app / SET ROLE. Esto NO cambia propiedad ni crea objetos.
--
-- IDEMPOTENTE: GRANT es idempotente; volver a ejecutarlo no cambia el resultado. Auditable: despues de aplicar, ejecutar
-- 0002-school-catalog-write.verify.sql (solo lectura; falla con excepcion si el estado efectivo difiere del esperado) y
-- conservar su salida. Los privilegios de tabla y de columna se evaluan conjuntamente (has_column_privilege).
-- Una base de datos; no toca beauty_pos ni postgres. Ejecutar como eta15_app (propietario) conectado a eta15_dev.
-- ========================================================================================================

GRANT INSERT (name, starts_on, ends_on) ON school_years TO eta15_api;
GRANT UPDATE (name, starts_on, ends_on, is_active) ON school_years TO eta15_api;
GRANT INSERT (school_year_id, grade, code, shift, expected_entry_time) ON groups TO eta15_api;
GRANT UPDATE (code, shift, expected_entry_time, is_active) ON groups TO eta15_api;

-- Reversion (solo si se decide retirar la escritura del catalogo):
--   REVOKE INSERT (name, starts_on, ends_on) ON school_years FROM eta15_api;
--   REVOKE UPDATE (name, starts_on, ends_on, is_active) ON school_years FROM eta15_api;
--   REVOKE INSERT (school_year_id, grade, code, shift, expected_entry_time) ON groups FROM eta15_api;
--   REVOKE UPDATE (code, shift, expected_entry_time, is_active) ON groups FROM eta15_api;
