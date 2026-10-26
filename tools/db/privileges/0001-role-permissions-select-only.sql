-- ========================================================================================================
-- 0001 - eta15_api: SOLO LECTURA sobre public.role_permissions.   (APROBADO; aplicado en eta15_dev 2026-10-26)
--
-- Ejecutar como el PROPIETARIO del esquema (eta15_app) conectado a la base de la aplicacion. Es idempotente:
-- repetirlo no cambia nada. Se ejecuta en UNA transaccion: si cualquier comprobacion falla, no queda nada aplicado.
--   psql -h 127.0.0.1 -U eta15_app -d eta15_dev -v ON_ERROR_STOP=1 -f tools/db/privileges/0001-role-permissions-select-only.sql
--   (psql pide la contrasena de forma interactiva; NUNCA va en este archivo, en argumentos ni en el historial.)
--
-- POR QUE: el trigger role_permissions_guard impide conceder o quitar permisos de AUTORIDAD (is_authority) y respeta los
-- dominios, pero con INSERT/DELETE una API comprometida podria anadir o quitar permisos ORDINARIOS de un rol. Ningun codigo
-- de la API escribe en esta tabla (verificado); los cambios de permisos se hacen por migracion (eta15_app) hasta que exista
-- una administracion de roles con su propia revision de seguridad.
--
-- ALCANCE: una sola tabla de UNA base de datos. REVOKE sobre un objeto de esta base no afecta a ninguna otra
-- (beauty_pos, postgres). Nada destructivo: ni DROP, ni TRUNCATE, ni DELETE de datos, ni DROP OWNED.
-- Las instalaciones nuevas ya NO conceden estos privilegios (tools/db/proposals/eta15_api-roles.proposal.sql, PASO 2),
-- por lo que en ellas este archivo es un no-op verificador.
--
-- Reversion (solo con revision de seguridad):  GRANT INSERT, DELETE ON TABLE public.role_permissions TO eta15_api;
-- ========================================================================================================

BEGIN;

-- Precondiciones: quien ejecuta es el propietario de la tabla y el rol existe.
DO $$
BEGIN
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'precondicion: no existe public.role_permissions (base equivocada)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid = 'public.role_permissions'::regclass AND pg_get_userbyid(c.relowner) = current_user
  ) THEN
    RAISE EXCEPTION 'precondicion: debe ejecutarlo el propietario de public.role_permissions, no %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eta15_api') THEN
    RAISE EXCEPTION 'precondicion: no existe el rol eta15_api';
  END IF;
END
$$;

REVOKE INSERT, DELETE ON TABLE public.role_permissions FROM eta15_api;

-- Verificacion: solo SELECT, a nivel de tabla y de columna; los demas privilegios de eta15_api no se tocan aqui.
DO $$
DECLARE
  p text;
BEGIN
  IF NOT has_table_privilege('eta15_api', 'public.role_permissions', 'SELECT') THEN
    RAISE EXCEPTION 'verificacion: eta15_api perdio SELECT';
  END IF;
  FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('eta15_api', 'public.role_permissions', p) THEN
      RAISE EXCEPTION 'verificacion: eta15_api conserva % sobre role_permissions', p;
    END IF;
  END LOOP;
  IF has_any_column_privilege('eta15_api', 'public.role_permissions', 'INSERT')
     OR has_any_column_privilege('eta15_api', 'public.role_permissions', 'UPDATE') THEN
    RAISE EXCEPTION 'verificacion: eta15_api conserva privilegios por columna sobre role_permissions';
  END IF;
  -- Ni siquiera por PUBLIC
  IF EXISTS (
    SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = 'public.role_permissions'::regclass)) a
     WHERE a.grantee = 0 AND a.privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'verificacion: PUBLIC tiene privilegios de escritura sobre role_permissions';
  END IF;
END
$$;

COMMIT;
