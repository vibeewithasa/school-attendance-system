\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA en eta15_dev): privilegios minimos de eta15_api sobre el registro de RECEPCION de justificantes (tabla
-- `justification_receipts` de la migracion 0013). La linea 1 (\quit) impide ejecutarla completa con psql -f.
-- Requiere la migracion 0013 y las propuestas 0002 y 0003 ya aplicadas, y autorizacion explicita. Se ejecuta con
-- `pnpm db:apply-privileges 0007-justifications-write --sha256=<hash del .apply.sql>` (ensayo con ROLLBACK; con --execute hace
-- COMMIT), nunca pegando SQL a mano.
--
-- PRINCIPIOS: todo POR COLUMNA, tambien SELECT. Sin UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE ni GRANT OPTION; sin
-- escritura sobre role_permissions/permissions/roles. Una columna futura no es legible ni escribible por la API hasta concederla.
--
--   justification_receipts  SELECT (todas las columnas)
--                           INSERT (student_id, school_year_id, school_date, received_by, request_id, payload_hash)
--     Fuera de INSERT: id (DEFAULT uuidv7), folio_number (identidad ALWAYS), folio (lo fija el trigger jr_guard_insert), status (DEFAULT) y
--     received_at (la hora la fija la base: la API no puede falsificarla). Sin UPDATE ni siquiera por columna: el registro es
--     inmutable (tambien lo impiden los triggers de la 0013, incluso al propietario).
-- El trigger jr_guard_insert es SECURITY INVOKER: lee `enrollments` con los privilegios ya aprobados (propuesta 0003). La FK la
-- comprueba PostgreSQL como propietario. La columna de identidad no exige privilegio separado sobre su secuencia.
-- IDEMPOTENTE (GRANT lo es). Reversible con el REVOKE de abajo. Verificable con 0007-justifications-write.verify.sql.
-- ========================================================================================================

GRANT SELECT (id, folio_number, folio, student_id, school_year_id, school_date, status, received_by, received_at, request_id, payload_hash) ON justification_receipts TO eta15_api;
GRANT INSERT (student_id, school_year_id, school_date, received_by, request_id, payload_hash) ON justification_receipts TO eta15_api;

-- Reversion (solo si se decide retirar el acceso de la API a esta tabla):
--   REVOKE ALL ON justification_receipts FROM eta15_api;
