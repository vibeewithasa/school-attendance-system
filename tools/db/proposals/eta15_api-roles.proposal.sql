\quit
-- ========================================================================================================
-- Separar el rol de ejecucion de la API (eta15_api) del propietario/migrador (eta15_app).
-- La linea 1 (\quit) impide ejecutarla completa con psql -f: se ejecuta POR PASOS (extraidos de este archivo).
-- Detalle, validacion y procedimiento: docs/architecture/roles-postgresql.md
--
-- ALCANCE DE CADA OPERACION (auditado):
--   * CREATE ROLE / ALTER ROLE ... SET : objeto del CLUSTER, pero el rol es nuevo; los SET solo afectan a eta15_api.
--   * REVOKE/GRANT ... ON DATABASE eta15_dev : SOLO esa base. No toca beauty_pos ni postgres.
--   * ALTER DEFAULT PRIVILEGES : por base de datos (catalogo pg_default_acl de eta15_dev) y por rol (eta15_app).
--   * Resto : privilegios sobre objetos del esquema public de eta15_dev.
--   * Nada destructivo: sin DROP, TRUNCATE ni DELETE; sin DROP OWNED.
-- Residual (PostgreSQL, no modificable aqui): PUBLIC conserva CONNECT/TEMPORARY en beauty_pos y postgres, asi que
-- eta15_api PODRA conectarse a ellas (sin privilegios sobre sus objetos propios). No hay aislamiento total.
--
-- Contrasena: NO va en este archivo, ni en argumentos, ni en historial. La teclea la persona con \password.
-- ========================================================================================================

-- ===== PASO 1 - SUPERUSUARIO (CREATE ROLE requiere CREATEROLE). El rol nace SIN LOGIN y sin contrasena =====
CREATE ROLE eta15_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 30;
ALTER ROLE eta15_api SET statement_timeout = '15s';
ALTER ROLE eta15_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE eta15_api SET search_path = public;
-- Solo en eta15_dev:
REVOKE CONNECT ON DATABASE eta15_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE eta15_dev TO eta15_app, eta15_api;
-- eta15_api NO debe ser miembro de eta15_app (ni directa ni indirectamente): no hay GRANT eta15_app TO eta15_api.

-- ===== PASO 2 - eta15_app (propietario de la base y de los objetos), conectado a eta15_dev =====
-- Sin objetos temporales: evita funciones/tablas en pg_temp.
REVOKE TEMPORARY ON DATABASE eta15_dev FROM PUBLIC;
-- Las funciones nuevas que cree eta15_app NO nacen ejecutables por PUBLIC (solo en esta base).
ALTER DEFAULT PRIVILEGES FOR ROLE eta15_app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO eta15_api;            -- sin CREATE
GRANT SELECT ON ALL TABLES IN SCHEMA public TO eta15_api;

GRANT INSERT ON users, user_roles, sessions, auth_tokens, audit_events TO eta15_api;   -- NO role_permissions (solo lectura)
GRANT UPDATE (display_name, email, email_kind, email_verified_at, status, password_hash, password_changed_at,
              must_change_password, last_login_at, failed_login_count, last_failed_login_at, locked_until)
  ON users TO eta15_api;
GRANT UPDATE (revoked_at, revoked_by) ON user_roles TO eta15_api;
GRANT UPDATE (last_seen_at, idle_expires_at, mfa_verified_at, revoked_at, revoked_reason, revoked_by)
  ON sessions TO eta15_api;
GRANT UPDATE (authorized_at, authorized_by, verification_method, used_at, invalidated_at) ON auth_tokens TO eta15_api;
GRANT DELETE ON sessions, auth_tokens TO eta15_api;   -- purga de sesiones/tokens vencidos
-- role_permissions es de SOLO LECTURA para la API (tools/db/privileges/0001-role-permissions-select-only.sql): los permisos de
-- los roles cambian por migracion (eta15_app) hasta que exista una administracion de roles revisada.

-- Unicos EXECUTE necesarios: los ayudantes que invocan los triggers.
GRANT EXECUTE ON FUNCTION auth_is_schema_owner(), auth_lock_authority(uuid, text), auth_current_actor() TO eta15_api;

-- NUNCA conceder a eta15_api: TRIGGER (permite adjuntar triggers propios y esquivar las guardas), TRUNCATE,
-- REFERENCES, CREATE en el esquema, DELETE sobre users/user_roles/audit_events/roles/permissions,
-- ALL PRIVILEGES, ni la pertenencia a eta15_app. No tiene USAGE sobre el esquema drizzle (historial de migraciones).
-- Cuando existan los endpoints del catalogo se agregara, con revision, INSERT/UPDATE por columnas sobre
-- school_years y groups.

-- ===== PASO 3 - SUPERUSUARIO, en una terminal local, DESPUES de verificar los privilegios (PASO 2) =====
-- 3a. La persona teclea la contrasena de forma interactiva (psql la lee del terminal; no se registra):
\password eta15_api
-- 3b. Solo ahora se habilita el inicio de sesion:
ALTER ROLE eta15_api LOGIN;
