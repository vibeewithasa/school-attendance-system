-- ========================================================================================================
-- EJECUCION CONTROLADA de la propuesta 0002-school-catalog-write.proposal.sql (privilegios de escritura del catalogo).
-- NO se ejecuta a mano: la corre `pnpm db:apply-privileges 0002-school-catalog-write` (apps/api/scripts/apply-privileges.ts),
-- que (1) verifica la identidad eta15_app / eta15_dev, (2) comprueba que los cuatro GRANT de este archivo son IDENTICOS a los de
-- la propuesta aprobada y que no hay otras sentencias, (3) fija el SHA-256 de los archivos, (4) ejecuta este archivo y luego
-- 0002-school-catalog-write.verify.sql dentro de UNA SOLA transaccion (si algo falla, no queda ningun cambio parcial) y
-- (5) solo hace COMMIT con --execute; sin esa opcion hace ROLLBACK (ensayo).
-- Contenido: un preflight (aborta con excepcion si un supuesto falla) y EXACTAMENTE los cuatro GRANT aprobados. Idempotente:
-- si ya estan aplicados, el preflight lo admite y los GRANT no cambian nada. Sin REVOKE, sin otros GRANT, sin DDL.
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
  -- el rol de la API sigue siendo de minimo privilegio
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname = 'eta15_api'
            AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin IS NOT TRUE) LOOP
    v_bad := v_bad || E'\n atributos inesperados de eta15_api';
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = 'eta15_api'::regrole) THEN
    v_bad := v_bad || E'\n eta15_api no debe ser miembro de ningun rol';
  END IF;
  -- tablas esperadas, propiedad del propietario de migraciones
  FOR r IN SELECT t.name, c.relowner FROM (VALUES ('school_years'), ('groups'), ('role_permissions')) t(name)
             LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> 'eta15_app' LOOP
    v_bad := v_bad || E'\n tabla ' || r.name || ' ausente o con otro propietario';
  END LOOP;
  -- 0006 aplicada (permiso escolar del catalogo) antes de habilitar la escritura
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'catalog:manage_school' AND domain = 'school') THEN
    v_bad := v_bad || E'\n falta la migracion 0006 (catalog:manage_school)';
  END IF;
  -- nada fuera de lo aprobado antes de empezar: ni DELETE/TRUNCATE/TRIGGER/REFERENCES, ni escritura en otras tablas de autorizacion,
  -- ni GRANT OPTION, ni privilegios de PUBLIC sobre estas tablas
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('school_years', 'groups', 'role_permissions')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s previo sobre %s', r.priv, r.tabla); END LOOP;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'role_permissions'
       AND (has_table_privilege('eta15_api', c.oid, 'INSERT') OR has_table_privilege('eta15_api', c.oid, 'UPDATE'))
  LOOP v_bad := v_bad || E'\n escritura previa sobre role_permissions'; END LOOP;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('school_years', 'groups', 'role_permissions')
       AND (EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))
            OR EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a
                        WHERE at.attrelid = c.oid AND at.attacl IS NOT NULL
                          AND (a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))))
  LOOP v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION previo en %s', r.tabla); END LOOP;
  -- INSERT/UPDATE previos solo dentro de las columnas aprobadas (permite repetir la ejecucion)
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS col, p.priv
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('school_years', 'groups')
       AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv)
       AND NOT ((c.relname, p.priv, a.attname) IN (
         ('school_years', 'INSERT', 'name'), ('school_years', 'INSERT', 'starts_on'), ('school_years', 'INSERT', 'ends_on'),
         ('school_years', 'UPDATE', 'name'), ('school_years', 'UPDATE', 'starts_on'), ('school_years', 'UPDATE', 'ends_on'), ('school_years', 'UPDATE', 'is_active'),
         ('groups', 'INSERT', 'school_year_id'), ('groups', 'INSERT', 'grade'), ('groups', 'INSERT', 'code'), ('groups', 'INSERT', 'shift'), ('groups', 'INSERT', 'expected_entry_time'),
         ('groups', 'UPDATE', 'code'), ('groups', 'UPDATE', 'shift'), ('groups', 'UPDATE', 'expected_entry_time'), ('groups', 'UPDATE', 'is_active')))
  LOOP v_bad := v_bad || format(E'\n %s previo fuera de lo aprobado: %s.%s', r.priv, r.tabla, r.col); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Preflight de privilegios fallido:%', v_bad; END IF;
  RAISE NOTICE 'Preflight OK';
END
$$;

GRANT INSERT (name, starts_on, ends_on) ON school_years TO eta15_api;
GRANT UPDATE (name, starts_on, ends_on, is_active) ON school_years TO eta15_api;
GRANT INSERT (school_year_id, grade, code, shift, expected_entry_time) ON groups TO eta15_api;
GRANT UPDATE (code, shift, expected_entry_time, is_active) ON groups TO eta15_api;
