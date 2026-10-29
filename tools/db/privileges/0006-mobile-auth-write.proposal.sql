\quit
-- ========================================================================================================
-- PROPUESTA (NO APLICADA en eta15_dev): privilegios minimos de eta15_api sobre la autenticacion movil AISLADA (tablas
-- `mobile_device_requests`, `mobile_devices`, `mobile_sessions`, `mobile_proof_jtis` y `mobile_nonces` de la migracion 0011, que TAMPOCO esta aplicada). La linea 1 (\quit)
-- impide ejecutarla completa con psql -f. Requiere la migracion 0011 y las propuestas 0002 a 0005 ya aplicadas, y autorizacion
-- explicita (ADR 0005 sigue en estado "propuesta": esta propuesta NO equivale a aprobar el canal movil). Se ejecuta con
-- `pnpm db:apply-privileges 0006-mobile-auth-write --sha256=<hash del .apply.sql>` (ensayo con ROLLBACK; con --execute hace COMMIT),
-- nunca pegando SQL a mano.
--
-- PRINCIPIOS: todo POR COLUMNA, tambien SELECT. Una columna futura no es legible ni escribible por la API hasta concederla.
-- Sin DELETE, TRUNCATE, TRIGGER, REFERENCES, CREATE ni GRANT OPTION; sin escritura sobre role_permissions/permissions/roles.
--
--   mobile_device_requests  SELECT (todas salvo updated_at)
--                           INSERT (key_thumbprint, public_key_jwk, device_label, pairing_code_hash, created_at, expires_at, requested_ip)
--                                 -- nace pendiente y anonima: el trigger rechaza titular, aprobacion o intentos; `id`, `status`,
--                                 -- `platform` y `claim_failures` van por DEFAULT. La caducidad esta acotada por mdr_expiry_window.
--                           UPDATE (status, user_id, claim_failures, approved_by, closed_by)
--                                 -- reclamar, aprobar, rechazar/cancelar, activar y contar intentos; las HORAS (`claimed_at`,
--                                 -- `approved_at`, `activated_at`, `closed_at`, `updated_at`) las fija el trigger: la API no las elige.
--                                 -- La identidad (clave, huella, codigo, etiqueta, caducidad) no se puede actualizar ni por columna.
--   mobile_devices          SELECT (todas)
--                           INSERT (user_id, key_thumbprint, public_key_jwk, label, request_id, approved_by)
--                                 -- `registered_at` lo fija el trigger con now(); `status` nace 'active'.
--                           UPDATE (status, revoked_by, revoke_reason, last_seen_at)
--                                 -- revocar (activo -> revocado, sin vuelta; `revoked_at` lo fija el trigger) y registrar actividad.
--   mobile_sessions         SELECT (todas; los hashes se leen para buscar por credencial, nunca hay tokens en claro)
--                           INSERT (device_id, user_id, access_hash, refresh_hash, created_at, access_expires_at, idle_expires_at,
--                                   absolute_expires_at, ip, user_agent)
--                           UPDATE (access_hash, refresh_hash, previous_refresh_hash, access_expires_at, idle_expires_at, refresh_count,
--                                   revoked_reason, revoked_by)
--                                 -- rotar la renovacion o revocar; `revoked_at` y `last_refreshed_at` los fija el trigger.
--     Fuera de UPDATE: la identidad de la sesion (dispositivo, cuenta, ip, agente), `created_at` y la caducidad absoluta.
--   mobile_proof_jtis       SELECT (key_thumbprint, expires_at)   -- solo para contar las pruebas vigentes de UNA clave (limite por clave)
--                           INSERT (key_thumbprint, jti_hash, seen_at, expires_at)
--                                 -- registra una prueba DPoP aceptada; la PRIMARY KEY rechaza la repeticion de forma atomica entre
--                                 -- instancias. Sin UPDATE (el trigger tambien lo prohibe), sin DELETE ni TRUNCATE: la limpieza de
--                                 -- filas vencidas la hace el PROPIETARIO (docs/architecture/auth-rbac.md), nunca la API.
--   mobile_nonces           SELECT (nonce_hash, key_thumbprint, expires_at, consumed_at)
--                           INSERT (nonce_hash, key_thumbprint, issued_at, expires_at)
--                           UPDATE (consumed_at)                  -- gastar el nonce (NULL -> hora, una sola vez: lo exige el trigger)
--   Funciones (EXECUTE solo para eta15_api; PUBLIC no tiene EXECUTE, ver la migracion 0011): `mobile_user_eligible(uuid, timestamptz)`
--     y `mobile_actor_can_manage(uuid)`, que usan los triggers (SECURITY INVOKER) y el servicio. Las funciones de trigger NO reciben
--     EXECUTE: PostgreSQL no lo exige para dispararlas.
-- Los triggers de la 0011 son SECURITY INVOKER: usan estos privilegios y los ya aprobados de lectura sobre users, user_roles, roles,
-- role_permissions y permissions (GRANT SELECT sobre todas las tablas existentes en el PASO 3 de los roles). `FOR UPDATE`/`FOR SHARE`
-- sobre las tablas moviles exigen algun UPDATE de columna sobre ellas: lo da esta propuesta.
-- IDEMPOTENTE (GRANT lo es). Reversible con el REVOKE de abajo. Verificable con 0006-mobile-auth-write.verify.sql.
-- ========================================================================================================

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

-- Reversion (solo si se decide retirar el acceso de la API a estas tablas):
--   REVOKE ALL ON mobile_device_requests, mobile_devices, mobile_sessions, mobile_proof_jtis, mobile_nonces FROM eta15_api;
--   REVOKE EXECUTE ON FUNCTION mobile_user_eligible(uuid, timestamp with time zone), mobile_actor_can_manage(uuid) FROM eta15_api;
