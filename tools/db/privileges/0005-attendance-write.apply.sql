-- ========================================================================================================
-- EJECUCION CONTROLADA de 0005-attendance-write.proposal.sql. NO se ejecuta a mano: la corre
-- `pnpm db:apply-privileges 0005-attendance-write` (apps/api/scripts/apply-privileges.ts), que verifica la identidad
-- eta15_app / eta15_dev, que los GRANT de este archivo son IDENTICOS a los de la propuesta y que no hay otras sentencias,
-- fija el SHA-256 y ejecuta este archivo y 0005-attendance-write.verify.sql en UNA SOLA transaccion (sin cambios parciales).
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
  -- la migracion 0010 debe estar aplicada: tablas con el propietario correcto, restricciones y triggers de proteccion
  FOR r IN SELECT t.name FROM (VALUES ('attendance_days'), ('attendance_records'), ('attendance_events'), ('prefect_group_assignments'),
                                      ('users'), ('groups'), ('school_years'), ('enrollments'), ('students'), ('student_group_assignments'),
                                      ('role_permissions')) t(name)
             LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> 'eta15_app' LOOP
    v_bad := v_bad || E'\n tabla ' || r.name || ' ausente (falta la migracion 0010) o con otro propietario';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('att_days_group_date_key'), ('att_days_weekday'), ('att_records_day_enrollment_key')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t.name) LOOP
    v_bad := v_bad || E'\n falta la restriccion ' || r.name || ' de la migracion 0010';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('att_days_guard_insert'), ('att_days_guard_update'), ('att_records_guard_insert'), ('att_records_guard_update'),
                                      ('att_days_no_delete'), ('att_records_no_delete'), ('att_events_no_delete'), ('att_events_no_update'),
                                      ('school_years_guard_attendance_dates')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t.name AND NOT tgisinternal) LOOP
    v_bad := v_bad || E'\n falta el trigger ' || r.name || ' de la migracion 0010';
  END LOOP;
  -- prerrequisitos (propuestas 0002, 0003 y 0004 y privilegios de autenticacion): los triggers de la 0010 y el servicio leen estas
  -- tablas con los privilegios de eta15_api y bloquean filas con FOR SHARE (exige algun UPDATE de columna en la tabla bloqueada)
  FOR r IN SELECT t.tbl, t.col FROM (VALUES
             ('users', 'id'), ('users', 'status'), ('users', 'account_domain'), ('users', 'locked_until'),
             ('user_roles', 'user_id'), ('user_roles', 'role_id'), ('user_roles', 'revoked_at'), ('user_roles', 'granted_at'),
             ('roles', 'id'), ('roles', 'key'),
             ('groups', 'id'), ('groups', 'is_active'), ('groups', 'grade'), ('groups', 'code'), ('groups', 'shift'), ('groups', 'school_year_id'),
             ('school_years', 'id'), ('school_years', 'name'), ('school_years', 'starts_on'), ('school_years', 'ends_on'),
             ('enrollments', 'id'), ('enrollments', 'student_id'), ('enrollments', 'school_year_id'), ('enrollments', 'starts_on'), ('enrollments', 'ends_on'),
             ('student_group_assignments', 'id'), ('student_group_assignments', 'enrollment_id'), ('student_group_assignments', 'school_year_id'),
             ('student_group_assignments', 'group_id'), ('student_group_assignments', 'starts_on'), ('student_group_assignments', 'ends_on'),
             ('students', 'id'), ('students', 'given_names'), ('students', 'family_name'), ('students', 'is_active'),
             ('prefect_group_assignments', 'id'), ('prefect_group_assignments', 'user_id'), ('prefect_group_assignments', 'school_year_id'),
             ('prefect_group_assignments', 'group_id'), ('prefect_group_assignments', 'starts_on'), ('prefect_group_assignments', 'ends_on'),
             ('prefect_group_assignments', 'created_at'), ('prefect_group_assignments', 'revoked_at')) t(tbl, col)
            WHERE NOT has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, t.col, 'SELECT') LOOP
    v_bad := v_bad || E'\n falta SELECT sobre ' || r.tbl || '.' || r.col || ' (requiere las propuestas 0002, 0003 y 0004)';
  END LOOP;
  FOR r IN SELECT t.tbl FROM (VALUES ('users'), ('user_roles'), ('groups'), ('school_years'), ('enrollments'), ('student_group_assignments'),
                                     ('prefect_group_assignments')) t(tbl)
            WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ('public.' || t.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                                AND has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, a.attnum, 'UPDATE')) LOOP
    v_bad := v_bad || E'\n falta UPDATE de columna sobre ' || r.tbl || ' (necesario para FOR SHARE)';
  END LOOP;
  -- nada fuera de lo aprobado antes de empezar
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('attendance_days', 'attendance_records', 'attendance_events', 'role_permissions')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s previo sobre %s', r.priv, r.tabla); END LOOP;
  IF has_table_privilege('eta15_api', 'public.role_permissions', 'INSERT') OR has_table_privilege('eta15_api', 'public.role_permissions', 'UPDATE') THEN
    v_bad := v_bad || E'\n escritura previa sobre role_permissions';
  END IF;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('attendance_days', 'attendance_records', 'attendance_events')
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
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('attendance_days', 'attendance_records', 'attendance_events')
       AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv)
       AND NOT ((c.relname, p.priv, a.attname) IN (
         ('attendance_days', 'SELECT', 'id'), ('attendance_days', 'SELECT', 'school_year_id'), ('attendance_days', 'SELECT', 'group_id'),
         ('attendance_days', 'SELECT', 'attendance_date'), ('attendance_days', 'SELECT', 'status'), ('attendance_days', 'SELECT', 'revision'),
         ('attendance_days', 'SELECT', 'created_by'), ('attendance_days', 'SELECT', 'finalized_by'), ('attendance_days', 'SELECT', 'finalized_at'),
         ('attendance_days', 'SELECT', 'created_at'),
         ('attendance_days', 'INSERT', 'school_year_id'), ('attendance_days', 'INSERT', 'group_id'), ('attendance_days', 'INSERT', 'attendance_date'),
         ('attendance_days', 'INSERT', 'created_by'),
         ('attendance_days', 'UPDATE', 'status'), ('attendance_days', 'UPDATE', 'revision'), ('attendance_days', 'UPDATE', 'finalized_by'),
         ('attendance_records', 'SELECT', 'id'), ('attendance_records', 'SELECT', 'attendance_day_id'), ('attendance_records', 'SELECT', 'school_year_id'),
         ('attendance_records', 'SELECT', 'enrollment_id'), ('attendance_records', 'SELECT', 'group_assignment_id'), ('attendance_records', 'SELECT', 'status'),
         ('attendance_records', 'SELECT', 'marked_by'), ('attendance_records', 'SELECT', 'marked_at'), ('attendance_records', 'SELECT', 'created_at'),
         ('attendance_records', 'INSERT', 'attendance_day_id'), ('attendance_records', 'INSERT', 'school_year_id'),
         ('attendance_records', 'INSERT', 'enrollment_id'), ('attendance_records', 'INSERT', 'group_assignment_id'),
         ('attendance_records', 'UPDATE', 'status'), ('attendance_records', 'UPDATE', 'marked_by'),
         ('attendance_events', 'SELECT', 'id'), ('attendance_events', 'SELECT', 'attendance_day_id'), ('attendance_events', 'SELECT', 'record_id'),
         ('attendance_events', 'SELECT', 'event_type'), ('attendance_events', 'SELECT', 'actor_id'), ('attendance_events', 'SELECT', 'request_id'),
         ('attendance_events', 'SELECT', 'payload_hash'), ('attendance_events', 'SELECT', 'old_status'), ('attendance_events', 'SELECT', 'new_status'),
         ('attendance_events', 'SELECT', 'revision_after'), ('attendance_events', 'SELECT', 'occurred_at'),
         ('attendance_events', 'INSERT', 'attendance_day_id'), ('attendance_events', 'INSERT', 'record_id'), ('attendance_events', 'INSERT', 'event_type'),
         ('attendance_events', 'INSERT', 'actor_id'), ('attendance_events', 'INSERT', 'request_id'), ('attendance_events', 'INSERT', 'payload_hash'),
         ('attendance_events', 'INSERT', 'old_status'), ('attendance_events', 'INSERT', 'new_status'), ('attendance_events', 'INSERT', 'revision_after')))
  LOOP v_bad := v_bad || format(E'\n %s previo fuera de lo aprobado: %s.%s', r.priv, r.tabla, r.col); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Preflight de privilegios fallido:%', v_bad; END IF;
  RAISE NOTICE 'Preflight OK';
END
$$;

GRANT SELECT (id, school_year_id, group_id, attendance_date, status, revision, created_by, finalized_by, finalized_at, created_at) ON attendance_days TO eta15_api;
GRANT INSERT (school_year_id, group_id, attendance_date, created_by) ON attendance_days TO eta15_api;
GRANT UPDATE (status, revision, finalized_by) ON attendance_days TO eta15_api;
GRANT SELECT (id, attendance_day_id, school_year_id, enrollment_id, group_assignment_id, status, marked_by, marked_at, created_at) ON attendance_records TO eta15_api;
GRANT INSERT (attendance_day_id, school_year_id, enrollment_id, group_assignment_id) ON attendance_records TO eta15_api;
GRANT UPDATE (status, marked_by) ON attendance_records TO eta15_api;
GRANT SELECT (id, attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after, occurred_at) ON attendance_events TO eta15_api;
GRANT INSERT (attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after) ON attendance_events TO eta15_api;
