-- ========================================================================================================
-- EJECUCION CONTROLADA de 0007-justifications-write.proposal.sql. NO se ejecuta a mano: la corre
-- `pnpm db:apply-privileges 0007-justifications-write` (apps/api/scripts/apply-privileges.ts), que verifica la identidad
-- eta15_app / eta15_dev, que los GRANT de este archivo son IDENTICOS a los de la propuesta y que no hay otras sentencias,
-- fija el SHA-256 y ejecuta este archivo y 0007-justifications-write.verify.sql en UNA SOLA transaccion (sin cambios parciales).
-- Solo hace COMMIT con --execute; sin esa opcion hace ROLLBACK (ensayo). Idempotente. Sin REVOKE ni DDL.
-- ========================================================================================================

DO $$
DECLARE
  v_bad text := '';
  r record;
BEGIN
  IF current_user <> 'eta15_app' THEN v_bad := v_bad || E'\n ejecutar como eta15_app (actual: ' || current_user || ')'; END IF;
  IF current_database() <> 'eta15_dev' THEN v_bad := v_bad || E'\n base distinta de eta15_dev (' || current_database() || ')'; END IF;
  IF current_setting('server_version_num')::int < 180000 THEN v_bad := v_bad || E'\n se requiere PostgreSQL 18'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eta15_api') THEN v_bad := v_bad || E'\n no existe el rol eta15_api'; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname = 'eta15_api'
            AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin IS NOT TRUE) LOOP
    v_bad := v_bad || E'\n atributos inesperados de eta15_api';
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = 'eta15_api'::regrole) THEN
    v_bad := v_bad || E'\n eta15_api no debe ser miembro de ningun rol';
  END IF;
  -- la migracion 0013 debe estar aplicada: tabla con el propietario correcto, restricciones y triggers de proteccion
  FOR r IN SELECT t.name FROM (VALUES ('justification_receipts'), ('users'), ('enrollments'), ('students'), ('role_permissions')) t(name)
             LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> 'eta15_app' LOOP
    v_bad := v_bad || E'\n tabla ' || r.name || ' ausente (falta la migracion 0013) o con otro propietario';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('jr_request_key'), ('jr_weekday'), ('jr_student_enrollment_fkey')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t.name) LOOP
    v_bad := v_bad || E'\n falta la restriccion ' || r.name || ' de la migracion 0013';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('jr_guard_insert'), ('jr_no_update'), ('jr_no_delete'), ('jr_no_truncate')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t.name AND NOT tgisinternal) LOOP
    v_bad := v_bad || E'\n falta el trigger ' || r.name || ' de la migracion 0013';
  END LOOP;
  -- prerrequisitos (propuestas 0002 y 0003 y privilegios de autenticacion): el trigger y el servicio leen estas tablas con los
  -- privilegios de eta15_api
  FOR r IN SELECT t.tbl, t.col FROM (VALUES
             ('users', 'id'), ('users', 'display_name'), ('users', 'status'),
             ('enrollments', 'id'), ('enrollments', 'student_id'), ('enrollments', 'school_year_id'), ('enrollments', 'starts_on'), ('enrollments', 'ends_on'),
             ('student_group_assignments', 'enrollment_id'), ('student_group_assignments', 'group_id'), ('student_group_assignments', 'ends_on'),
             ('groups', 'id'), ('groups', 'grade'), ('groups', 'code'), ('groups', 'shift'), ('groups', 'school_year_id'),
             ('school_years', 'id'), ('school_years', 'name'),
             ('students', 'id'), ('students', 'given_names'), ('students', 'family_name'), ('students', 'school_code'), ('students', 'is_active')) t(tbl, col)
            WHERE NOT has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, t.col, 'SELECT') LOOP
    v_bad := v_bad || E'\n falta SELECT sobre ' || r.tbl || '.' || r.col || ' (requiere las propuestas 0002 y 0003)';
  END LOOP;
  -- nada fuera de lo aprobado antes de empezar
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('justification_receipts', 'role_permissions')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s previo sobre %s', r.priv, r.tabla); END LOOP;
  IF has_table_privilege('eta15_api', 'public.role_permissions', 'INSERT') THEN
    v_bad := v_bad || E'\n escritura previa sobre role_permissions';
  END IF;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'justification_receipts'
       AND (EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))
            OR EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a
                        WHERE at.attrelid = c.oid AND at.attacl IS NOT NULL
                          AND (a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))))
  LOOP v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION previo en %s', r.tabla); END LOOP;
  -- privilegios de columna previos solo dentro de lo aprobado (permite repetir la ejecucion)
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS col, p.priv
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'justification_receipts'
       AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv)
       AND NOT ((p.priv, a.attname) IN (
         ('SELECT', 'id'), ('SELECT', 'folio_number'), ('SELECT', 'folio'), ('SELECT', 'student_id'), ('SELECT', 'school_year_id'),
         ('SELECT', 'school_date'), ('SELECT', 'status'), ('SELECT', 'received_by'), ('SELECT', 'received_at'), ('SELECT', 'request_id'),
         ('SELECT', 'payload_hash'),
         ('INSERT', 'student_id'), ('INSERT', 'school_year_id'), ('INSERT', 'school_date'), ('INSERT', 'received_by'),
         ('INSERT', 'request_id'), ('INSERT', 'payload_hash')))
  LOOP v_bad := v_bad || format(E'\n %s previo fuera de lo aprobado: %s.%s', r.priv, r.tabla, r.col); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Preflight de privilegios fallido:%', v_bad; END IF;
  RAISE NOTICE 'Preflight OK';
END
$$;

GRANT SELECT (id, folio_number, folio, student_id, school_year_id, school_date, status, received_by, received_at, request_id, payload_hash) ON justification_receipts TO eta15_api;
GRANT INSERT (student_id, school_year_id, school_date, received_by, request_id, payload_hash) ON justification_receipts TO eta15_api;
