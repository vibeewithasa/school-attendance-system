-- Verificacion de SOLO LECTURA de los privilegios efectivos de eta15_api sobre el catalogo escolar
-- (propuesta 0002-school-catalog-write.proposal.sql). Ejecutar como eta15_app: psql -v ON_ERROR_STOP=1 -f <este archivo>
-- Compara los privilegios EFECTIVOS (tabla + columna, via has_table_privilege / has_column_privilege) con el estado esperado y
-- falla con una excepcion si difieren. Sin DDL, sin datos: solo SELECT y un bloque DO que no modifica nada.
-- Las pruebas del clúster desechable ejecutan exactamente este archivo.

SELECT c.relname AS tabla, p.priv AS privilegio_de_tabla, has_table_privilege('eta15_api', c.oid, p.priv) AS efectivo
  FROM pg_class c
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
 WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('school_years', 'groups', 'role_permissions', 'permissions', 'roles')
 ORDER BY 1, 2;

DO $$
DECLARE
  r record;
  v_bad text := '';
  v_expected jsonb := jsonb_build_object(
    'school_years', jsonb_build_object(
      'insert', jsonb_build_array('name', 'starts_on', 'ends_on'),
      'update', jsonb_build_array('name', 'starts_on', 'ends_on', 'is_active')),
    'groups', jsonb_build_object(
      'insert', jsonb_build_array('school_year_id', 'grade', 'code', 'shift', 'expected_entry_time'),
      'update', jsonb_build_array('code', 'shift', 'expected_entry_time', 'is_active')));
BEGIN
  -- Columna a columna: INSERT/UPDATE efectivos (tabla O columna) deben coincidir EXACTAMENTE con lo esperado.
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS col,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'INSERT') AS can_insert,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'UPDATE') AS can_update
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('school_years', 'groups')
  LOOP
    IF r.can_insert <> (v_expected -> r.tabla -> 'insert' ? r.col) THEN
      v_bad := v_bad || format(E'\n INSERT %s.%s efectivo=%s', r.tabla, r.col, r.can_insert);
    END IF;
    IF r.can_update <> (v_expected -> r.tabla -> 'update' ? r.col) THEN
      v_bad := v_bad || format(E'\n UPDATE %s.%s efectivo=%s', r.tabla, r.col, r.can_update);
    END IF;
  END LOOP;
  -- Nunca: DELETE, TRUNCATE, REFERENCES, TRIGGER sobre el catalogo; nada de escritura sobre las tablas de autorizacion.
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('school_years', 'groups')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP
    v_bad := v_bad || format(E'\n %s sobre %s no debe existir', r.priv, r.tabla);
  END LOOP;
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('role_permissions', 'permissions', 'roles')
       AND (has_table_privilege('eta15_api', c.oid, p.priv)
            OR (p.priv IN ('INSERT', 'UPDATE') AND EXISTS (
                  SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                     AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv))))
  LOOP
    v_bad := v_bad || format(E'\n %s sobre %s no debe existir', r.priv, r.tabla);
  END LOOP;
  IF has_schema_privilege('eta15_api', 'public', 'CREATE') THEN v_bad := v_bad || E'\n CREATE en public'; END IF;
  IF pg_has_role('eta15_api', 'eta15_app', 'MEMBER') THEN v_bad := v_bad || E'\n miembro de eta15_app'; END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'Privilegios efectivos de eta15_api inesperados:%', v_bad;
  END IF;
  RAISE NOTICE 'OK: eta15_api tiene exactamente la escritura por columna esperada sobre school_years y groups';
END
$$;
