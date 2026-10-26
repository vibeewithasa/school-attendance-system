-- Integridad de Auth/RBAC que Drizzle no expresa. Escrita a mano; revisar antes de aplicar.
-- Va DESPUES de la semilla (0004) a proposito: la carga inicial del catalogo no dispara estas guardas.
-- Todas las funciones: SECURITY INVOKER, search_path fijo y objetos con esquema explicito.
--
-- Modelo de amenaza: estas guardas protegen frente al rol de EJECUCION de la API (no propietario) y frente a
-- errores de la aplicacion. NO protegen frente al propietario del esquema ni a un superusuario, que pueden
-- desactivar triggers o editar filas. Las guardas marcadas "propietario" solo tienen efecto cuando la API se
-- conecta con un rol distinto del propietario (ADR 0003); mientras sean el mismo rol (desarrollo), la
-- proteccion es procedimental. Ver docs/architecture/auth-rbac.md §4 y §9.

-- ---------------------------------------------------------------------------------------------------
-- 0. Ayudantes
-- ---------------------------------------------------------------------------------------------------

-- ¿La sesion actual actua como (miembro del) propietario del esquema? (migraciones, DBA, herramienta de consola)
CREATE FUNCTION "auth_is_schema_owner"() RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.user_roles'::pg_catalog.regclass
$$;--> statement-breakpoint

-- Verifica (y BLOQUEA con FOR SHARE) que la cuenta esta activa y tiene un permiso mediante un rol vigente.
-- El bloqueo evita que una revocacion o baja concurrente deje un privilegio inconsistente.
CREATE FUNCTION "auth_lock_authority"(p_user uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1
     FROM public."users" u
     JOIN public."user_roles" ur ON ur."user_id" = u."id" AND ur."revoked_at" IS NULL
     JOIN public."role_permissions" rp ON rp."role_id" = ur."role_id"
     JOIN public."permissions" p ON p."id" = rp."permission_id"
    WHERE u."id" = p_user AND u."status" = 'active' AND p."key" = p_key
      FOR SHARE OF u, ur;
  RETURN FOUND;
END;
$$;--> statement-breakpoint

-- Actor declarado por la aplicacion para la atribucion de la auditoria (SET LOCAL eta15.actor_id).
-- Es solo atribucion, NO autorizacion: la autorizacion nunca depende de este valor.
CREATE FUNCTION "auth_current_actor"() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v text := nullif(current_setting('eta15.actor_id', true), '');
  r uuid;
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT u."id" INTO r FROM public."users" u WHERE u."id" = v::uuid;
  RETURN r;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 1. updated_at automatico (reutiliza set_updated_at de la migracion 0001)
-- ---------------------------------------------------------------------------------------------------
CREATE TRIGGER "users_set_updated_at" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "roles_set_updated_at" BEFORE UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "permissions_set_updated_at" BEFORE UPDATE ON "permissions"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 2. Auditoria: sin UPDATE, DELETE ni TRUNCATE para quien no sea el propietario.
--    El propietario puede deshabilitar o quitar el trigger: no es inmutabilidad absoluta.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION "audit_events_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events es de solo insercion' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_immutable"();--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_immutable"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 3. users
-- ---------------------------------------------------------------------------------------------------

-- 3a. Altas: salvo el propietario (migraciones / herramienta de consola), una cuenta nace PENDIENTE, sin
--     contrasena, con creador activo que tenga users:manage_<dominio>.
CREATE FUNCTION "users_enforce_creator"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public."auth_is_schema_owner"() THEN
    RETURN NEW;
  END IF;
  IF NEW."status" <> 'pending' OR NEW."password_hash" IS NOT NULL THEN
    RAISE EXCEPTION 'Las cuentas se crean pendientes y sin contrasena' USING ERRCODE = '42501';
  END IF;
  IF NOT public."auth_lock_authority"(NEW."created_by", 'users:manage_' || NEW."account_domain") THEN
    RAISE EXCEPTION 'Quien crea la cuenta no tiene el permiso users:manage_%', NEW."account_domain" USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_enforce_creator" BEFORE INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION "users_enforce_creator"();--> statement-breakpoint

-- 3b. El dominio no cambia. Una cuenta pendiente solo se activa en la MISMA transaccion en que se consume su
--     token de invitacion autorizado (used_txid = transaccion actual, fijado por trigger): nadie activa cuentas "a mano".
CREATE FUNCTION "users_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."account_domain" IS DISTINCT FROM OLD."account_domain" THEN
    RAISE EXCEPTION 'account_domain es inmutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" = 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public."auth_tokens" t
       WHERE t."user_id" = NEW."id" AND t."purpose" = 'invite'
         AND t."used_txid" = pg_current_xact_id() AND t."authorized_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Una cuenta pendiente solo se activa al consumir su invitacion autorizada' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_guard_update" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "users_guard_update"();--> statement-breakpoint

-- 3c. Deshabilitar la cuenta o cambiar su contrasena revoca TODAS sus sesiones
--     (la aplicacion abre despues una sesion nueva si corresponde, en la misma transaccion).
CREATE FUNCTION "users_revoke_sessions"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public."sessions"
     SET "revoked_at" = now(),
         "revoked_reason" = CASE WHEN NEW."status" = 'disabled' AND OLD."status" IS DISTINCT FROM 'disabled'
                                 THEN 'disabled' ELSE 'password_changed' END
   WHERE "user_id" = NEW."id" AND "revoked_at" IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_revoke_sessions_on_disable" AFTER UPDATE OF "status" ON "users"
  FOR EACH ROW WHEN (NEW."status" = 'disabled' AND OLD."status" IS DISTINCT FROM 'disabled')
  EXECUTE FUNCTION "users_revoke_sessions"();--> statement-breakpoint
CREATE TRIGGER "users_revoke_sessions_on_password" AFTER UPDATE OF "password_hash" ON "users"
  FOR EACH ROW WHEN (OLD."password_hash" IS DISTINCT FROM NEW."password_hash")
  EXECUTE FUNCTION "users_revoke_sessions"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 4. sessions: solo cuentas activas; el tope de sesiones concurrentes lo impone la base, de forma atomica
--    (el bloqueo de la fila del usuario serializa los inicios de sesion simultaneos).
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION "sessions_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
  v_max integer;
  v_active integer;
  v_excess integer;
BEGIN
  SELECT u."status" INTO v_status FROM public."users" u WHERE u."id" = NEW."user_id" FOR UPDATE;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Solo las cuentas activas pueden abrir sesion' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(min(r."max_concurrent_sessions"), 5) INTO v_max
    FROM public."user_roles" ur JOIN public."roles" r ON r."id" = ur."role_id"
   WHERE ur."user_id" = NEW."user_id" AND ur."revoked_at" IS NULL;

  SELECT count(*) INTO v_active
    FROM public."sessions" s
   WHERE s."user_id" = NEW."user_id" AND s."revoked_at" IS NULL
     AND now() < least(s."expires_at", s."idle_expires_at");

  v_excess := v_active + 1 - v_max;
  IF v_excess > 0 THEN
    UPDATE public."sessions"
       SET "revoked_at" = now(), "revoked_reason" = 'concurrency'
     WHERE "id" IN (
       SELECT s."id" FROM public."sessions" s
        WHERE s."user_id" = NEW."user_id" AND s."revoked_at" IS NULL
          AND now() < least(s."expires_at", s."idle_expires_at")
        ORDER BY s."created_at", s."id"
        LIMIT v_excess
     );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_before_insert" BEFORE INSERT ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "sessions_before_insert"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 5. roles, permissions, role_permissions
-- ---------------------------------------------------------------------------------------------------

-- Clave y dominio de un rol/permiso no cambian; un rol de sistema no se borra ni deja de serlo.
CREATE FUNCTION "roles_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."is_system" THEN
      RAISE EXCEPTION 'Los roles de sistema no se eliminan' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."key" IS DISTINCT FROM OLD."key" OR NEW."domain" IS DISTINCT FROM OLD."domain" THEN
    RAISE EXCEPTION 'La clave y el dominio de un rol son inmutables' USING ERRCODE = '42501';
  END IF;
  IF OLD."is_system" AND NOT NEW."is_system" THEN
    RAISE EXCEPTION 'Un rol de sistema no puede dejar de serlo' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "roles_guard" BEFORE UPDATE OR DELETE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION "roles_guard"();--> statement-breakpoint

CREATE FUNCTION "permissions_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."key" IS DISTINCT FROM OLD."key" OR NEW."domain" IS DISTINCT FROM OLD."domain"
     OR NEW."is_authority" IS DISTINCT FROM OLD."is_authority" THEN
    RAISE EXCEPTION 'La clave, el dominio y la marca de autoridad de un permiso son inmutables' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "permissions_guard" BEFORE UPDATE ON "permissions"
  FOR EACH ROW EXECUTE FUNCTION "permissions_guard"();--> statement-breakpoint

-- Cambios sensibles de un rol (MFA obligatorio, politica de sesion) quedan auditados.
CREATE FUNCTION "roles_audit_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public."audit_events" ("event_type", "outcome", "actor_user_id", "details")
  VALUES ('role.updated', 'success', public."auth_current_actor"(),
          jsonb_build_object('role', NEW."key",
            'requires_mfa', jsonb_build_array(OLD."requires_mfa", NEW."requires_mfa"),
            'session_idle_minutes', jsonb_build_array(OLD."session_idle_minutes", NEW."session_idle_minutes"),
            'session_absolute_minutes', jsonb_build_array(OLD."session_absolute_minutes", NEW."session_absolute_minutes"),
            'max_concurrent_sessions', jsonb_build_array(OLD."max_concurrent_sessions", NEW."max_concurrent_sessions")));
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "roles_audit_update" AFTER UPDATE ON "roles"
  FOR EACH ROW WHEN (
    OLD."requires_mfa" IS DISTINCT FROM NEW."requires_mfa"
    OR OLD."session_idle_minutes" IS DISTINCT FROM NEW."session_idle_minutes"
    OR OLD."session_absolute_minutes" IS DISTINCT FROM NEW."session_absolute_minutes"
    OR OLD."max_concurrent_sessions" IS DISTINCT FROM NEW."max_concurrent_sessions"
  )
  EXECUTE FUNCTION "roles_audit_update"();--> statement-breakpoint

-- role_permissions: solo alta y baja (nunca UPDATE: ensanchar un scope debe ser un alta auditada);
-- los permisos de AUTORIDAD solo los cambia el propietario del esquema (migracion); la API no puede delegarlos.
CREATE FUNCTION "role_permissions_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'role_permissions no se actualiza: use baja y alta (ambas auditadas)' USING ERRCODE = '42501';
  END IF;
  SELECT p."is_authority" INTO v_authority FROM public."permissions" p
   WHERE p."id" = CASE WHEN TG_OP = 'INSERT' THEN NEW."permission_id" ELSE OLD."permission_id" END;
  IF v_authority AND NOT public."auth_is_schema_owner"() THEN
    RAISE EXCEPTION 'Los permisos de autoridad solo los cambia el propietario del esquema (migracion)' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'INSERT' THEN NEW ELSE OLD END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "role_permissions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION "role_permissions_guard"();--> statement-breakpoint

CREATE FUNCTION "role_permissions_audit"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record := CASE WHEN TG_OP = 'INSERT' THEN NEW ELSE OLD END;
  v_role text;
  v_perm text;
BEGIN
  SELECT ro."key" INTO v_role FROM public."roles" ro WHERE ro."id" = r."role_id";
  SELECT p."key" INTO v_perm FROM public."permissions" p WHERE p."id" = r."permission_id";
  INSERT INTO public."audit_events" ("event_type", "outcome", "actor_user_id", "details")
  VALUES ('role.permissions_changed', 'success', public."auth_current_actor"(),
          jsonb_build_object('role', v_role, 'permission', v_perm, 'scope', r."scope",
                             'change', CASE WHEN TG_OP = 'INSERT' THEN 'add' ELSE 'remove' END));
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "role_permissions_audit" AFTER INSERT OR DELETE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION "role_permissions_audit"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 6. user_roles: concesion, revocacion, bootstrap y recuperacion de emergencia
-- ---------------------------------------------------------------------------------------------------
--  - grant:     concedente activo con roles:grant_<dominio> (nunca la misma cuenta: CHECK).
--  - bootstrap: primer titular de un dominio NUNCA inicializado. Solo propietario del esquema, rol que contiene
--               roles:grant_<dominio>, referencia de acta, bajo bloqueo consultivo (sin carreras). Se cierra para
--               siempre: cualquier fila historica del dominio lo impide (el historial no se borra).
--  - recovery:  rescate presencial cuando el dominio YA fue inicializado pero no quedan titulares activos con
--               autoridad. Mismas condiciones de propietario, acta y bloqueo.
CREATE FUNCTION "user_roles_enforce_grant"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  grant_perm text := 'roles:grant_' || NEW."domain";
  v_status text;
BEGIN
  SELECT u."status" INTO v_status FROM public."users" u WHERE u."id" = NEW."user_id" FOR SHARE;
  IF v_status IS NULL OR v_status = 'disabled' THEN
    RAISE EXCEPTION 'No se puede conceder un rol a una cuenta deshabilitada' USING ERRCODE = '42501';
  END IF;

  IF NEW."grant_source" IN ('bootstrap', 'recovery') THEN
    IF NOT public."auth_is_schema_owner"() THEN
      RAISE EXCEPTION 'Solo el propietario del esquema puede ejecutar % (no el rol de la API)', NEW."grant_source" USING ERRCODE = '42501';
    END IF;
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION '% requiere nivel de aislamiento READ COMMITTED', NEW."grant_source" USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public."role_permissions" rp JOIN public."permissions" p ON p."id" = rp."permission_id"
       WHERE rp."role_id" = NEW."role_id" AND p."key" = grant_perm
    ) THEN
      RAISE EXCEPTION '% solo puede conceder un rol que contenga %', NEW."grant_source", grant_perm USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('eta15.first_holder.' || NEW."domain", 0));

    IF NEW."grant_source" = 'bootstrap' THEN
      IF EXISTS (SELECT 1 FROM public."user_roles" ur WHERE ur."domain" = NEW."domain") THEN
        RAISE EXCEPTION 'Bootstrap cerrado: el dominio % ya fue inicializado', NEW."domain" USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public."user_roles" ur WHERE ur."domain" = NEW."domain") THEN
        RAISE EXCEPTION 'Recovery requiere un dominio ya inicializado; use bootstrap' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public."user_roles" ur
          JOIN public."users" u ON u."id" = ur."user_id" AND u."status" = 'active'
          JOIN public."role_permissions" rp ON rp."role_id" = ur."role_id"
          JOIN public."permissions" p ON p."id" = rp."permission_id"
         WHERE ur."domain" = NEW."domain" AND ur."revoked_at" IS NULL AND p."key" = grant_perm
      ) THEN
        RAISE EXCEPTION 'Recovery no permitido: el dominio % aun tiene titulares activos con autoridad', NEW."domain" USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public."auth_lock_authority"(NEW."granted_by", grant_perm) THEN
    RAISE EXCEPTION 'Quien concede el rol debe ser una cuenta activa con el permiso %', grant_perm USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_roles_enforce_grant" BEFORE INSERT ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION "user_roles_enforce_grant"();--> statement-breakpoint

-- Una asignacion solo cambia al revocarse; quien revoca necesita el mismo permiso
-- (renunciar a un rol propio siempre esta permitido: reduce privilegios).
CREATE FUNCTION "user_roles_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."role_id" IS DISTINCT FROM OLD."role_id" OR NEW."domain" IS DISTINCT FROM OLD."domain"
     OR NEW."granted_by" IS DISTINCT FROM OLD."granted_by" OR NEW."grant_source" IS DISTINCT FROM OLD."grant_source"
     OR NEW."grant_reference" IS DISTINCT FROM OLD."grant_reference"
     OR NEW."granted_at" IS DISTINCT FROM OLD."granted_at" THEN
    RAISE EXCEPTION 'Los datos de una asignacion de rol son inmutables; solo puede revocarse' USING ERRCODE = '42501';
  END IF;
  IF OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'La asignacion ya fue revocada' USING ERRCODE = '42501';
  END IF;
  IF NEW."revoked_at" IS NOT NULL AND NEW."revoked_by" IS DISTINCT FROM NEW."user_id" THEN
    IF NOT public."auth_lock_authority"(NEW."revoked_by", 'roles:grant_' || NEW."domain") THEN
      RAISE EXCEPTION 'Quien revoca el rol no tiene el permiso roles:grant_%', NEW."domain" USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_roles_guard_update" BEFORE UPDATE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION "user_roles_guard_update"();--> statement-breakpoint

-- El historial de asignaciones no se borra (fundamenta el cierre permanente del bootstrap).
CREATE FUNCTION "user_roles_no_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'El historial de asignaciones de rol no se elimina; se revoca' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_roles_no_delete" BEFORE DELETE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION "user_roles_no_delete"();--> statement-breakpoint
CREATE TRIGGER "user_roles_no_truncate" BEFORE TRUNCATE ON "user_roles"
  FOR EACH STATEMENT EXECUTE FUNCTION "user_roles_no_delete"();--> statement-breakpoint

-- Toda concesion o revocacion queda auditada y revoca las sesiones del usuario afectado.
CREATE FUNCTION "user_roles_audit_and_revoke"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  role_key text;
BEGIN
  SELECT r."key" INTO role_key FROM public."roles" r WHERE r."id" = NEW."role_id";
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public."audit_events" ("event_type", "outcome", "actor_user_id", "subject_user_id", "details")
    VALUES ('role.granted', 'success', NEW."granted_by", NEW."user_id",
            jsonb_build_object('role', role_key, 'domain', NEW."domain", 'source', NEW."grant_source",
                               'reference', NEW."grant_reference"));
  ELSE
    INSERT INTO public."audit_events" ("event_type", "outcome", "actor_user_id", "subject_user_id", "details")
    VALUES ('role.revoked', 'success', NEW."revoked_by", NEW."user_id",
            jsonb_build_object('role', role_key, 'domain', NEW."domain"));
  END IF;
  UPDATE public."sessions"
     SET "revoked_at" = now(), "revoked_reason" = 'roles_changed'
   WHERE "user_id" = NEW."user_id" AND "revoked_at" IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_roles_audit_insert" AFTER INSERT ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION "user_roles_audit_and_revoke"();--> statement-breakpoint
CREATE TRIGGER "user_roles_audit_revoke" AFTER UPDATE ON "user_roles"
  FOR EACH ROW WHEN (OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL)
  EXECUTE FUNCTION "user_roles_audit_and_revoke"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 7. auth_tokens: activacion y recuperacion por reclamo en dos partes (ver comentario de la tabla)
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION "auth_tokens_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT u."status" INTO v_status FROM public."users" u WHERE u."id" = NEW."user_id" FOR SHARE;
  IF NEW."authorized_at" IS NOT NULL OR NEW."used_at" IS NOT NULL OR NEW."invalidated_at" IS NOT NULL THEN
    RAISE EXCEPTION 'Una solicitud nace sin autorizar, sin usar y vigente' USING ERRCODE = '42501';
  END IF;
  IF NEW."purpose" = 'invite' AND v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'La invitacion solo aplica a cuentas pendientes' USING ERRCODE = '42501';
  END IF;
  IF NEW."purpose" = 'password_reset' AND v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'La recuperacion solo aplica a cuentas activas' USING ERRCODE = '42501';
  END IF;
  -- Una nueva solicitud reemplaza a la anterior SIN autorizar; una ya autorizada no puede pisarse.
  UPDATE public."auth_tokens"
     SET "invalidated_at" = now()
   WHERE "user_id" = NEW."user_id" AND "purpose" = NEW."purpose"
     AND "used_at" IS NULL AND "invalidated_at" IS NULL AND "authorized_at" IS NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "auth_tokens_guard_insert" BEFORE INSERT ON "auth_tokens"
  FOR EACH ROW EXECUTE FUNCTION "auth_tokens_guard_insert"();--> statement-breakpoint

-- Transiciones permitidas, una por UPDATE: autorizar | consumir | invalidar. Estados terminales.
CREATE FUNCTION "auth_tokens_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_domain text;
  changes integer := 0;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."requested_ip" IS DISTINCT FROM OLD."requested_ip" THEN
    RAISE EXCEPTION 'Los datos de un token son inmutables' USING ERRCODE = '42501';
  END IF;
  IF OLD."used_at" IS NOT NULL OR OLD."invalidated_at" IS NOT NULL THEN
    RAISE EXCEPTION 'El token ya fue usado o invalidado' USING ERRCODE = '42501';
  END IF;

  IF OLD."authorized_at" IS NULL AND NEW."authorized_at" IS NOT NULL THEN changes := changes + 1; END IF;
  IF OLD."authorized_at" IS NOT NULL AND (NEW."authorized_at" IS DISTINCT FROM OLD."authorized_at"
     OR NEW."authorized_by" IS DISTINCT FROM OLD."authorized_by"
     OR NEW."verification_method" IS DISTINCT FROM OLD."verification_method") THEN
    RAISE EXCEPTION 'La autorizacion de un token no se modifica' USING ERRCODE = '42501';
  END IF;
  IF NEW."used_at" IS NOT NULL THEN changes := changes + 1; END IF;
  IF NEW."invalidated_at" IS NOT NULL THEN changes := changes + 1; END IF;
  IF changes <> 1 THEN
    RAISE EXCEPTION 'Cada UPDATE de un token debe ser exactamente una transicion (autorizar, consumir o invalidar)' USING ERRCODE = '42501';
  END IF;

  IF NEW."authorized_at" IS NOT NULL AND OLD."authorized_at" IS NULL THEN
    IF now() >= OLD."expires_at" THEN
      RAISE EXCEPTION 'La solicitud ya caduco' USING ERRCODE = '42501';
    END IF;
    SELECT u."account_domain" INTO v_domain FROM public."users" u WHERE u."id" = NEW."user_id";
    IF NEW."verification_method" = 'ceremony' THEN
      -- Ceremonia de bootstrap/recovery: la ejecuta el propietario del esquema con la persona presente.
      IF NOT public."auth_is_schema_owner"() OR NOT EXISTS (
        SELECT 1 FROM public."user_roles" ur
         WHERE ur."user_id" = NEW."user_id" AND ur."revoked_at" IS NULL AND ur."grant_source" IN ('bootstrap', 'recovery')
      ) THEN
        RAISE EXCEPTION 'La ceremonia solo la autoriza el propietario del esquema para un titular de bootstrap/recovery' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT public."auth_lock_authority"(NEW."authorized_by", 'users:manage_' || v_domain) THEN
      RAISE EXCEPTION 'Quien autoriza no tiene el permiso users:manage_%', v_domain USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."used_at" IS NOT NULL THEN
    IF OLD."authorized_at" IS NULL THEN
      RAISE EXCEPTION 'No se puede consumir un token sin autorizar' USING ERRCODE = '42501';
    END IF;
    IF now() >= OLD."expires_at" THEN
      RAISE EXCEPTION 'El token caduco' USING ERRCODE = '42501';
    END IF;
    NEW."used_txid" := pg_current_xact_id();  -- no falseable: se fija aqui, nunca desde la aplicacion
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "auth_tokens_guard_update" BEFORE UPDATE ON "auth_tokens"
  FOR EACH ROW EXECUTE FUNCTION "auth_tokens_guard_update"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 8. Las guardas criticas se disparan SIEMPRE, incluso con session_replication_role = replica
--    (cambiarlo requiere privilegios elevados). Sigue sin protegerse del propietario.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "audit_events" ENABLE ALWAYS TRIGGER "audit_events_no_update_delete";--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ALWAYS TRIGGER "audit_events_no_truncate";--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ALWAYS TRIGGER "user_roles_enforce_grant";--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ALWAYS TRIGGER "user_roles_guard_update";--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ALWAYS TRIGGER "user_roles_no_delete";--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ALWAYS TRIGGER "user_roles_no_truncate";--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ALWAYS TRIGGER "user_roles_audit_insert";--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ALWAYS TRIGGER "user_roles_audit_revoke";--> statement-breakpoint
ALTER TABLE "role_permissions" ENABLE ALWAYS TRIGGER "role_permissions_guard";--> statement-breakpoint
ALTER TABLE "role_permissions" ENABLE ALWAYS TRIGGER "role_permissions_audit";--> statement-breakpoint
ALTER TABLE "auth_tokens" ENABLE ALWAYS TRIGGER "auth_tokens_guard_insert";--> statement-breakpoint
ALTER TABLE "auth_tokens" ENABLE ALWAYS TRIGGER "auth_tokens_guard_update";--> statement-breakpoint
ALTER TABLE "users" ENABLE ALWAYS TRIGGER "users_enforce_creator";--> statement-breakpoint
ALTER TABLE "users" ENABLE ALWAYS TRIGGER "users_guard_update";--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ALWAYS TRIGGER "sessions_before_insert";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------
-- 9. Funciones: ninguna es ejecutable por PUBLIC (PostgreSQL concede EXECUTE a PUBLIC por defecto).
--    Todas son SECURITY INVOKER con search_path fijo (ninguna eleva privilegios aunque se invoque), pero no hay
--    razon para exponerlas: las de trigger se ejecutan al disparar el trigger (el privilegio EXECUTE se comprueba
--    solo al crearlo) y los ayudantes auth_* las invocan las otras funciones como el rol que opera.
--    Al separar roles (ADR 0003) bastara conceder EXECUTE de los TRES ayudantes auth_* al rol de la API:
--      auth_is_schema_owner(), auth_lock_authority(uuid, text), auth_current_actor()
--    Alcance limitado a las funciones del esquema public (todas nuestras).
-- ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p."oid"::pg_catalog.regprocedure AS sig
      FROM pg_catalog.pg_proc p
     WHERE p."pronamespace" = 'public'::pg_catalog.regnamespace
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END;
$$;--> statement-breakpoint

-- Aserciones finales: si algo queda abierto, la migracion falla y se revierte entera.
DO $$
DECLARE
  open_fns text;
  definer_fns text;
  unpinned_fns text;
BEGIN
  SELECT pg_catalog.string_agg(p."proname", ', ') INTO open_fns
    FROM pg_catalog.pg_proc p
   WHERE p."pronamespace" = 'public'::pg_catalog.regnamespace
     AND EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(coalesce(p."proacl", pg_catalog.acldefault('f', p."proowner"))) a
        WHERE a."grantee" = 0 AND a."privilege_type" = 'EXECUTE');
  IF open_fns IS NOT NULL THEN
    RAISE EXCEPTION 'Funciones ejecutables por PUBLIC: %', open_fns;
  END IF;

  SELECT pg_catalog.string_agg(p."proname", ', ') INTO definer_fns
    FROM pg_catalog.pg_proc p
   WHERE p."pronamespace" = 'public'::pg_catalog.regnamespace AND p."prosecdef";
  IF definer_fns IS NOT NULL THEN
    RAISE EXCEPTION 'No se permiten funciones SECURITY DEFINER sin revision: %', definer_fns;
  END IF;

  SELECT pg_catalog.string_agg(p."proname", ', ') INTO unpinned_fns
    FROM pg_catalog.pg_proc p
   WHERE p."pronamespace" = 'public'::pg_catalog.regnamespace
     AND NOT coalesce(p."proconfig" @> ARRAY['search_path=pg_catalog, pg_temp'], false);
  IF unpinned_fns IS NOT NULL THEN
    RAISE EXCEPTION 'Funciones sin search_path fijo: %', unpinned_fns;
  END IF;
END;
$$;
