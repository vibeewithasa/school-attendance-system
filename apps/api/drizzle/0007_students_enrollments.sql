CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"student_id" uuid NOT NULL,
	"school_year_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_student_year_key" UNIQUE("student_id","school_year_id"),
	CONSTRAINT "enrollments_id_school_year_id_key" UNIQUE("id","school_year_id"),
	CONSTRAINT "enrollments_dates_ordered" CHECK ("enrollments"."ends_on" IS NULL OR "enrollments"."ends_on" >= "enrollments"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "student_group_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"school_year_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sga_dates_ordered" CHECK ("student_group_assignments"."ends_on" IS NULL OR "student_group_assignments"."ends_on" >= "student_group_assignments"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"given_names" text NOT NULL,
	"family_name" text NOT NULL,
	"school_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_school_code_key" UNIQUE("school_code"),
	CONSTRAINT "students_given_names_clean" CHECK ("students"."given_names" = btrim("students"."given_names") AND "students"."given_names" !~ '\s{2,}' AND "students"."given_names" !~ '[[:cntrl:]]' AND char_length("students"."given_names") BETWEEN 1 AND 100),
	CONSTRAINT "students_family_name_clean" CHECK ("students"."family_name" = btrim("students"."family_name") AND "students"."family_name" !~ '\s{2,}' AND "students"."family_name" !~ '[[:cntrl:]]' AND char_length("students"."family_name") BETWEEN 1 AND 100),
	CONSTRAINT "students_school_code_format" CHECK ("students"."school_code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' AND char_length("students"."school_code") BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_school_year_id_fkey" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "student_group_assignments" ADD CONSTRAINT "sga_enrollment_year_fkey" FOREIGN KEY ("enrollment_id","school_year_id") REFERENCES "public"."enrollments"("id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "student_group_assignments" ADD CONSTRAINT "sga_group_year_fkey" FOREIGN KEY ("group_id","school_year_id") REFERENCES "public"."groups"("id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "enrollments_school_year_idx" ON "enrollments" USING btree ("school_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sga_single_open_idx" ON "student_group_assignments" USING btree ("enrollment_id") WHERE "student_group_assignments"."ends_on" IS NULL;--> statement-breakpoint
CREATE INDEX "sga_group_idx" ON "student_group_assignments" USING btree ("group_id","starts_on");--> statement-breakpoint
CREATE INDEX "sga_enrollment_idx" ON "student_group_assignments" USING btree ("enrollment_id","starts_on");--> statement-breakpoint
CREATE INDEX "students_name_idx" ON "students" USING btree ("family_name","given_names","id");
--> statement-breakpoint

-- =====================================================================================================================
-- Parte manual (Drizzle no expresa extensiones, EXCLUDE ni triggers). Revisar antes de aplicar.
-- Convencion de fechas: periodos INCLUSIVOS ('[]'): `ends_on` es el ultimo dia; NULL = abierto.
-- Todas las funciones son SECURITY INVOKER con search_path fijo y sin EXECUTE para PUBLIC (como 0005); los errores de regla de
-- negocio usan SQLSTATE 23514 (check_violation) con CONSTRAINT nombrado; las inmutabilidades usan 42501.
-- =====================================================================================================================

-- 1. btree_gist: necesaria para que un EXCLUDE combine igualdad de uuid con traslape de rangos. Es una extension de confianza
--    ("trusted") de PostgreSQL 13+: la instala el propietario de la base sin ser superusuario. Va en su propio esquema para no
--    mezclar sus ~100 funciones con las de `public` (las auditorias de funciones de 0005 siguen recorriendo solo `public`).
CREATE SCHEMA IF NOT EXISTS "extensions";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA "extensions";--> statement-breakpoint

-- 2. Una matricula no puede tener dos periodos de grupo que se traslapen (inclusivo), ni siquiera por una carrera entre
--    transacciones. Periodos consecutivos (fin 10, inicio 11) SI se permiten; el mismo dia no.
ALTER TABLE "student_group_assignments"
  ADD CONSTRAINT "sga_no_overlap"
  EXCLUDE USING gist ("enrollment_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);--> statement-breakpoint

-- 3. updated_at automatico (funcion de 0001).
CREATE TRIGGER "students_set_updated_at" BEFORE UPDATE ON "students"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "enrollments_set_updated_at" BEFORE UPDATE ON "enrollments"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "sga_set_updated_at" BEFORE UPDATE ON "student_group_assignments"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

-- 4. Sin borrado fisico, tampoco para el propietario: el historial escolar solo se cierra o se desactiva.
CREATE FUNCTION "school_records_no_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Los alumnos, matriculas e historial de grupo no se eliminan; se desactivan o se cierran' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "students_no_delete" BEFORE DELETE ON "students" FOR EACH ROW EXECUTE FUNCTION "school_records_no_delete"();--> statement-breakpoint
CREATE TRIGGER "students_no_truncate" BEFORE TRUNCATE ON "students" FOR EACH STATEMENT EXECUTE FUNCTION "school_records_no_delete"();--> statement-breakpoint
CREATE TRIGGER "enrollments_no_delete" BEFORE DELETE ON "enrollments" FOR EACH ROW EXECUTE FUNCTION "school_records_no_delete"();--> statement-breakpoint
CREATE TRIGGER "enrollments_no_truncate" BEFORE TRUNCATE ON "enrollments" FOR EACH STATEMENT EXECUTE FUNCTION "school_records_no_delete"();--> statement-breakpoint
CREATE TRIGGER "sga_no_delete" BEFORE DELETE ON "student_group_assignments" FOR EACH ROW EXECUTE FUNCTION "school_records_no_delete"();--> statement-breakpoint
CREATE TRIGGER "sga_no_truncate" BEFORE TRUNCATE ON "student_group_assignments" FOR EACH STATEMENT EXECUTE FUNCTION "school_records_no_delete"();--> statement-breakpoint

-- 5. students: la identidad (id) no cambia durante una correccion, y un alumno no se desactiva mientras tenga una matricula SIN
--    baja en un ciclo que no ha terminado (hoy = dia de calendario de la escuela, America/Mazatlan, igual que SCHOOL_TIME_ZONE).
--    El servicio lo comprueba antes para dar un mensaje claro; esto es la ultima defensa de la base.
CREATE FUNCTION "students_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'La identidad de un alumno (id) es inmutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."is_active" AND NOT NEW."is_active" AND EXISTS (
       SELECT 1 FROM public."enrollments" e JOIN public."school_years" y ON y."id" = e."school_year_id"
        WHERE e."student_id" = NEW."id" AND e."ends_on" IS NULL
          AND y."ends_on" >= (now() AT TIME ZONE 'America/Mazatlan')::date) THEN
    RAISE EXCEPTION 'Un alumno con matricula sin baja no se desactiva; de baja la matricula primero' USING ERRCODE = '23514', CONSTRAINT = 'students_deactivate_open_enrollment';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "students_guard_update" BEFORE UPDATE ON "students"
  FOR EACH ROW EXECUTE FUNCTION "students_guard_update"();--> statement-breakpoint

-- 6. enrollments (alta): alumno ACTIVO y fecha de inicio dentro del ciclo. El alumno y el ciclo se bloquean (FOR SHARE) para
--    serializar con una desactivacion o un cambio de fechas del ciclo simultaneos. La base no admite una matricula con baja desde el alta.
CREATE FUNCTION "enrollments_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active boolean;
  v_start date;
  v_end date;
BEGIN
  SELECT s."is_active" INTO v_active FROM public."students" s WHERE s."id" = NEW."student_id" FOR SHARE;
  IF v_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Un alumno inactivo no recibe matriculas nuevas' USING ERRCODE = '23514', CONSTRAINT = 'enrollments_student_active';
  END IF;
  SELECT y."starts_on", y."ends_on" INTO v_start, v_end FROM public."school_years" y WHERE y."id" = NEW."school_year_id" FOR SHARE;
  IF NEW."starts_on" < v_start OR NEW."starts_on" > v_end THEN
    RAISE EXCEPTION 'La matricula debe empezar dentro del ciclo escolar' USING ERRCODE = '23514', CONSTRAINT = 'enrollments_within_year';
  END IF;
  IF NEW."ends_on" IS NOT NULL THEN
    RAISE EXCEPTION 'La matricula nace sin baja' USING ERRCODE = '23514', CONSTRAINT = 'enrollments_born_open';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "enrollments_guard_insert" BEFORE INSERT ON "enrollments"
  FOR EACH ROW EXECUTE FUNCTION "enrollments_guard_insert"();--> statement-breakpoint

-- 7. enrollments (cambio): identidad e inicio inmutables; la unica transicion es la BAJA (ends_on NULL -> fecha) dentro del
--    ciclo y sin dejar periodos de grupo abiertos o posteriores a la baja. Una baja no se reabre ni se modifica.
CREATE FUNCTION "enrollments_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_end date;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."student_id" IS DISTINCT FROM OLD."student_id"
     OR NEW."school_year_id" IS DISTINCT FROM OLD."school_year_id" OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'El alumno, el ciclo y el inicio de una matricula son inmutables' USING ERRCODE = '42501';
  END IF;
  IF NEW."ends_on" IS DISTINCT FROM OLD."ends_on" THEN
    IF OLD."ends_on" IS NOT NULL OR NEW."ends_on" IS NULL THEN
      RAISE EXCEPTION 'Una baja de matricula no se modifica ni se reabre' USING ERRCODE = '42501';
    END IF;
    SELECT y."ends_on" INTO v_end FROM public."school_years" y WHERE y."id" = NEW."school_year_id";
    IF NEW."ends_on" < NEW."starts_on" OR NEW."ends_on" > v_end THEN
      RAISE EXCEPTION 'La baja debe caer dentro del periodo de la matricula y del ciclo' USING ERRCODE = '23514', CONSTRAINT = 'enrollments_end_within_year';
    END IF;
    IF EXISTS (SELECT 1 FROM public."student_group_assignments" a
                WHERE a."enrollment_id" = NEW."id" AND (a."ends_on" IS NULL OR a."ends_on" > NEW."ends_on")) THEN
      RAISE EXCEPTION 'Cierre los periodos de grupo antes de la baja (ninguno puede quedar abierto o posterior)' USING ERRCODE = '23514', CONSTRAINT = 'enrollments_end_after_assignments';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "enrollments_guard_update" BEFORE UPDATE ON "enrollments"
  FOR EACH ROW EXECUTE FUNCTION "enrollments_guard_update"();--> statement-breakpoint

-- 8. student_group_assignments (alta): el periodo debe caer dentro de la matricula (inicio de la matricula .. baja o fin del
--    ciclo). La matricula y el ciclo se bloquean (FOR SHARE) para serializar con una baja o un cambio de fechas simultaneos. Que el grupo y la matricula sean del
--    MISMO ciclo lo imponen las dos FK compuestas.
CREATE FUNCTION "sga_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_start date;
  v_end date;
BEGIN
  SELECT e."starts_on", coalesce(e."ends_on", y."ends_on") INTO v_start, v_end
    FROM public."enrollments" e JOIN public."school_years" y ON y."id" = e."school_year_id"
   WHERE e."id" = NEW."enrollment_id" FOR SHARE OF e, y;
  IF NEW."starts_on" < v_start OR NEW."starts_on" > v_end OR (NEW."ends_on" IS NOT NULL AND NEW."ends_on" > v_end) THEN
    RAISE EXCEPTION 'El periodo de grupo debe caer dentro de la matricula' USING ERRCODE = '23514', CONSTRAINT = 'sga_within_enrollment';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sga_guard_insert" BEFORE INSERT ON "student_group_assignments"
  FOR EACH ROW EXECUTE FUNCTION "sga_guard_insert"();--> statement-breakpoint

-- 9. student_group_assignments (cambio): solo se CIERRA (ends_on NULL -> fecha) dentro de la matricula; el resto es inmutable.
CREATE FUNCTION "sga_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_end date;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."enrollment_id" IS DISTINCT FROM OLD."enrollment_id"
     OR NEW."school_year_id" IS DISTINCT FROM OLD."school_year_id" OR NEW."group_id" IS DISTINCT FROM OLD."group_id"
     OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'El historial de grupo es inmutable; solo se cierra' USING ERRCODE = '42501';
  END IF;
  IF NEW."ends_on" IS DISTINCT FROM OLD."ends_on" THEN
    IF OLD."ends_on" IS NOT NULL OR NEW."ends_on" IS NULL THEN
      RAISE EXCEPTION 'Un periodo de grupo cerrado no se modifica ni se reabre' USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(e."ends_on", y."ends_on") INTO v_end
      FROM public."enrollments" e JOIN public."school_years" y ON y."id" = e."school_year_id" WHERE e."id" = NEW."enrollment_id";
    IF NEW."ends_on" > v_end THEN
      RAISE EXCEPTION 'El cierre del periodo de grupo excede la matricula' USING ERRCODE = '23514', CONSTRAINT = 'sga_within_enrollment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sga_guard_update" BEFORE UPDATE ON "student_group_assignments"
  FOR EACH ROW EXECUTE FUNCTION "sga_guard_update"();--> statement-breakpoint

-- 10. school_years: las fechas de un ciclo con matriculas o periodos de grupo no pueden dejarlos fuera del ciclo (el catalogo
--     puede corregir fechas de un ciclo vigente; sin esto una correccion invalidaria el historial). Solo se dispara si cambian las
--     fechas. Las matriculas del ciclo se bloquean (FOR SHARE) para serializar con bajas y traslados simultaneos.
CREATE FUNCTION "school_years_guard_dates"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public."enrollments" e WHERE e."school_year_id" = NEW."id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."enrollments" e
              WHERE e."school_year_id" = NEW."id"
                AND (e."starts_on" < NEW."starts_on" OR e."starts_on" > NEW."ends_on" OR e."ends_on" > NEW."ends_on"))
     OR EXISTS (SELECT 1 FROM public."student_group_assignments" a
                 WHERE a."school_year_id" = NEW."id"
                   AND (a."starts_on" < NEW."starts_on" OR a."starts_on" > NEW."ends_on" OR a."ends_on" > NEW."ends_on")) THEN
    RAISE EXCEPTION 'Las nuevas fechas del ciclo dejarian matriculas o periodos de grupo fuera del ciclo' USING ERRCODE = '23514', CONSTRAINT = 'school_years_enrollments_within';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "school_years_guard_dates" BEFORE UPDATE OF "starts_on", "ends_on" ON "school_years"
  FOR EACH ROW WHEN (OLD."starts_on" IS DISTINCT FROM NEW."starts_on" OR OLD."ends_on" IS DISTINCT FROM NEW."ends_on")
  EXECUTE FUNCTION "school_years_guard_dates"();--> statement-breakpoint

-- 11. Las funciones nuevas no son ejecutables por PUBLIC (un trigger no necesita EXECUTE del usuario que dispara la operacion).
REVOKE ALL ON FUNCTION "school_records_no_delete"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "students_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "enrollments_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "enrollments_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "sga_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "sga_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "school_years_guard_dates"() FROM PUBLIC;
