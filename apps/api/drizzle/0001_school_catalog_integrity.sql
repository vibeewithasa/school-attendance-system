-- Reglas que Drizzle no expresa: ciclos sin traslape y updated_at automatico.
-- Escrita a mano; revisar antes de aplicar (ver docs/architecture/modelo-catalogo-escolar.md).

-- Dos ciclos escolares no pueden traslaparse. Las fechas son inclusivas: el rango '[]' incluye
-- starts_on y ends_on, asi que un ciclo que empieza el mismo dia en que otro termina SI se traslapa.
-- Usa el operador && nativo de rangos con gist; no requiere extensiones.
ALTER TABLE "school_years"
  ADD CONSTRAINT "school_years_no_overlap"
  EXCLUDE USING gist (daterange("starts_on", "ends_on", '[]') WITH &&);--> statement-breakpoint

-- updated_at lo fija el servidor en cada UPDATE real (base para sincronizacion por delta).
-- SECURITY INVOKER (por defecto) y search_path fijo: solo usa now() de pg_catalog.
CREATE FUNCTION "set_updated_at"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW."updated_at" = now();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "school_years_set_updated_at"
  BEFORE UPDATE ON "school_years"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

CREATE TRIGGER "groups_set_updated_at"
  BEFORE UPDATE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
