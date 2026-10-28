-- Verificacion de SOLO LECTURA de los privilegios efectivos de eta15_api sobre la autenticacion movil aislada
-- (propuesta 0006-mobile-auth-write.proposal.sql). Ejecutar como eta15_app: psql -v ON_ERROR_STOP=1 -f <este archivo>
-- Compara los privilegios EFECTIVOS (tabla + columna + PUBLIC, via has_table_privilege / has_column_privilege / aclexplode) con
-- el estado esperado y falla con una excepcion si difieren (privilegios de mas O de menos). Sin DDL ni datos.

DO $$
DECLARE
  r record;
  v_bad text := '';
  v_expected jsonb := jsonb_build_object(
    'mobile_device_requests', jsonb_build_object(
      'select', jsonb_build_array('id', 'user_id', 'key_thumbprint', 'public_key_jwk', 'device_label', 'platform', 'pairing_code_hash', 'claim_failures', 'status', 'created_at', 'expires_at', 'requested_ip', 'claimed_at', 'approved_by', 'approved_at', 'activated_at', 'closed_by', 'closed_at'),
      'insert', jsonb_build_array('key_thumbprint', 'public_key_jwk', 'device_label', 'pairing_code_hash', 'created_at', 'expires_at', 'requested_ip'),
      'update', jsonb_build_array('status', 'user_id', 'claim_failures', 'approved_by', 'closed_by')),
    'mobile_devices', jsonb_build_object(
      'select', jsonb_build_array('id', 'user_id', 'key_thumbprint', 'public_key_jwk', 'label', 'request_id', 'approved_by', 'registered_at', 'status', 'revoked_at', 'revoked_by', 'revoke_reason', 'last_seen_at'),
      'insert', jsonb_build_array('user_id', 'key_thumbprint', 'public_key_jwk', 'label', 'request_id', 'approved_by'),
      'update', jsonb_build_array('status', 'revoked_by', 'revoke_reason', 'last_seen_at')),
    'mobile_sessions', jsonb_build_object(
      'select', jsonb_build_array('id', 'device_id', 'user_id', 'access_hash', 'refresh_hash', 'previous_refresh_hash', 'created_at', 'access_expires_at', 'idle_expires_at', 'absolute_expires_at', 'last_refreshed_at', 'refresh_count', 'revoked_at', 'revoked_reason', 'revoked_by', 'ip', 'user_agent'),
      'insert', jsonb_build_array('device_id', 'user_id', 'access_hash', 'refresh_hash', 'created_at', 'access_expires_at', 'idle_expires_at', 'absolute_expires_at', 'ip', 'user_agent'),
      'update', jsonb_build_array('access_hash', 'refresh_hash', 'previous_refresh_hash', 'access_expires_at', 'idle_expires_at', 'refresh_count', 'revoked_reason', 'revoked_by')),
    'mobile_proof_jtis', jsonb_build_object(
      'select', jsonb_build_array('key_thumbprint', 'expires_at'),
      'insert', jsonb_build_array('key_thumbprint', 'jti_hash', 'seen_at', 'expires_at'),
      'update', jsonb_build_array()),
    'mobile_nonces', jsonb_build_object(
      'select', jsonb_build_array('nonce_hash', 'key_thumbprint', 'expires_at', 'consumed_at'),
      'insert', jsonb_build_array('nonce_hash', 'key_thumbprint', 'issued_at', 'expires_at'),
      'update', jsonb_build_array('consumed_at')));
BEGIN
  -- Columna a columna: SELECT/INSERT/UPDATE efectivos (tabla O columna) EXACTAMENTE los esperados.
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS col,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'SELECT') AS can_select,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'INSERT') AS can_insert,
           has_column_privilege('eta15_api', c.oid, a.attnum, 'UPDATE') AS can_update
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces')
  LOOP
    IF r.can_select <> (v_expected -> r.tabla -> 'select' ? r.col) THEN v_bad := v_bad || format(E'\n SELECT %s.%s efectivo=%s', r.tabla, r.col, r.can_select); END IF;
    IF r.can_insert <> (v_expected -> r.tabla -> 'insert' ? r.col) THEN v_bad := v_bad || format(E'\n INSERT %s.%s efectivo=%s', r.tabla, r.col, r.can_insert); END IF;
    IF r.can_update <> (v_expected -> r.tabla -> 'update' ? r.col) THEN v_bad := v_bad || format(E'\n UPDATE %s.%s efectivo=%s', r.tabla, r.col, r.can_update); END IF;
  END LOOP;
  -- Nunca: DELETE, TRUNCATE, REFERENCES, TRIGGER sobre las tablas (el historial de vinculacion no se borra).
  FOR r IN
    SELECT c.relname AS tabla, p.priv FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s sobre %s no debe existir', r.priv, r.tabla); END LOOP;
  -- Ningun privilegio de tabla completa de escritura (todo va por columna).
  FOR r IN
    SELECT c.relname AS tabla, p.priv FROM pg_class c CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s (tabla completa) sobre %s no debe existir', r.priv, r.tabla); END LOOP;
  -- Nada de escritura sobre las tablas de autorizacion.
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
  -- Funciones: EXECUTE solo en las dos de elegibilidad/autoridad; ninguna funcion de trigger; PUBLIC nunca.
  FOR r IN
    SELECT p.oid::regprocedure::text AS firma, p.proname,
           has_function_privilege('eta15_api', p.oid, 'EXECUTE') AS can_exec,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable)) AS public_or_option
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('mobile_user_eligible', 'mobile_actor_can_manage', 'mobile_auth_no_delete', 'mdr_guard_insert', 'mdr_guard_update',
                         'md_guard_insert', 'md_guard_update', 'ms_guard_insert', 'ms_guard_update', 'mobile_ephemeral_guard_delete',
                         'mobile_proof_guard_update', 'mn_guard_update')
  LOOP
    IF r.can_exec <> (r.proname IN ('mobile_user_eligible', 'mobile_actor_can_manage')) THEN
      v_bad := v_bad || format(E'\n EXECUTE efectivo=%s sobre %s', r.can_exec, r.firma);
    END IF;
    IF r.public_or_option THEN v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION en la funcion %s', r.firma); END IF;
  END LOOP;
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
       AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces', 'role_permissions', 'permissions', 'roles')
       AND (EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))
            OR EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a
                        WHERE at.attrelid = c.oid AND at.attacl IS NOT NULL
                          AND (a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))))
  LOOP v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION en %s', r.tabla); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Privilegios efectivos de eta15_api inesperados:%', v_bad; END IF;
  RAISE NOTICE 'OK: eta15_api tiene exactamente el acceso por columna esperado a la autenticacion movil';
END
$$;
