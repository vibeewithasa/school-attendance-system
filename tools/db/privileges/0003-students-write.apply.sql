-- ========================================================================================================
-- EJECUCION CONTROLADA de 0003-students-write.proposal.sql. NO se ejecuta a mano: la corre
-- `pnpm db:apply-privileges 0003-students-write` (apps/api/scripts/apply-privileges.ts), que verifica la identidad
-- eta15_app / eta15_dev, que los GRANT de este archivo son IDENTICOS a los de la propuesta y que no hay otras sentencias,
-- fija el SHA-256 y ejecuta este archivo y 0003-students-write.verify.sql en UNA SOLA transaccion (sin cambios parciales).
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
  -- la migracion 0007 debe estar aplicada: tablas con el propietario correcto, trigger de proteccion y extension
  FOR r IN SELECT t.name FROM (VALUES ('students'), ('enrollments'), ('student_group_assignments'), ('role_permissions')) t(name)
             LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> 'eta15_app' LOOP
    v_bad := v_bad || E'\n tabla ' || r.name || ' ausente (falta la migracion 0007) o con otro propietario';
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sga_no_overlap') THEN
    v_bad := v_bad || E'\n falta la restriccion sga_no_overlap de la migracion 0007';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'students_no_delete' AND NOT tgisinternal) THEN
    v_bad := v_bad || E'\n falta el trigger students_no_delete de la migracion 0007';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'school_years_guard_dates' AND NOT tgisinternal) THEN
    v_bad := v_bad || E'\n falta el trigger school_years_guard_dates de la migracion 0007';
  END IF;
  -- los triggers de 0007 (SECURITY INVOKER) leen y bloquean (FOR SHARE) school_years con los privilegios de eta15_api: requieren
  -- la propuesta 0002 (lectura de ciclos y UPDATE de alguna columna, necesario para el bloqueo de filas)
  FOR r IN SELECT t.col FROM (VALUES ('id'), ('starts_on'), ('ends_on')) t(col)
            WHERE NOT has_column_privilege('eta15_api', 'public.school_years', t.col, 'SELECT') LOOP
    v_bad := v_bad || E'\n falta SELECT sobre school_years.' || r.col || ' (requiere la propuesta 0002)';
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.school_years'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                    AND has_column_privilege('eta15_api', 'public.school_years', a.attnum, 'UPDATE')) THEN
    v_bad := v_bad || E'\n falta UPDATE de columna sobre school_years (requiere la propuesta 0002)';
  END IF;
  -- nada fuera de lo aprobado antes de empezar
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('students', 'enrollments', 'student_group_assignments', 'role_permissions')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s previo sobre %s', r.priv, r.tabla); END LOOP;
  IF has_table_privilege('eta15_api', 'public.role_permissions', 'INSERT') OR has_table_privilege('eta15_api', 'public.role_permissions', 'UPDATE') THEN
    v_bad := v_bad || E'\n escritura previa sobre role_permissions';
  END IF;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('students', 'enrollments', 'student_group_assignments')
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
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('students', 'enrollments', 'student_group_assignments')
       AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv)
       AND NOT ((c.relname, p.priv, a.attname) IN (
         ('students', 'SELECT', 'id'), ('students', 'SELECT', 'given_names'), ('students', 'SELECT', 'family_name'), ('students', 'SELECT', 'school_code'),
         ('students', 'SELECT', 'is_active'), ('students', 'SELECT', 'created_at'), ('students', 'SELECT', 'updated_at'),
         ('students', 'INSERT', 'given_names'), ('students', 'INSERT', 'family_name'), ('students', 'INSERT', 'school_code'),
         ('students', 'UPDATE', 'given_names'), ('students', 'UPDATE', 'family_name'), ('students', 'UPDATE', 'school_code'), ('students', 'UPDATE', 'is_active'),
         ('enrollments', 'SELECT', 'id'), ('enrollments', 'SELECT', 'student_id'), ('enrollments', 'SELECT', 'school_year_id'), ('enrollments', 'SELECT', 'starts_on'),
         ('enrollments', 'SELECT', 'ends_on'), ('enrollments', 'SELECT', 'created_at'), ('enrollments', 'SELECT', 'updated_at'),
         ('enrollments', 'INSERT', 'student_id'), ('enrollments', 'INSERT', 'school_year_id'), ('enrollments', 'INSERT', 'starts_on'), ('enrollments', 'UPDATE', 'ends_on'),
         ('student_group_assignments', 'SELECT', 'id'), ('student_group_assignments', 'SELECT', 'enrollment_id'), ('student_group_assignments', 'SELECT', 'school_year_id'),
         ('student_group_assignments', 'SELECT', 'group_id'), ('student_group_assignments', 'SELECT', 'starts_on'), ('student_group_assignments', 'SELECT', 'ends_on'),
         ('student_group_assignments', 'SELECT', 'created_at'),
         ('student_group_assignments', 'INSERT', 'enrollment_id'), ('student_group_assignments', 'INSERT', 'school_year_id'),
         ('student_group_assignments', 'INSERT', 'group_id'), ('student_group_assignments', 'INSERT', 'starts_on'),
         ('student_group_assignments', 'UPDATE', 'ends_on')))
  LOOP v_bad := v_bad || format(E'\n %s previo fuera de lo aprobado: %s.%s', r.priv, r.tabla, r.col); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Preflight de privilegios fallido:%', v_bad; END IF;
  RAISE NOTICE 'Preflight OK';
END
$$;

GRANT SELECT (id, given_names, family_name, school_code, is_active, created_at, updated_at) ON students TO eta15_api;
GRANT INSERT (given_names, family_name, school_code) ON students TO eta15_api;
GRANT UPDATE (given_names, family_name, school_code, is_active) ON students TO eta15_api;
GRANT SELECT (id, student_id, school_year_id, starts_on, ends_on, created_at, updated_at) ON enrollments TO eta15_api;
GRANT INSERT (student_id, school_year_id, starts_on) ON enrollments TO eta15_api;
GRANT UPDATE (ends_on) ON enrollments TO eta15_api;
GRANT SELECT (id, enrollment_id, school_year_id, group_id, starts_on, ends_on, created_at) ON student_group_assignments TO eta15_api;
GRANT INSERT (enrollment_id, school_year_id, group_id, starts_on) ON student_group_assignments TO eta15_api;
GRANT UPDATE (ends_on) ON student_group_assignments TO eta15_api;
