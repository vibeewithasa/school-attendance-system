-- Verificacion de SOLO LECTURA de los privilegios efectivos de eta15_api sobre alumnos, matriculas e historial de grupo
-- (propuesta 0003-students-write.proposal.sql). Ejecutar como eta15_app: psql -v ON_ERROR_STOP=1 -f <este archivo>
-- Compara los privilegios EFECTIVOS (tabla + columna + PUBLIC, via has_table_privilege / has_column_privilege / aclexplode) con
-- el estado esperado y falla con una excepcion si difieren. Sin DDL ni datos. Las pruebas del clúster desechable lo ejecutan.

DO $$
DECLARE
  r record;
  v_bad text := '';
  v_expected jsonb := jsonb_build_object(
    'students', jsonb_build_object(
      'select', jsonb_build_array('id', 'given_names', 'family_name', 'school_code', 'is_active', 'created_at', 'updated_at'),
      'insert', jsonb_build_array('given_names', 'family_name', 'school_code'),
      'update', jsonb_build_array('given_names', 'family_name', 'school_code', 'is_active')),
    'enrollments', jsonb_build_object(
      'select', jsonb_build_array('id', 'student_id', 'school_year_id', 'starts_on', 'ends_on', 'created_at', 'updated_at'),
      'insert', jsonb_build_array('student_id', 'school_year_id', 'starts_on'),
      'update', jsonb_build_array('ends_on')),
    'student_group_assignments', jsonb_build_object(
      'select', jsonb_build_array('id', 'enrollment_id', 'school_year_id', 'group_id', 'starts_on', 'ends_on', 'created_at'),
      'insert', jsonb_build_array('enrollment_id', 'school_year_id', 'group_id', 'starts_on'),
      'update', jsonb_build_array('ends_on')));
BEGIN
  -- Columna a columna: SELECT/INSERT/UPDATE efectivos (tabla O columna) EXACTAMENTE los esperados.
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS col,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'SELECT') AS can_select,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'INSERT') AS can_insert,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'UPDATE') AS can_update
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('students', 'enrollments', 'student_group_assignments')
  LOOP
    IF r.can_select <> (v_expected -> r.tabla -> 'select' ? r.col) THEN v_bad := v_bad || format(E'\n SELECT %s.%s efectivo=%s', r.tabla, r.col, r.can_select); END IF;
    IF r.can_insert <> (v_expected -> r.tabla -> 'insert' ? r.col) THEN v_bad := v_bad || format(E'\n INSERT %s.%s efectivo=%s', r.tabla, r.col, r.can_insert); END IF;
    IF r.can_update <> (v_expected -> r.tabla -> 'update' ? r.col) THEN v_bad := v_bad || format(E'\n UPDATE %s.%s efectivo=%s', r.tabla, r.col, r.can_update); END IF;
  END LOOP;
  -- Nunca: DELETE, TRUNCATE, REFERENCES, TRIGGER sobre estas tablas; nada de escritura sobre las tablas de autorizacion.
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('students', 'enrollments', 'student_group_assignments')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s sobre %s no debe existir', r.priv, r.tabla); END LOOP;
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('role_permissions', 'permissions', 'roles')
       AND (has_table_privilege('eta15_api', c.oid, p.priv)
            OR (p.priv IN ('INSERT', 'UPDATE') AND EXISTS (
                  SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                     AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv))))
  LOOP v_bad := v_bad || format(E'\n %s sobre %s no debe existir', r.priv, r.tabla); END LOOP;
  IF has_schema_privilege('eta15_api', 'public', 'CREATE') THEN v_bad := v_bad || E'\n CREATE en public'; END IF;
  IF has_schema_privilege('eta15_api', 'extensions', 'USAGE') OR has_schema_privilege('eta15_api', 'extensions', 'CREATE') THEN
    v_bad := v_bad || E'\n acceso al esquema extensions';
  END IF;
  IF pg_has_role('eta15_api', 'eta15_app', 'MEMBER') OR pg_has_role('eta15_api', 'eta15_app', 'USAGE') THEN
    v_bad := v_bad || E'\n miembro de eta15_app (SET ROLE posible)';
  END IF;
  -- GRANT OPTION y privilegios de PUBLIC (tabla o columna): ninguno.
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('students', 'enrollments', 'student_group_assignments', 'role_permissions', 'permissions', 'roles')
       AND (EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))
            OR EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a
                        WHERE at.attrelid = c.oid AND at.attacl IS NOT NULL
                          AND (a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))))
  LOOP v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION en %s', r.tabla); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Privilegios efectivos de eta15_api inesperados:%', v_bad; END IF;
  RAISE NOTICE 'OK: eta15_api tiene exactamente el acceso por columna esperado a alumnos, matriculas e historial de grupo';
END
$$;
