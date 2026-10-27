-- eta15:allow-destructive
-- Asignaciones de grupos a prefectura (alcance `assigned_groups`) y su politica RBAC. PROPUESTA TECNICA del MVP, pendiente de
-- ratificacion institucional; NO aplicar en eta15_dev sin autorizacion (ver docs/architecture/modelo-asignaciones-prefectura.md).
--
-- Contenido:
--   1. Tabla `prefect_group_assignments` (parte generada por Drizzle) y, a mano, el EXCLUDE anti-traslape y los triggers de integridad.
--   2. RBAC (datos de configuracion, auditados por role_permissions_audit): dos permisos escolares nuevos
--      (`prefect_assignments:manage` solo Direccion; `prefect_assignments:read` Direccion `all` y prefectura `own`) y el retiro de
--      `students:read` (expediente) a prefectura, que solo necesita `students:read_basic` con alcance `assigned_groups`.
-- La marca de la primera linea se justifica UNICAMENTE por el DELETE FROM role_permissions de la parte 2 (una baja de asignacion
-- concreta, reversible con una migracion nueva); no hay DROP, TRUNCATE ni borrado de roles, permisos, cuentas o historial.
-- Convencion de fechas: periodos INCLUSIVOS; "hoy" es el dia de calendario de la escuela (America/Mazatlan).

CREATE TABLE "prefect_group_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"school_year_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pga_dates_ordered" CHECK ("prefect_group_assignments"."ends_on" IS NULL OR "prefect_group_assignments"."ends_on" >= "prefect_group_assignments"."starts_on"),
	CONSTRAINT "pga_revocation_consistent" CHECK (("prefect_group_assignments"."revoked_at" IS NULL AND "prefect_group_assignments"."revoked_by" IS NULL AND "prefect_group_assignments"."revocation_reason" IS NULL) OR ("prefect_group_assignments"."revoked_at" IS NOT NULL AND "prefect_group_assignments"."revoked_by" IS NOT NULL AND "prefect_group_assignments"."revocation_reason" IS NOT NULL)),
	CONSTRAINT "pga_reason_clean" CHECK ("prefect_group_assignments"."revocation_reason" IS NULL OR ("prefect_group_assignments"."revocation_reason" = btrim("prefect_group_assignments"."revocation_reason") AND "prefect_group_assignments"."revocation_reason" !~ '[[:cntrl:]]' AND char_length("prefect_group_assignments"."revocation_reason") BETWEEN 3 AND 200))
);
--> statement-breakpoint
ALTER TABLE "prefect_group_assignments" ADD CONSTRAINT "pga_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "prefect_group_assignments" ADD CONSTRAINT "pga_school_year_fkey" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "prefect_group_assignments" ADD CONSTRAINT "pga_group_year_fkey" FOREIGN KEY ("group_id","school_year_id") REFERENCES "public"."groups"("id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "prefect_group_assignments" ADD CONSTRAINT "pga_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "prefect_group_assignments" ADD CONSTRAINT "pga_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "pga_user_idx" ON "prefect_group_assignments" USING btree ("user_id","starts_on");--> statement-breakpoint
CREATE INDEX "pga_group_idx" ON "prefect_group_assignments" USING btree ("group_id","starts_on");--> statement-breakpoint

-- =====================================================================================================================
-- Parte manual (Drizzle no expresa EXCLUDE ni triggers). Todas las funciones son SECURITY INVOKER con search_path fijo y sin
-- EXECUTE para PUBLIC (como 0005 y 0007): usan los privilegios de quien opera (eta15_api); por eso exigen la propuesta 0004.
-- Errores de regla de negocio: SQLSTATE 23514 con CONSTRAINT nombrado; inmutabilidades: 42501.
-- =====================================================================================================================

-- 1. Para el mismo par prefecta-grupo no hay periodos traslapados (inclusivo) NI duplicados, ni siquiera por una carrera entre
--    transacciones. Periodos consecutivos (fin 10, inicio 11) SI se permiten. Las asignaciones REVOCADAS quedan fuera del
--    indice (son historia: no bloquean una asignacion nueva, pero la fila revocada jamas recupera acceso, ver el trigger de cambio).
--    Un grupo SI puede tener varias prefectas al mismo tiempo (cobertura): la restriccion es por par, no por grupo.
ALTER TABLE "prefect_group_assignments"
  ADD CONSTRAINT "pga_no_overlap"
  EXCLUDE USING gist ("user_id" WITH =, "group_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&)
  WHERE ("revoked_at" IS NULL);--> statement-breakpoint

CREATE TRIGGER "pga_set_updated_at" BEFORE UPDATE ON "prefect_group_assignments"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

-- 2. Sin borrado fisico, tampoco para el propietario.
CREATE FUNCTION "prefect_assignments_no_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Las asignaciones de prefectura no se eliminan; se cierran o se revocan' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "pga_no_delete" BEFORE DELETE ON "prefect_group_assignments" FOR EACH ROW EXECUTE FUNCTION "prefect_assignments_no_delete"();--> statement-breakpoint
CREATE TRIGGER "pga_no_truncate" BEFORE TRUNCATE ON "prefect_group_assignments" FOR EACH STATEMENT EXECUTE FUNCTION "prefect_assignments_no_delete"();--> statement-breakpoint

-- 3. Alta: solo para una cuenta escolar ACTIVA con el rol `prefectura` vigente, en un grupo ACTIVO del ciclo, con periodo dentro del
--    ciclo y sin retroactividad (el acceso no se concede hacia atras: nadie reescribe quien atendio un grupo antes de hoy). La
--    cuenta, su rol, el grupo y el ciclo se bloquean (FOR SHARE) para serializar con desactivaciones, revocaciones de rol, cambios
--    de grupo y de fechas del ciclo simultaneos. Una fila nace sin revocacion.
CREATE FUNCTION "pga_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Mazatlan')::date;
  v_status text;
  v_domain text;
  v_group_active boolean;
  v_start date;
  v_end date;
BEGIN
  SELECT u."status", u."account_domain" INTO v_status, v_domain FROM public."users" u WHERE u."id" = NEW."user_id" FOR SHARE;
  IF v_status IS DISTINCT FROM 'active' OR v_domain IS DISTINCT FROM 'school' THEN
    RAISE EXCEPTION 'Solo una cuenta escolar activa puede recibir grupos' USING ERRCODE = '23514', CONSTRAINT = 'pga_user_active';
  END IF;
  PERFORM 1 FROM public."user_roles" ur JOIN public."roles" r ON r."id" = ur."role_id"
   WHERE ur."user_id" = NEW."user_id" AND ur."revoked_at" IS NULL AND r."key" = 'prefectura' FOR SHARE OF ur;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuenta no tiene el rol de prefectura vigente' USING ERRCODE = '23514', CONSTRAINT = 'pga_user_role';
  END IF;
  SELECT g."is_active" INTO v_group_active FROM public."groups" g WHERE g."id" = NEW."group_id" FOR SHARE;
  IF v_group_active IS FALSE THEN
    RAISE EXCEPTION 'El grupo esta inactivo' USING ERRCODE = '23514', CONSTRAINT = 'pga_group_active';
  END IF;
  SELECT y."starts_on", y."ends_on" INTO v_start, v_end FROM public."school_years" y WHERE y."id" = NEW."school_year_id" FOR SHARE;
  IF NEW."starts_on" < v_today THEN
    RAISE EXCEPTION 'Una asignacion no puede empezar antes de hoy' USING ERRCODE = '23514', CONSTRAINT = 'pga_no_backdate';
  END IF;
  IF NEW."starts_on" < v_start OR NEW."starts_on" > v_end OR (NEW."ends_on" IS NOT NULL AND NEW."ends_on" > v_end) THEN
    RAISE EXCEPTION 'La asignacion debe caer dentro del ciclo escolar' USING ERRCODE = '23514', CONSTRAINT = 'pga_within_year';
  END IF;
  IF NEW."revoked_at" IS NOT NULL OR NEW."revoked_by" IS NOT NULL OR NEW."revocation_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'Una asignacion nace sin revocacion' USING ERRCODE = '23514', CONSTRAINT = 'pga_born_active';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "pga_guard_insert" BEFORE INSERT ON "prefect_group_assignments"
  FOR EACH ROW EXECUTE FUNCTION "pga_guard_insert"();--> statement-breakpoint

-- 4. Cambio: la identidad es inmutable. Solo hay dos transiciones, ambas hacia adelante:
--    a) CIERRE programado: `ends_on` NULL -> fecha, o ACORTAR una fecha futura; nunca antes de hoy, nunca extender ni reabrir
--       (para ampliar se crea otra asignacion), dentro del ciclo.
--    b) REVOCACION inmediata: se escribe `revoked_by` y `revocation_reason` y el TRIGGER fija `revoked_at = now()` (el cliente no
--       elige la hora). Una fila revocada es completamente inmutable: jamas recupera acceso. No se revoca una asignacion que ya
--       termino (no hay acceso que quitar).
CREATE FUNCTION "pga_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Mazatlan')::date;
  v_end date;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."school_year_id" IS DISTINCT FROM OLD."school_year_id" OR NEW."group_id" IS DISTINCT FROM OLD."group_id"
     OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on" OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'La identidad y el inicio de una asignacion son inmutables' USING ERRCODE = '42501';
  END IF;
  IF OLD."revoked_at" IS NOT NULL THEN
    IF NEW."ends_on" IS DISTINCT FROM OLD."ends_on" OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by" OR NEW."revocation_reason" IS DISTINCT FROM OLD."revocation_reason" THEN
      RAISE EXCEPTION 'Una asignacion revocada es historia inmutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."revoked_by" IS NOT NULL THEN
    IF NEW."ends_on" IS DISTINCT FROM OLD."ends_on" THEN
      RAISE EXCEPTION 'Revocar no cambia las fechas' USING ERRCODE = '42501';
    END IF;
    IF OLD."ends_on" IS NOT NULL AND OLD."ends_on" < v_today THEN
      RAISE EXCEPTION 'La asignacion ya termino: no hay acceso que revocar' USING ERRCODE = '23514', CONSTRAINT = 'pga_already_ended';
    END IF;
    NEW."revoked_at" := now();
    RETURN NEW;
  END IF;
  IF NEW."revoked_at" IS NOT NULL OR NEW."revocation_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'La revocacion se registra completa por el servidor' USING ERRCODE = '42501';
  END IF;
  IF NEW."ends_on" IS DISTINCT FROM OLD."ends_on" THEN
    IF NEW."ends_on" IS NULL OR (OLD."ends_on" IS NOT NULL AND NEW."ends_on" > OLD."ends_on") THEN
      RAISE EXCEPTION 'Un periodo no se reabre ni se extiende; se crea otra asignacion' USING ERRCODE = '42501';
    END IF;
    IF OLD."ends_on" IS NOT NULL AND OLD."ends_on" < v_today THEN
      RAISE EXCEPTION 'Un periodo terminado es historia inmutable' USING ERRCODE = '42501';
    END IF;
    IF NEW."ends_on" < GREATEST(OLD."starts_on", v_today) THEN
      RAISE EXCEPTION 'El cierre no puede ser anterior a hoy ni al inicio' USING ERRCODE = '23514', CONSTRAINT = 'pga_end_not_retroactive';
    END IF;
    SELECT y."ends_on" INTO v_end FROM public."school_years" y WHERE y."id" = NEW."school_year_id";
    IF NEW."ends_on" > v_end THEN
      RAISE EXCEPTION 'El cierre excede el ciclo escolar' USING ERRCODE = '23514', CONSTRAINT = 'pga_within_year';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "pga_guard_update" BEFORE UPDATE ON "prefect_group_assignments"
  FOR EACH ROW EXECUTE FUNCTION "pga_guard_update"();--> statement-breakpoint

-- 5. Las fechas de un ciclo no pueden dejar asignaciones de prefectura fuera del ciclo (misma idea que school_years_guard_dates de
--    0007); solo se dispara si cambian las fechas y bloquea las asignaciones del ciclo (FOR SHARE) para serializar con
--    revocaciones y cierres simultaneos.
CREATE FUNCTION "school_years_guard_prefect_dates"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public."prefect_group_assignments" a WHERE a."school_year_id" = NEW."id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."prefect_group_assignments" a
              WHERE a."school_year_id" = NEW."id"
                AND (a."starts_on" < NEW."starts_on" OR a."starts_on" > NEW."ends_on" OR a."ends_on" > NEW."ends_on")) THEN
    RAISE EXCEPTION 'Las nuevas fechas del ciclo dejarian asignaciones de prefectura fuera del ciclo' USING ERRCODE = '23514', CONSTRAINT = 'school_years_prefect_within';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "school_years_guard_prefect_dates" BEFORE UPDATE OF "starts_on", "ends_on" ON "school_years"
  FOR EACH ROW WHEN (OLD."starts_on" IS DISTINCT FROM NEW."starts_on" OR OLD."ends_on" IS DISTINCT FROM NEW."ends_on")
  EXECUTE FUNCTION "school_years_guard_prefect_dates"();--> statement-breakpoint

REVOKE ALL ON FUNCTION "prefect_assignments_no_delete"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "pga_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "pga_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "school_years_guard_prefect_dates"() FROM PUBLIC;--> statement-breakpoint

-- =====================================================================================================================
-- Parte 2: politica RBAC (datos de configuracion; ninguna cuenta, sesion ni asignacion existe todavia).
--   * `prefect_assignments:manage` (escolar, no de autoridad): solo Direccion (alcance all). Administrar quien atiende que grupo
--     decide quien ve datos de menores, por eso exige las mismas garantias que Direccion (MFA, sesiones cortas).
--   * `prefect_assignments:read`: Direccion `all` (consulta el historial) y prefectura `own` (consulta SUS grupos vigentes).
--   * Prefectura pierde `students:read` (expediente: historial de matriculas y de grupos, sellos de tiempo): para pasar lista le
--     basta `students:read_basic` con alcance `assigned_groups`, que conserva. Minimizacion de datos de menores.
--   Cada alta/baja de role_permissions queda auditada por role_permissions_audit: 3 altas + 1 baja = 4 eventos.
-- =====================================================================================================================

INSERT INTO "permissions" ("key", "description", "domain", "is_authority") VALUES
  ('prefect_assignments:manage', 'Asignar, cerrar y revocar grupos de prefectura (dominio escolar)', 'school', false),
  ('prefect_assignments:read', 'Consultar asignaciones de grupos a prefectura (propias o todas)', 'school', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "role_domain", "permission_id", "permission_domain", "scope")
SELECT r."id", r."domain", p."id", p."domain", v."scope"
FROM (VALUES
  ('direccion', 'prefect_assignments:manage', 'all'),
  ('direccion', 'prefect_assignments:read', 'all'),
  ('prefectura', 'prefect_assignments:read', 'own')
) AS v("role_key", "permission_key", "scope")
JOIN "roles" r ON r."key" = v."role_key"
JOIN "permissions" p ON p."key" = v."permission_key"
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" = 'prefectura' AND p."key" = 'students:read';--> statement-breakpoint

-- Verificacion final: si el resultado no es el esperado, la migracion completa se revierte.
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" LIKE 'prefect_assignments:%'
     AND NOT ((r."key" = 'direccion' AND rp."scope" = 'all')
              OR (r."key" = 'prefectura' AND p."key" = 'prefect_assignments:read' AND rp."scope" = 'own'));
  IF v_n <> 0 THEN RAISE EXCEPTION '0009: solo direccion administra y consulta todas las asignaciones; prefectura solo las propias'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" LIKE 'prefect_assignments:%';
  IF v_n <> 3 THEN RAISE EXCEPTION '0009: se esperaban 3 asignaciones de los permisos de prefectura'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'prefectura' AND p."key" = 'students:read';
  IF v_n <> 0 THEN RAISE EXCEPTION '0009: prefectura no conserva el expediente (students:read)'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'prefectura' AND p."key" = 'students:read_basic' AND rp."scope" = 'assigned_groups';
  IF v_n <> 1 THEN RAISE EXCEPTION '0009: prefectura conserva students:read_basic con alcance assigned_groups'; END IF;
  SELECT count(*) INTO v_n FROM "permissions" WHERE "key" IN ('prefect_assignments:manage', 'prefect_assignments:read') AND "is_authority" = false AND "domain" = 'school';
  IF v_n <> 2 THEN RAISE EXCEPTION '0009: los permisos nuevos son escolares y no de autoridad'; END IF;
END
$$;
