-- Registro de RECEPCION de justificantes (Trabajo Social, MVP). PROPUESTA TECNICA, pendiente de ratificacion institucional; NO aplicar
-- en eta15_dev sin autorizacion explicita (ver docs/architecture/justificantes-recepcion.md). Un renglon es un hecho administrativo
-- ("se recibio un justificante"): NO aprueba, no justifica faltas y no toca la asistencia (decision D-10 pendiente). Contenido:
--   1. Tabla `justification_receipts` (parte generada por Drizzle) y, a mano, sus triggers de integridad: folio y hora fijados por la
--      base, fecha dentro de la matricula y no futura, registro inmutable y sin borrado fisico.
--   2. RBAC: el permiso escolar nuevo `justifications:create` solo para trabajo_social (alcance all).
-- Sin DROP, TRUNCATE ni borrado: la marca allow-destructive no es necesaria. Sin datos sensibles: no hay motivo, diagnostico, adjunto
-- ni texto libre. Los privilegios de eta15_api van en tools/db/privileges/0007-justifications-write.*.

CREATE TABLE "justification_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"folio_number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "justification_receipts_folio_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"folio" text NOT NULL,
	"student_id" uuid NOT NULL,
	"school_year_id" uuid NOT NULL,
	"school_date" date NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	CONSTRAINT "jr_folio_key" UNIQUE("folio"),
	CONSTRAINT "jr_folio_number_key" UNIQUE("folio_number"),
	CONSTRAINT "jr_request_key" UNIQUE("received_by","request_id"),
	CONSTRAINT "jr_weekday" CHECK (extract(isodow FROM "justification_receipts"."school_date") BETWEEN 1 AND 5),
	CONSTRAINT "jr_status" CHECK ("justification_receipts"."status" = 'received'),
	CONSTRAINT "jr_hash_format" CHECK ("justification_receipts"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "jr_folio_format" CHECK ("justification_receipts"."folio" ~ '^JR-[0-9]{6,}$')
);
--> statement-breakpoint
ALTER TABLE "justification_receipts" ADD CONSTRAINT "jr_student_enrollment_fkey" FOREIGN KEY ("student_id","school_year_id") REFERENCES "public"."enrollments"("student_id","school_year_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "justification_receipts" ADD CONSTRAINT "jr_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "jr_student_date_idx" ON "justification_receipts" USING btree ("student_id","school_date","id");--> statement-breakpoint
CREATE INDEX "jr_date_idx" ON "justification_receipts" USING btree ("school_date","id");--> statement-breakpoint
CREATE INDEX "jr_received_idx" ON "justification_receipts" USING btree ("received_at","id");
-- =====================================================================================================================
-- Parte 1b (a mano): integridad del registro de RECEPCION de justificantes. Los privilegios de eta15_api NO se conceden aqui: van
-- en la propuesta tools/db/privileges/0007-justifications-write.*. Sin DROP, TRUNCATE ni borrado de datos: la marca
-- allow-destructive no es necesaria.
-- =====================================================================================================================

-- 1. Alta: la base fija folio y hora; la fecha escolar debe caer dentro de la matricula del alumno y no ser futura.
--    (Hoy = America/Mazatlan.) El grupo NO se copia: el grupo historico se deduce de las asignaciones por fecha. Sabado y domingo
--    los rechaza el CHECK jr_weekday. No se lee ni se modifica asistencia alguna.
CREATE FUNCTION "jr_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Mazatlan')::date;
  v_start date;
  v_end date;
BEGIN
  SELECT e."starts_on", e."ends_on" INTO v_start, v_end
    FROM public."enrollments" e
   WHERE e."student_id" = NEW."student_id" AND e."school_year_id" = NEW."school_year_id";
  IF NOT FOUND OR NEW."school_date" < v_start OR (v_end IS NOT NULL AND NEW."school_date" > v_end) THEN
    RAISE EXCEPTION 'La fecha escolar debe caer dentro de la matricula del alumno' USING ERRCODE = '23514', CONSTRAINT = 'jr_enrolled_on_date';
  END IF;
  IF NEW."school_date" > v_today THEN
    RAISE EXCEPTION 'No se registran justificantes de fechas futuras' USING ERRCODE = '23514', CONSTRAINT = 'jr_not_future';
  END IF;
  NEW."folio" := 'JR-' || lpad(NEW."folio_number"::text, 6, '0');
  NEW."received_at" := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jr_guard_insert" BEFORE INSERT ON "justification_receipts"
  FOR EACH ROW EXECUTE FUNCTION "jr_guard_insert"();--> statement-breakpoint

-- 2. Registro inmutable y sin borrado fisico (tambien para el propietario): una recepcion es un hecho historico. Corregir un error
--    de captura es una decision institucional pendiente (no hay edicion, anulacion ni borrado).
CREATE FUNCTION "jr_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'El registro de recepcion de justificantes no se modifica ni se elimina' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jr_no_update" BEFORE UPDATE ON "justification_receipts" FOR EACH ROW EXECUTE FUNCTION "jr_immutable"();--> statement-breakpoint
CREATE TRIGGER "jr_no_delete" BEFORE DELETE ON "justification_receipts" FOR EACH ROW EXECUTE FUNCTION "jr_immutable"();--> statement-breakpoint
CREATE TRIGGER "jr_no_truncate" BEFORE TRUNCATE ON "justification_receipts" FOR EACH STATEMENT EXECUTE FUNCTION "jr_immutable"();--> statement-breakpoint

REVOKE ALL ON FUNCTION "jr_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "jr_immutable"() FROM PUBLIC;--> statement-breakpoint

-- =====================================================================================================================
-- Parte 2: politica RBAC (datos de configuracion; ninguna cuenta, sesion ni justificante existe todavia). PROVISIONAL.
--   * `justifications:create` (escolar, no de autoridad): registrar la RECEPCION de un justificante y buscar al alumno. Solo
--     trabajo_social (alcance all). NO aprueba, rechaza ni modifica faltas: esa decision institucional (D-10) sigue pendiente.
--   * La consulta usa el permiso existente `justifications:read` (trabajo_social y direccion, alcance all). La prefectura conserva
--     su concesion historica de la semilla 0004 (assigned_groups) pero el modulo NO la acepta: exige alcance all.
--   La alta de role_permissions queda auditada por role_permissions_audit: 1 alta = 1 evento.
-- =====================================================================================================================

INSERT INTO "permissions" ("key", "description", "domain", "is_authority") VALUES
  ('justifications:create', 'Registrar la recepcion de justificantes (no los aprueba ni modifica la asistencia)', 'school', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "role_domain", "permission_id", "permission_domain", "scope")
SELECT r."id", r."domain", p."id", p."domain", v."scope"
FROM (VALUES
  ('trabajo_social', 'justifications:create', 'all')
) AS v("role_key", "permission_key", "scope")
JOIN "roles" r ON r."key" = v."role_key"
JOIN "permissions" p ON p."key" = v."permission_key"
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- Verificacion final: si el resultado no es el esperado, la migracion completa se revierte.
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" = 'justifications:create' AND NOT (r."key" = 'trabajo_social' AND rp."scope" = 'all');
  IF v_n <> 0 THEN RAISE EXCEPTION '0013: solo trabajo_social (all) tiene justifications:create'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" = 'justifications:create';
  IF v_n <> 1 THEN RAISE EXCEPTION '0013: se esperaba 1 asignacion de justifications:create'; END IF;
  SELECT count(*) INTO v_n FROM "permissions" p WHERE p."key" = 'justifications:create' AND p."is_authority";
  IF v_n <> 0 THEN RAISE EXCEPTION '0013: justifications:create no es de autoridad'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."key" = 'trabajo_social' AND p."key" IN ('justifications:read', 'justifications:manage') AND rp."scope" = 'all';
  IF v_n <> 2 THEN RAISE EXCEPTION '0013: trabajo_social conserva sus permisos de justificantes anteriores'; END IF;
END
$$;
