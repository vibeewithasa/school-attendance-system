-- ========================================================================================================
-- EJECUCION CONTROLADA de 0004-prefect-assignments-write.proposal.sql. NO se ejecuta a mano: la corre
-- `pnpm db:apply-privileges 0004-prefect-assignments-write` (apps/api/scripts/apply-privileges.ts), que verifica la identidad
-- eta15_app / eta15_dev, que los GRANT de este archivo son IDENTICOS a los de la propuesta y que no hay otras sentencias,
-- fija el SHA-256 y ejecuta este archivo y 0004-prefect-assignments-write.verify.sql en UNA SOLA transaccion (sin cambios parciales).
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
  -- la migracion 0009 debe estar aplicada: tabla con el propietario correcto, restriccion y triggers de proteccion
  FOR r IN SELECT t.name FROM (VALUES ('prefect_group_assignments'), ('users'), ('user_roles'), ('roles'), ('groups'), ('school_years'), ('role_permissions')) t(name)
             LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> 'eta15_app' LOOP
    v_bad := v_bad || E'\n tabla ' || r.name || ' ausente (falta la migracion 0009) o con otro propietario';
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pga_no_overlap') THEN
    v_bad := v_bad || E'\n falta la restriccion pga_no_overlap de la migracion 0009';
  END IF;
  FOR r IN SELECT t.name FROM (VALUES ('pga_guard_insert'), ('pga_guard_update'), ('pga_no_delete'), ('school_years_guard_prefect_dates')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t.name AND NOT tgisinternal) LOOP
    v_bad := v_bad || E'\n falta el trigger ' || r.name || ' de la migracion 0009';
  END LOOP;
  -- prerrequisitos (propuestas 0002 y 0003 y privilegios de autenticacion): los triggers de la 0009 y el servicio leen estas tablas
  -- con los privilegios de eta15_api y bloquean filas con FOR SHARE (exige algun UPDATE de columna en la tabla bloqueada)
  FOR r IN SELECT t.tbl, t.col FROM (VALUES
             ('users', 'id'), ('users', 'status'), ('users', 'account_domain'), ('users', 'display_name'), ('users', 'email'), ('users', 'locked_until'),
             ('user_roles', 'user_id'), ('user_roles', 'role_id'), ('user_roles', 'revoked_at'), ('user_roles', 'granted_at'),
             ('roles', 'id'), ('roles', 'key'),
             ('groups', 'id'), ('groups', 'is_active'), ('groups', 'grade'), ('groups', 'code'), ('groups', 'shift'), ('groups', 'school_year_id'),
             ('school_years', 'id'), ('school_years', 'name'), ('school_years', 'starts_on'), ('school_years', 'ends_on')) t(tbl, col)
            WHERE NOT has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, t.col, 'SELECT') LOOP
    v_bad := v_bad || E'\n falta SELECT sobre ' || r.tbl || '.' || r.col;
  END LOOP;
  -- dependencia con 0003: cambiar las fechas de un ciclo dispara tambien el trigger de matriculas de la 0007, que lee y bloquea
  -- enrollments y student_group_assignments con los privilegios de eta15_api
  FOR r IN SELECT t.tbl, t.col FROM (VALUES
             ('enrollments', 'school_year_id'), ('enrollments', 'starts_on'), ('enrollments', 'ends_on'),
             ('student_group_assignments', 'school_year_id'), ('student_group_assignments', 'starts_on'), ('student_group_assignments', 'ends_on')) t(tbl, col)
            WHERE NOT has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, t.col, 'SELECT') LOOP
    v_bad := v_bad || E'
 falta SELECT sobre ' || r.tbl || '.' || r.col || ' (requiere la propuesta 0003)';
  END LOOP;
  FOR r IN SELECT t.tbl FROM (VALUES ('users'), ('user_roles'), ('groups'), ('school_years'), ('enrollments')) t(tbl)
            WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ('public.' || t.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                                AND has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, a.attnum, 'UPDATE')) LOOP
    v_bad := v_bad || E'\n falta UPDATE de columna sobre ' || r.tbl || ' (necesario para FOR SHARE)';
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'students' AND relnamespace = 'public'::regnamespace) THEN
    v_bad := v_bad || E'\n falta la migracion 0007 (alumnos)';
  END IF;
  -- nada fuera de lo aprobado antes de empezar
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('prefect_group_assignments', 'role_permissions')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s previo sobre %s', r.priv, r.tabla); END LOOP;
  IF has_table_privilege('eta15_api', 'public.role_permissions', 'INSERT') OR has_table_privilege('eta15_api', 'public.role_permissions', 'UPDATE') THEN
    v_bad := v_bad || E'\n escritura previa sobre role_permissions';
  END IF;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'prefect_group_assignments'
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
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'prefect_group_assignments'
       AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv)
       AND NOT ((p.priv, a.attname) IN (
         ('SELECT', 'id'), ('SELECT', 'user_id'), ('SELECT', 'school_year_id'), ('SELECT', 'group_id'), ('SELECT', 'starts_on'), ('SELECT', 'ends_on'),
         ('SELECT', 'created_by'), ('SELECT', 'revoked_at'), ('SELECT', 'revoked_by'), ('SELECT', 'revocation_reason'), ('SELECT', 'created_at'),
         ('INSERT', 'user_id'), ('INSERT', 'school_year_id'), ('INSERT', 'group_id'), ('INSERT', 'starts_on'), ('INSERT', 'ends_on'), ('INSERT', 'created_by'),
         ('UPDATE', 'ends_on'), ('UPDATE', 'revoked_by'), ('UPDATE', 'revocation_reason')))
  LOOP v_bad := v_bad || format(E'\n %s previo fuera de lo aprobado: %s.%s', r.priv, r.tabla, r.col); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Preflight de privilegios fallido:%', v_bad; END IF;
  RAISE NOTICE 'Preflight OK';
END
$$;

GRANT SELECT (id, user_id, school_year_id, group_id, starts_on, ends_on, created_by, revoked_at, revoked_by, revocation_reason, created_at) ON prefect_group_assignments TO eta15_api;
GRANT INSERT (user_id, school_year_id, group_id, starts_on, ends_on, created_by) ON prefect_group_assignments TO eta15_api;
GRANT UPDATE (ends_on, revoked_by, revocation_reason) ON prefect_group_assignments TO eta15_api;
