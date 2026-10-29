-- ========================================================================================================
-- EJECUCION CONTROLADA de 0006-mobile-auth-write.proposal.sql. NO se ejecuta a mano: la corre
-- `pnpm db:apply-privileges 0006-mobile-auth-write` (apps/api/scripts/apply-privileges.ts), que verifica la identidad
-- eta15_app / eta15_dev, que los GRANT de este archivo son IDENTICOS a los de la propuesta y que no hay otras sentencias,
-- fija el SHA-256 y ejecuta este archivo y 0006-mobile-auth-write.verify.sql en UNA SOLA transaccion (sin cambios parciales).
-- Solo hace COMMIT con --execute; sin esa opcion hace ROLLBACK (ensayo). Idempotente. Sin REVOKE ni DDL.
-- ESTA PROPUESTA NO ESTA APLICADA en eta15_dev ni la migracion 0011 que necesita. ADR 0005 sigue como "propuesta".
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
  -- la migracion 0011 debe estar aplicada: tablas con el propietario correcto, restricciones, triggers y funciones de proteccion
  FOR r IN SELECT t.name FROM (VALUES ('mobile_device_requests'), ('mobile_devices'), ('mobile_sessions'),
                                      ('mobile_proof_jtis'), ('mobile_nonces'),
                                      ('users'), ('user_roles'), ('roles'), ('role_permissions'), ('permissions')) t(name)
             LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> 'eta15_app' LOOP
    v_bad := v_bad || E'\n tabla ' || r.name || ' ausente (falta la migracion 0011) o con otro propietario';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('mdr_status_values'), ('mdr_claim_consistent'), ('mdr_approval_consistent'), ('mdr_expiry_window'),
                                      ('md_thumbprint_key'), ('md_revocation_consistent'), ('ms_access_hash_key'), ('ms_refresh_hash_key'),
                                      ('ms_device_user_fkey'), ('mpj_pkey'), ('mpj_expiry_window'), ('mn_expiry_window'), ('mn_consumed_order')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t.name) LOOP
    v_bad := v_bad || E'\n falta la restriccion ' || r.name || ' de la migracion 0011';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('mdr_open_thumbprint_key'), ('mdr_open_user_key'), ('ms_one_active_per_device'), ('mpj_key_expires_idx'), ('mn_key_expires_idx')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = t.name AND relkind = 'i' AND relnamespace = 'public'::regnamespace) LOOP
    v_bad := v_bad || E'\n falta el indice unico ' || r.name || ' de la migracion 0011';
  END LOOP;
  FOR r IN SELECT t.name FROM (VALUES ('mdr_guard_insert'), ('mdr_guard_update'), ('md_guard_insert'), ('md_guard_update'),
                                      ('ms_guard_insert'), ('ms_guard_update'), ('mdr_no_delete'), ('md_no_delete'), ('ms_no_delete'),
                                      ('mdr_no_truncate'), ('md_no_truncate'), ('ms_no_truncate'),
                                      ('mpj_guard_delete'), ('mpj_no_update'), ('mpj_no_truncate'), ('mn_guard_delete'), ('mn_guard_update'),
                                      ('mn_no_truncate')) t(name)
            WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t.name AND NOT tgisinternal) LOOP
    v_bad := v_bad || E'\n falta el trigger ' || r.name || ' de la migracion 0011';
  END LOOP;
  FOR r IN SELECT t.sig FROM (VALUES ('mobile_user_eligible(uuid, timestamp with time zone)'), ('mobile_actor_can_manage(uuid)')) t(sig)
            WHERE to_regprocedure('public.' || t.sig) IS NULL LOOP
    v_bad := v_bad || E'\n falta la funcion ' || r.sig || ' de la migracion 0011';
  END LOOP;
  -- los permisos moviles del catalogo RBAC existen y la API sigue sin poder escribirlos
  FOR r IN SELECT t.key FROM (VALUES ('mobile_devices:manage'), ('mobile_devices:enroll')) t(key)
            WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.key = t.key) LOOP
    v_bad := v_bad || E'\n falta el permiso ' || r.key || ' (migracion 0011)';
  END LOOP;
  -- prerrequisitos de lectura (las funciones y triggers de la 0011 leen estas tablas con los privilegios de eta15_api)
  FOR r IN SELECT t.tbl, t.col FROM (VALUES
             ('users', 'id'), ('users', 'status'), ('users', 'account_domain'), ('users', 'locked_until'),
             ('users', 'display_name'), ('users', 'must_change_password'),
             ('user_roles', 'user_id'), ('user_roles', 'role_id'), ('user_roles', 'revoked_at'), ('user_roles', 'granted_at'),
             ('roles', 'id'), ('roles', 'key'), ('roles', 'requires_mfa'),
             ('role_permissions', 'role_id'), ('role_permissions', 'permission_id'),
             ('permissions', 'id'), ('permissions', 'key')) t(tbl, col)
            WHERE NOT has_column_privilege('eta15_api', ('public.' || t.tbl)::regclass, t.col, 'SELECT') LOOP
    v_bad := v_bad || E'\n falta SELECT sobre ' || r.tbl || '.' || r.col;
  END LOOP;
  -- nada fuera de lo aprobado antes de empezar
  FOR r IN
    SELECT c.relname AS tabla, p.priv
      FROM pg_class c CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces', 'role_permissions')
       AND has_table_privilege('eta15_api', c.oid, p.priv)
  LOOP v_bad := v_bad || format(E'\n %s previo sobre %s', r.priv, r.tabla); END LOOP;
  IF has_table_privilege('eta15_api', 'public.role_permissions', 'INSERT') OR has_table_privilege('eta15_api', 'public.role_permissions', 'UPDATE') THEN
    v_bad := v_bad || E'\n escritura previa sobre role_permissions';
  END IF;
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces')
       AND (EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))
            OR EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a
                        WHERE at.attrelid = c.oid AND at.attacl IS NOT NULL
                          AND (a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))))
  LOOP v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION previo en %s', r.tabla); END LOOP;
  -- funciones: PUBLIC sin acceso y eta15_api sin GRANT OPTION
  FOR r IN
    SELECT p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('mobile_user_eligible', 'mobile_actor_can_manage', 'mobile_auth_no_delete', 'mdr_guard_insert', 'mdr_guard_update',
                         'md_guard_insert', 'md_guard_update', 'ms_guard_insert', 'ms_guard_update', 'mobile_ephemeral_guard_delete',
                         'mobile_proof_guard_update', 'mn_guard_update')
       AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 OR (a.grantee = 'eta15_api'::regrole AND a.is_grantable))
  LOOP v_bad := v_bad || format(E'\n PUBLIC o GRANT OPTION previo en la funcion %s', r.proname); END LOOP;
  -- privilegios de columna previos solo dentro de lo aprobado (permite repetir la ejecucion)
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS col, p.priv
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) AS p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('mobile_device_requests', 'mobile_devices', 'mobile_sessions', 'mobile_proof_jtis', 'mobile_nonces')
       AND has_column_privilege('eta15_api', c.oid, a.attnum, p.priv)
       AND NOT ((c.relname, p.priv, a.attname) IN (
         ('mobile_device_requests', 'SELECT', 'id'), ('mobile_device_requests', 'SELECT', 'user_id'), ('mobile_device_requests', 'SELECT', 'key_thumbprint'),
         ('mobile_device_requests', 'SELECT', 'public_key_jwk'), ('mobile_device_requests', 'SELECT', 'device_label'), ('mobile_device_requests', 'SELECT', 'platform'),
         ('mobile_device_requests', 'SELECT', 'pairing_code_hash'), ('mobile_device_requests', 'SELECT', 'claim_failures'), ('mobile_device_requests', 'SELECT', 'status'),
         ('mobile_device_requests', 'SELECT', 'created_at'), ('mobile_device_requests', 'SELECT', 'expires_at'), ('mobile_device_requests', 'SELECT', 'requested_ip'),
         ('mobile_device_requests', 'SELECT', 'claimed_at'), ('mobile_device_requests', 'SELECT', 'approved_by'), ('mobile_device_requests', 'SELECT', 'approved_at'),
         ('mobile_device_requests', 'SELECT', 'activated_at'), ('mobile_device_requests', 'SELECT', 'closed_by'), ('mobile_device_requests', 'SELECT', 'closed_at'),
         ('mobile_device_requests', 'INSERT', 'key_thumbprint'), ('mobile_device_requests', 'INSERT', 'public_key_jwk'), ('mobile_device_requests', 'INSERT', 'device_label'),
         ('mobile_device_requests', 'INSERT', 'pairing_code_hash'), ('mobile_device_requests', 'INSERT', 'created_at'), ('mobile_device_requests', 'INSERT', 'expires_at'),
         ('mobile_device_requests', 'INSERT', 'requested_ip'),
         ('mobile_device_requests', 'UPDATE', 'status'), ('mobile_device_requests', 'UPDATE', 'user_id'), ('mobile_device_requests', 'UPDATE', 'claim_failures'),
         ('mobile_device_requests', 'UPDATE', 'approved_by'), ('mobile_device_requests', 'UPDATE', 'closed_by'),
         ('mobile_devices', 'SELECT', 'id'), ('mobile_devices', 'SELECT', 'user_id'), ('mobile_devices', 'SELECT', 'key_thumbprint'),
         ('mobile_devices', 'SELECT', 'public_key_jwk'), ('mobile_devices', 'SELECT', 'label'), ('mobile_devices', 'SELECT', 'request_id'),
         ('mobile_devices', 'SELECT', 'approved_by'), ('mobile_devices', 'SELECT', 'registered_at'), ('mobile_devices', 'SELECT', 'status'),
         ('mobile_devices', 'SELECT', 'revoked_at'), ('mobile_devices', 'SELECT', 'revoked_by'), ('mobile_devices', 'SELECT', 'revoke_reason'),
         ('mobile_devices', 'SELECT', 'last_seen_at'),
         ('mobile_devices', 'INSERT', 'user_id'), ('mobile_devices', 'INSERT', 'key_thumbprint'), ('mobile_devices', 'INSERT', 'public_key_jwk'),
         ('mobile_devices', 'INSERT', 'label'), ('mobile_devices', 'INSERT', 'request_id'), ('mobile_devices', 'INSERT', 'approved_by'),
         ('mobile_devices', 'UPDATE', 'status'), ('mobile_devices', 'UPDATE', 'revoked_by'), ('mobile_devices', 'UPDATE', 'revoke_reason'),
         ('mobile_devices', 'UPDATE', 'last_seen_at'),
         ('mobile_sessions', 'SELECT', 'id'), ('mobile_sessions', 'SELECT', 'device_id'), ('mobile_sessions', 'SELECT', 'user_id'),
         ('mobile_sessions', 'SELECT', 'access_hash'), ('mobile_sessions', 'SELECT', 'refresh_hash'), ('mobile_sessions', 'SELECT', 'previous_refresh_hash'),
         ('mobile_sessions', 'SELECT', 'created_at'), ('mobile_sessions', 'SELECT', 'access_expires_at'), ('mobile_sessions', 'SELECT', 'idle_expires_at'),
         ('mobile_sessions', 'SELECT', 'absolute_expires_at'), ('mobile_sessions', 'SELECT', 'last_refreshed_at'), ('mobile_sessions', 'SELECT', 'refresh_count'),
         ('mobile_sessions', 'SELECT', 'revoked_at'), ('mobile_sessions', 'SELECT', 'revoked_reason'), ('mobile_sessions', 'SELECT', 'revoked_by'),
         ('mobile_sessions', 'SELECT', 'ip'), ('mobile_sessions', 'SELECT', 'user_agent'),
         ('mobile_sessions', 'INSERT', 'device_id'), ('mobile_sessions', 'INSERT', 'user_id'), ('mobile_sessions', 'INSERT', 'access_hash'),
         ('mobile_sessions', 'INSERT', 'refresh_hash'), ('mobile_sessions', 'INSERT', 'created_at'), ('mobile_sessions', 'INSERT', 'access_expires_at'),
         ('mobile_sessions', 'INSERT', 'idle_expires_at'), ('mobile_sessions', 'INSERT', 'absolute_expires_at'), ('mobile_sessions', 'INSERT', 'ip'),
         ('mobile_sessions', 'INSERT', 'user_agent'),
         ('mobile_sessions', 'UPDATE', 'access_hash'), ('mobile_sessions', 'UPDATE', 'refresh_hash'), ('mobile_sessions', 'UPDATE', 'previous_refresh_hash'),
         ('mobile_sessions', 'UPDATE', 'access_expires_at'), ('mobile_sessions', 'UPDATE', 'idle_expires_at'), ('mobile_sessions', 'UPDATE', 'refresh_count'),
         ('mobile_sessions', 'UPDATE', 'revoked_reason'), ('mobile_sessions', 'UPDATE', 'revoked_by'),
         ('mobile_proof_jtis', 'SELECT', 'key_thumbprint'), ('mobile_proof_jtis', 'SELECT', 'expires_at'),
         ('mobile_proof_jtis', 'INSERT', 'key_thumbprint'), ('mobile_proof_jtis', 'INSERT', 'jti_hash'), ('mobile_proof_jtis', 'INSERT', 'seen_at'),
         ('mobile_proof_jtis', 'INSERT', 'expires_at'),
         ('mobile_nonces', 'SELECT', 'nonce_hash'), ('mobile_nonces', 'SELECT', 'key_thumbprint'), ('mobile_nonces', 'SELECT', 'expires_at'),
         ('mobile_nonces', 'SELECT', 'consumed_at'),
         ('mobile_nonces', 'INSERT', 'nonce_hash'), ('mobile_nonces', 'INSERT', 'key_thumbprint'), ('mobile_nonces', 'INSERT', 'issued_at'),
         ('mobile_nonces', 'INSERT', 'expires_at'), ('mobile_nonces', 'UPDATE', 'consumed_at')))
  LOOP v_bad := v_bad || format(E'\n %s previo fuera de lo aprobado: %s.%s', r.priv, r.tabla, r.col); END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'Preflight de privilegios fallido:%', v_bad; END IF;
  RAISE NOTICE 'Preflight OK';
END
$$;

GRANT SELECT (id, user_id, key_thumbprint, public_key_jwk, device_label, platform, pairing_code_hash, claim_failures, status, created_at, expires_at, requested_ip, claimed_at, approved_by, approved_at, activated_at, closed_by, closed_at) ON mobile_device_requests TO eta15_api;
GRANT INSERT (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, created_at, expires_at, requested_ip) ON mobile_device_requests TO eta15_api;
GRANT UPDATE (status, user_id, claim_failures, approved_by, closed_by) ON mobile_device_requests TO eta15_api;
GRANT SELECT (id, user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by, registered_at, status, revoked_at, revoked_by, revoke_reason, last_seen_at) ON mobile_devices TO eta15_api;
GRANT INSERT (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by) ON mobile_devices TO eta15_api;
GRANT UPDATE (status, revoked_by, revoke_reason, last_seen_at) ON mobile_devices TO eta15_api;
GRANT SELECT (id, device_id, user_id, access_hash, refresh_hash, previous_refresh_hash, created_at, access_expires_at, idle_expires_at, absolute_expires_at, last_refreshed_at, refresh_count, revoked_at, revoked_reason, revoked_by, ip, user_agent) ON mobile_sessions TO eta15_api;
GRANT INSERT (device_id, user_id, access_hash, refresh_hash, created_at, access_expires_at, idle_expires_at, absolute_expires_at, ip, user_agent) ON mobile_sessions TO eta15_api;
GRANT UPDATE (access_hash, refresh_hash, previous_refresh_hash, access_expires_at, idle_expires_at, refresh_count, revoked_reason, revoked_by) ON mobile_sessions TO eta15_api;
GRANT SELECT (key_thumbprint, expires_at) ON mobile_proof_jtis TO eta15_api;
GRANT INSERT (key_thumbprint, jti_hash, seen_at, expires_at) ON mobile_proof_jtis TO eta15_api;
GRANT SELECT (nonce_hash, key_thumbprint, expires_at, consumed_at) ON mobile_nonces TO eta15_api;
GRANT INSERT (nonce_hash, key_thumbprint, issued_at, expires_at) ON mobile_nonces TO eta15_api;
GRANT UPDATE (consumed_at) ON mobile_nonces TO eta15_api;
GRANT EXECUTE ON FUNCTION mobile_user_eligible(uuid, timestamp with time zone) TO eta15_api;
GRANT EXECUTE ON FUNCTION mobile_actor_can_manage(uuid) TO eta15_api;
