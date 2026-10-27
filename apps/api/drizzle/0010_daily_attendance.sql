-- eta15:allow-destructive
-- Asistencia diaria (una lista por grupo y fecha) y cierre de la lectura global de asistencia de trabajo social. PROPUESTA TECNICA
-- del MVP, pendiente de ratificacion institucional; NO aplicar en eta15_dev sin autorizacion (ver
-- docs/architecture/diseno-asistencia-diaria.md).
--
-- Contenido:
--   1. Tablas `attendance_days`, `attendance_records` y `attendance_events` (parte generada por Drizzle) y, a mano, los triggers de
--      integridad: fecha no futura, grupo activo, ciclo, transiciones de estado, padron congelado, matricula y grupo vigentes ese dia,
--      finalizacion sin pendientes y historial solo-agregar. Sin borrado fisico, tampoco para el propietario.
--   2. RBAC (datos de configuracion, auditados por role_permissions_audit): retiro de `attendance:read` con alcance `all` a
--      trabajo_social (la semilla 0004 se lo concedio; la politica es cerrada por defecto hasta que la institucion defina su
--      funcion). No se crean permisos nuevos ni se toca `justifications:*`.
-- La marca de la primera linea se justifica UNICAMENTE por el DELETE FROM role_permissions de la parte 2 (una baja de asignacion
-- concreta, reversible con una migracion nueva); no hay DROP, TRUNCATE ni borrado de roles, permisos, cuentas o historial.
-- Convencion de fechas: America/Mazatlan; solo lunes a viernes. La fecha de captura ordinaria (= hoy) la impone el SERVIDOR; la
-- base garantiza fecha laborable, no futura y dentro del ciclo.

CREATE TABLE "attendance_days" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"school_year_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"finalized_by" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_days_group_date_key" UNIQUE("group_id","attendance_date"),
	CONSTRAINT "att_days_id_school_year_id_key" UNIQUE("id","school_year_id"),
	CONSTRAINT "att_days_weekday" CHECK (extract(isodow FROM "attendance_days"."attendance_date") BETWEEN 1 AND 5),
	CONSTRAINT "att_days_status" CHECK ("attendance_days"."status" IN ('draft', 'finalized')),
	CONSTRAINT "att_days_revision_positive" CHECK ("attendance_days"."revision" >= 1),
	CONSTRAINT "att_days_finalized_consistent" CHECK (("attendance_days"."status" = 'draft' AND "attendance_days"."finalized_by" IS NULL AND "attendance_days"."finalized_at" IS NULL) OR ("attendance_days"."status" = 'finalized' AND "attendance_days"."finalized_by" IS NOT NULL AND "attendance_days"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "attendance_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"attendance_day_id" uuid NOT NULL,
	"record_id" uuid,
	"event_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"request_id" uuid,
	"payload_hash" text,
	"old_status" text,
	"new_status" text,
	"revision_after" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_events_type" CHECK ("attendance_events"."event_type" IN ('day_opened', 'mark_changed', 'day_finalized')),
	CONSTRAINT "att_events_shape" CHECK (("attendance_events"."event_type" = 'mark_changed' AND "attendance_events"."record_id" IS NOT NULL AND "attendance_events"."request_id" IS NOT NULL AND "attendance_events"."payload_hash" IS NOT NULL AND "attendance_events"."new_status" IN ('present', 'absent') AND ("attendance_events"."old_status" IS NULL OR "attendance_events"."old_status" IN ('present', 'absent')))
        OR ("attendance_events"."event_type" IN ('day_opened', 'day_finalized') AND "attendance_events"."record_id" IS NULL AND "attendance_events"."request_id" IS NULL AND "attendance_events"."payload_hash" IS NULL AND "attendance_events"."old_status" IS NULL AND "attendance_events"."new_status" IS NULL)),
	CONSTRAINT "att_events_hash_format" CHECK ("attendance_events"."payload_hash" IS NULL OR "attendance_events"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "att_events_revision_positive" CHECK ("attendance_events"."revision_after" >= 1)
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"attendance_day_id" uuid NOT NULL,
	"school_year_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"group_assignment_id" uuid NOT NULL,
	"status" text,
	"marked_by" uuid,
	"marked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_records_day_enrollment_key" UNIQUE("attendance_day_id","enrollment_id"),
	CONSTRAINT "att_records_id_day_key" UNIQUE("id","attendance_day_id"),
	CONSTRAINT "att_records_status" CHECK ("attendance_records"."status" IS NULL OR "attendance_records"."status" IN ('present', 'absent')),
	CONSTRAINT "att_records_marked_consistent" CHECK (("attendance_records"."status" IS NULL AND "attendance_records"."marked_by" IS NULL AND "attendance_records"."marked_at" IS NULL) OR ("attendance_records"."status" IS NOT NULL AND "attendance_records"."marked_by" IS NOT NULL AND "attendance_records"."marked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "att_days_school_year_fkey" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "att_days_group_year_fkey" FOREIGN KEY ("group_id","school_year_id") REFERENCES "public"."groups"("id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "att_days_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "att_days_finalized_by_fkey" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "att_events_day_fkey" FOREIGN KEY ("attendance_day_id") REFERENCES "public"."attendance_days"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "att_events_record_day_fkey" FOREIGN KEY ("record_id","attendance_day_id") REFERENCES "public"."attendance_records"("id","attendance_day_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "att_events_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "att_records_day_year_fkey" FOREIGN KEY ("attendance_day_id","school_year_id") REFERENCES "public"."attendance_days"("id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "att_records_enrollment_year_fkey" FOREIGN KEY ("enrollment_id","school_year_id") REFERENCES "public"."enrollments"("id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "att_records_group_assignment_fkey" FOREIGN KEY ("group_assignment_id") REFERENCES "public"."student_group_assignments"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "att_records_marked_by_fkey" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "att_days_date_idx" ON "attendance_days" USING btree ("attendance_date","group_id");--> statement-breakpoint
CREATE INDEX "att_days_year_idx" ON "attendance_days" USING btree ("school_year_id","attendance_date");--> statement-breakpoint
CREATE UNIQUE INDEX "att_events_once_idx" ON "attendance_events" USING btree ("attendance_day_id","event_type") WHERE "attendance_events"."event_type" IN ('day_opened', 'day_finalized');--> statement-breakpoint
CREATE UNIQUE INDEX "att_events_request_record_idx" ON "attendance_events" USING btree ("attendance_day_id","request_id","record_id") WHERE "attendance_events"."event_type" = 'mark_changed';--> statement-breakpoint
CREATE INDEX "att_events_day_idx" ON "attendance_events" USING btree ("attendance_day_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "att_events_record_idx" ON "attendance_events" USING btree ("record_id","occurred_at");--> statement-breakpoint
CREATE INDEX "att_records_enrollment_idx" ON "attendance_records" USING btree ("enrollment_id","attendance_day_id");--> statement-breakpoint
CREATE INDEX "att_records_assignment_idx" ON "attendance_records" USING btree ("group_assignment_id");--> statement-breakpoint

-- =====================================================================================================================
-- Parte manual (Drizzle no expresa triggers). Todas las funciones son SECURITY INVOKER con search_path fijo y sin EXECUTE para
-- PUBLIC (como 0005, 0007 y 0009): usan los privilegios de quien opera (eta15_api); por eso exigen la propuesta 0005.
-- Errores de regla de negocio: SQLSTATE 23514 con CONSTRAINT nombrado; inmutabilidades: 42501.
-- =====================================================================================================================

CREATE TRIGGER "att_days_set_updated_at" BEFORE UPDATE ON "attendance_days"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "att_records_set_updated_at" BEFORE UPDATE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

-- 1. Sin borrado fisico en ninguna de las tres tablas (tampoco TRUNCATE), ni siquiera para el propietario.
CREATE FUNCTION "attendance_no_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'La asistencia no se elimina: las listas y su historial se conservan' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "att_days_no_delete" BEFORE DELETE ON "attendance_days" FOR EACH ROW EXECUTE FUNCTION "attendance_no_delete"();--> statement-breakpoint
CREATE TRIGGER "att_days_no_truncate" BEFORE TRUNCATE ON "attendance_days" FOR EACH STATEMENT EXECUTE FUNCTION "attendance_no_delete"();--> statement-breakpoint
CREATE TRIGGER "att_records_no_delete" BEFORE DELETE ON "attendance_records" FOR EACH ROW EXECUTE FUNCTION "attendance_no_delete"();--> statement-breakpoint
CREATE TRIGGER "att_records_no_truncate" BEFORE TRUNCATE ON "attendance_records" FOR EACH STATEMENT EXECUTE FUNCTION "attendance_no_delete"();--> statement-breakpoint
CREATE TRIGGER "att_events_no_delete" BEFORE DELETE ON "attendance_events" FOR EACH ROW EXECUTE FUNCTION "attendance_no_delete"();--> statement-breakpoint
CREATE TRIGGER "att_events_no_truncate" BEFORE TRUNCATE ON "attendance_events" FOR EACH STATEMENT EXECUTE FUNCTION "attendance_no_delete"();--> statement-breakpoint

-- 2. El historial solo se agrega: ningun UPDATE.
CREATE FUNCTION "attendance_events_no_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'El historial de asistencia solo se agrega; no se modifica' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "att_events_no_update" BEFORE UPDATE ON "attendance_events" FOR EACH ROW EXECUTE FUNCTION "attendance_events_no_update"();--> statement-breakpoint

-- 3. Alta de una lista: grupo ACTIVO, fecha dentro del ciclo y NO futura (hoy en America/Mazatlan), nace en borrador con revision 1.
--    (Que la fecha sea exactamente "hoy" es regla del servicio para la captura ordinaria: la base no cierra la puerta a futuras
--    altas de dias anteriores, que son una decision institucional pendiente.) El grupo y el ciclo se bloquean (FOR SHARE) para
--    serializar con desactivaciones y cambios de fechas simultaneos. Sabado y domingo los rechaza el CHECK att_days_weekday.
CREATE FUNCTION "att_days_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Mazatlan')::date;
  v_active boolean;
  v_start date;
  v_end date;
BEGIN
  SELECT g."is_active" INTO v_active FROM public."groups" g WHERE g."id" = NEW."group_id" FOR SHARE;
  IF v_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El grupo esta inactivo o no existe' USING ERRCODE = '23514', CONSTRAINT = 'att_days_group_active';
  END IF;
  SELECT y."starts_on", y."ends_on" INTO v_start, v_end FROM public."school_years" y WHERE y."id" = NEW."school_year_id" FOR SHARE;
  IF NEW."attendance_date" < v_start OR NEW."attendance_date" > v_end THEN
    RAISE EXCEPTION 'La fecha debe caer dentro del ciclo escolar' USING ERRCODE = '23514', CONSTRAINT = 'att_days_within_year';
  END IF;
  IF NEW."attendance_date" > v_today THEN
    RAISE EXCEPTION 'No se abren listas de fechas futuras' USING ERRCODE = '23514', CONSTRAINT = 'att_days_not_future';
  END IF;
  IF NEW."status" IS DISTINCT FROM 'draft' OR NEW."revision" IS DISTINCT FROM 1
     OR NEW."finalized_by" IS NOT NULL OR NEW."finalized_at" IS NOT NULL THEN
    RAISE EXCEPTION 'Una lista nace en borrador con revision 1' USING ERRCODE = '23514', CONSTRAINT = 'att_days_born_draft';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "att_days_guard_insert" BEFORE INSERT ON "attendance_days"
  FOR EACH ROW EXECUTE FUNCTION "att_days_guard_insert"();--> statement-breakpoint

-- 4. Cambio de una lista: la identidad es inmutable; una lista FINALIZADA es historia inmutable. En borrador solo hay dos
--    movimientos: avanzar la revision de uno en uno (guardado con cambios) o FINALIZAR (borrador -> finalizada, que ademas avanza la
--    revision). Finalizar exige al menos un renglon y NINGUNO pendiente; el trigger fija finalized_at = now() (el cliente no elige la
--    hora). Corre con el tuple de la lista bloqueado: un guardado de renglones simultaneo (que mantiene la lista en FOR SHARE) se
--    termina antes o espera, por lo que dos finalizaciones o un guardado y una finalizacion nunca producen resultados distintos.
CREATE FUNCTION "att_days_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."school_year_id" IS DISTINCT FROM OLD."school_year_id"
     OR NEW."group_id" IS DISTINCT FROM OLD."group_id" OR NEW."attendance_date" IS DISTINCT FROM OLD."attendance_date"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'La identidad de una lista de asistencia es inmutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" = 'finalized' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."revision" IS DISTINCT FROM OLD."revision"
       OR NEW."finalized_by" IS DISTINCT FROM OLD."finalized_by" OR NEW."finalized_at" IS DISTINCT FROM OLD."finalized_at" THEN
      RAISE EXCEPTION 'Una lista finalizada es historia inmutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."revision" IS DISTINCT FROM OLD."revision" + 1 THEN
    RAISE EXCEPTION 'La revision solo avanza de uno en uno' USING ERRCODE = '23514', CONSTRAINT = 'att_days_revision_step';
  END IF;
  IF NEW."status" = 'finalized' THEN
    IF NOT EXISTS (SELECT 1 FROM public."attendance_records" r WHERE r."attendance_day_id" = OLD."id") THEN
      RAISE EXCEPTION 'No se finaliza una lista sin alumnos' USING ERRCODE = '23514', CONSTRAINT = 'att_days_not_empty';
    END IF;
    IF EXISTS (SELECT 1 FROM public."attendance_records" r WHERE r."attendance_day_id" = OLD."id" AND r."status" IS NULL) THEN
      RAISE EXCEPTION 'No se finaliza una lista con alumnos pendientes' USING ERRCODE = '23514', CONSTRAINT = 'att_days_no_pending';
    END IF;
    NEW."finalized_at" := now();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "att_days_guard_update" BEFORE UPDATE ON "attendance_days"
  FOR EACH ROW EXECUTE FUNCTION "att_days_guard_update"();--> statement-breakpoint

-- 5. Alta de un renglon (PADRON CONGELADO): solo en la MISMA transaccion que creo la lista (created_at = now()) y mientras es
--    borrador; despues no se agregan alumnos. El alumno debe estar activo y tener, en la fecha de la lista, matricula vigente y una
--    asignacion de grupo vigente EN EL GRUPO DE LA LISTA (el grupo sale de la lista, no del cliente). La matricula y la asignacion
--    se bloquean (FOR SHARE) para serializar con bajas y traslados simultaneos. El renglon nace pendiente (sin estado).
CREATE FUNCTION "att_records_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  d record;
BEGIN
  SELECT x."status", x."attendance_date", x."group_id", x."school_year_id", x."created_at" INTO d
    FROM public."attendance_days" x WHERE x."id" = NEW."attendance_day_id" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La lista no existe' USING ERRCODE = '23503';
  END IF;
  IF d."status" <> 'draft' OR d."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'El padron de una lista queda congelado al abrirla' USING ERRCODE = '23514', CONSTRAINT = 'att_records_roster_frozen';
  END IF;
  IF NEW."status" IS NOT NULL OR NEW."marked_by" IS NOT NULL OR NEW."marked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'Un renglon nace pendiente' USING ERRCODE = '23514', CONSTRAINT = 'att_records_born_pending';
  END IF;
  PERFORM 1 FROM public."enrollments" e JOIN public."students" s ON s."id" = e."student_id"
   WHERE e."id" = NEW."enrollment_id" AND s."is_active" AND e."starts_on" <= d."attendance_date"
     AND (e."ends_on" IS NULL OR e."ends_on" >= d."attendance_date")
   FOR SHARE OF e;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El alumno no tiene matricula vigente ese dia' USING ERRCODE = '23514', CONSTRAINT = 'att_records_enrollment_current';
  END IF;
  PERFORM 1 FROM public."student_group_assignments" a
   WHERE a."id" = NEW."group_assignment_id" AND a."enrollment_id" = NEW."enrollment_id" AND a."group_id" = d."group_id"
     AND a."school_year_id" = d."school_year_id" AND a."starts_on" <= d."attendance_date"
     AND (a."ends_on" IS NULL OR a."ends_on" >= d."attendance_date")
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El alumno no pertenece a este grupo en esa fecha' USING ERRCODE = '23514', CONSTRAINT = 'att_records_in_group';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "att_records_guard_insert" BEFORE INSERT ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION "att_records_guard_insert"();--> statement-breakpoint

-- 6. Cambio de un renglon: la identidad (lista, matricula, asignacion) es inmutable. Solo cambia el estado (pendiente -> presente o
--    ausente, o entre ambos; nunca de vuelta a pendiente) y solo mientras la lista es borrador. La lista se bloquea en FOR SHARE:
--    una finalizacion simultanea espera a este cambio (y viceversa). El trigger fija marked_at = now() en cada cambio de estado.
CREATE FUNCTION "att_records_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."attendance_day_id" IS DISTINCT FROM OLD."attendance_day_id"
     OR NEW."school_year_id" IS DISTINCT FROM OLD."school_year_id" OR NEW."enrollment_id" IS DISTINCT FROM OLD."enrollment_id"
     OR NEW."group_assignment_id" IS DISTINCT FROM OLD."group_assignment_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'La identidad de un renglon de asistencia es inmutable' USING ERRCODE = '42501';
  END IF;
  SELECT d."status" INTO v_status FROM public."attendance_days" d WHERE d."id" = OLD."attendance_day_id" FOR SHARE;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Una lista finalizada no se modifica' USING ERRCODE = '42501';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" IS NULL THEN
      RAISE EXCEPTION 'Un renglon marcado no vuelve a pendiente' USING ERRCODE = '23514', CONSTRAINT = 'att_records_no_unmark';
    END IF;
    IF NEW."marked_by" IS NULL THEN
      RAISE EXCEPTION 'Marcar exige registrar quien lo hizo' USING ERRCODE = '23514', CONSTRAINT = 'att_records_marked_consistent';
    END IF;
    NEW."marked_at" := now();
  ELSIF NEW."marked_by" IS DISTINCT FROM OLD."marked_by" OR NEW."marked_at" IS DISTINCT FROM OLD."marked_at" THEN
    RAISE EXCEPTION 'La marca solo cambia junto con el estado' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "att_records_guard_update" BEFORE UPDATE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION "att_records_guard_update"();--> statement-breakpoint

-- 7. Las fechas de un ciclo no pueden dejar listas de asistencia fuera del ciclo (misma idea que school_years_guard_dates de 0007 y
--    school_years_guard_prefect_dates de 0009); solo se dispara si cambian las fechas y bloquea las listas del ciclo (FOR SHARE).
CREATE FUNCTION "school_years_guard_attendance_dates"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public."attendance_days" d WHERE d."school_year_id" = NEW."id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."attendance_days" d
              WHERE d."school_year_id" = NEW."id" AND (d."attendance_date" < NEW."starts_on" OR d."attendance_date" > NEW."ends_on")) THEN
    RAISE EXCEPTION 'Las nuevas fechas del ciclo dejarian listas de asistencia fuera del ciclo' USING ERRCODE = '23514', CONSTRAINT = 'school_years_attendance_within';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "school_years_guard_attendance_dates" BEFORE UPDATE OF "starts_on", "ends_on" ON "school_years"
  FOR EACH ROW WHEN (OLD."starts_on" IS DISTINCT FROM NEW."starts_on" OR OLD."ends_on" IS DISTINCT FROM NEW."ends_on")
  EXECUTE FUNCTION "school_years_guard_attendance_dates"();--> statement-breakpoint

REVOKE ALL ON FUNCTION "attendance_no_delete"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "attendance_events_no_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "att_days_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "att_days_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "att_records_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "att_records_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "school_years_guard_attendance_dates"() FROM PUBLIC;--> statement-breakpoint

-- =====================================================================================================================
-- Parte 2: politica RBAC (datos de configuracion; ninguna cuenta, sesion ni asistencia existe todavia).
--   * trabajo_social pierde `attendance:read` con alcance `all` (semilla 0004). La asistencia por grupo es de la prefectura que
--     atiende el grupo (`assigned_groups`) y de Direccion (`all`, supervision); trabajo social recibira un permiso ESPECIFICO para
--     sus justificantes cuando la institucion defina esa funcion. Conserva `justifications:read` y `justifications:manage`.
--   * No se crean permisos nuevos: attendance:capture (solo prefectura, assigned_groups), attendance:read, attendance:correct
--     (solo Direccion; la correccion formal esta bloqueada hasta que la institucion defina quien corrige, cuando y por que).
--   La baja de role_permissions queda auditada por role_permissions_audit: 1 baja = 1 evento.
-- =====================================================================================================================

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" = 'trabajo_social' AND p."key" = 'attendance:read';--> statement-breakpoint

-- Verificacion final: si el resultado no es el esperado, la migracion completa se revierte.
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" LIKE 'attendance:%'
     AND NOT ((r."key" = 'prefectura' AND p."key" IN ('attendance:capture', 'attendance:read') AND rp."scope" = 'assigned_groups')
              OR (r."key" = 'direccion' AND p."key" IN ('attendance:read', 'attendance:correct') AND rp."scope" = 'all'));
  IF v_n <> 0 THEN RAISE EXCEPTION '0010: solo prefectura (assigned_groups) y direccion (all) tienen permisos de asistencia'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" LIKE 'attendance:%';
  IF v_n <> 4 THEN RAISE EXCEPTION '0010: se esperaban 4 asignaciones de permisos de asistencia'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'trabajo_social' AND p."key" = 'attendance:read';
  IF v_n <> 0 THEN RAISE EXCEPTION '0010: trabajo_social no conserva la lectura de asistencia'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'trabajo_social' AND p."key" IN ('justifications:read', 'justifications:manage') AND rp."scope" = 'all';
  IF v_n <> 2 THEN RAISE EXCEPTION '0010: trabajo_social conserva sus permisos de justificantes'; END IF;
END
$$;