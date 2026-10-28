-- Retencion de datos de red del canal movil (PROTOTIPO de sandbox; ADR 0005 propuesto, NO aplicar en eta15_dev sin autorizacion).
--   1. Indice parcial del limite COMPARTIDO de solicitudes de vinculacion por IP y ventana (solo filas con IP).
--   2. La IP de una solicitud y la IP y el agente de una sesion solo pueden ANONIMIZARSE (pasar a NULL), y solo lo puede hacer
--      el propietario en la limpieza de retencion (eta15_api no tiene UPDATE sobre esas columnas). Cualquier otro cambio de
--      identidad sigue prohibido. Sin DROP, DELETE ni TRUNCATE.
CREATE INDEX "mdr_ip_created_idx" ON "mobile_device_requests" USING btree ("requested_ip","created_at") WHERE "mobile_device_requests"."requested_ip" IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "mdr_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."key_thumbprint" IS DISTINCT FROM OLD."key_thumbprint"
     OR NEW."public_key_jwk" IS DISTINCT FROM OLD."public_key_jwk" OR NEW."pairing_code_hash" IS DISTINCT FROM OLD."pairing_code_hash"
     OR NEW."device_label" IS DISTINCT FROM OLD."device_label" OR NEW."platform" IS DISTINCT FROM OLD."platform"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR (NEW."requested_ip" IS DISTINCT FROM OLD."requested_ip" AND NEW."requested_ip" IS NOT NULL) THEN
    RAISE EXCEPTION 'La identidad de una solicitud de vinculacion es inmutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" IN ('activated', 'rejected', 'cancelled') THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
       OR NEW."claim_failures" IS DISTINCT FROM OLD."claim_failures" OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
       OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at" OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
       OR NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at" OR NEW."closed_by" IS DISTINCT FROM OLD."closed_by"
       OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at" THEN
      RAISE EXCEPTION 'Una solicitud terminada es historia inmutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- La persona titular, una vez fijada, no cambia.
  IF OLD."user_id" IS NOT NULL AND NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'La persona titular de la solicitud no cambia' USING ERRCODE = '42501';
  END IF;

  IF NEW."status" = OLD."status" THEN
    IF OLD."status" = 'pending' THEN
      -- Unico cambio posible sin avanzar: contar un intento fallido de reclamo.
      IF NEW."claim_failures" IS DISTINCT FROM OLD."claim_failures" + 1 OR NEW."user_id" IS NOT NULL OR NEW."claimed_at" IS NOT NULL
         OR NEW."approved_by" IS NOT NULL OR NEW."approved_at" IS NOT NULL THEN
        RAISE EXCEPTION 'En pendiente solo se cuenta un intento fallido de reclamo' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."claim_failures" IS DISTINCT FROM OLD."claim_failures" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
       OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by" OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
       OR NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at" THEN
      RAISE EXCEPTION 'La solicitud no admite ese cambio sin una transicion de estado' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" IN ('rejected', 'cancelled') THEN
    -- Cierre: desde cualquier estado abierto; no cambia el resto de datos.
    IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
       OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at" OR NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at"
       OR NEW."activated_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Cerrar una solicitud no modifica sus demas datos' USING ERRCODE = '42501';
    END IF;
    NEW."closed_at" := now();
    RETURN NEW;
  END IF;

  IF OLD."status" = 'pending' AND NEW."status" = 'claimed' THEN
    IF NEW."user_id" IS NULL OR NEW."approved_by" IS NOT NULL OR NEW."approved_at" IS NOT NULL OR NEW."activated_at" IS NOT NULL
       OR NEW."claim_failures" IS DISTINCT FROM OLD."claim_failures" THEN
      RAISE EXCEPTION 'El reclamo solo fija a la persona titular' USING ERRCODE = '42501';
    END IF;
    IF OLD."expires_at" <= now() THEN
      RAISE EXCEPTION 'La solicitud vencio' USING ERRCODE = '23514', CONSTRAINT = 'mdr_not_expired';
    END IF;
    IF NOT public."mobile_user_eligible"(NEW."user_id") THEN
      RAISE EXCEPTION 'La cuenta no puede vincular dispositivos' USING ERRCODE = '23514', CONSTRAINT = 'mdr_user_eligible';
    END IF;
    NEW."claimed_at" := now();
    RETURN NEW;
  END IF;

  IF OLD."status" = 'claimed' AND NEW."status" = 'approved' THEN
    IF NEW."approved_by" IS NULL OR NEW."activated_at" IS NOT NULL OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
       OR NEW."claim_failures" IS DISTINCT FROM OLD."claim_failures" THEN
      RAISE EXCEPTION 'La aprobacion solo registra a quien aprueba' USING ERRCODE = '42501';
    END IF;
    IF OLD."expires_at" <= now() THEN
      RAISE EXCEPTION 'La solicitud vencio' USING ERRCODE = '23514', CONSTRAINT = 'mdr_not_expired';
    END IF;
    IF NEW."approved_by" = OLD."user_id" THEN
      RAISE EXCEPTION 'Nadie aprueba su propia vinculacion' USING ERRCODE = '23514', CONSTRAINT = 'mdr_not_self_approved';
    END IF;
    IF NOT public."mobile_actor_can_manage"(NEW."approved_by") THEN
      RAISE EXCEPTION 'Quien aprueba no tiene autoridad sobre dispositivos moviles' USING ERRCODE = '23514', CONSTRAINT = 'mdr_approver_authority';
    END IF;
    IF NOT public."mobile_user_eligible"(OLD."user_id") THEN
      RAISE EXCEPTION 'La cuenta ya no puede vincular dispositivos' USING ERRCODE = '23514', CONSTRAINT = 'mdr_user_eligible';
    END IF;
    NEW."approved_at" := now();
    RETURN NEW;
  END IF;

  IF OLD."status" = 'approved' AND NEW."status" = 'activated' THEN
    IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
       OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at" THEN
      RAISE EXCEPTION 'La activacion no modifica la aprobacion' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."mobile_devices" d WHERE d."request_id" = OLD."id") THEN
      RAISE EXCEPTION 'No se activa una solicitud sin dispositivo registrado' USING ERRCODE = '23514', CONSTRAINT = 'mdr_device_registered';
    END IF;
    NEW."activated_at" := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transicion de solicitud no permitida' USING ERRCODE = '23514', CONSTRAINT = 'mdr_transition';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "ms_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  dev record;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."device_id" IS DISTINCT FROM OLD."device_id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR NEW."absolute_expires_at" IS DISTINCT FROM OLD."absolute_expires_at"
     OR (NEW."ip" IS DISTINCT FROM OLD."ip" AND NEW."ip" IS NOT NULL)
     OR (NEW."user_agent" IS DISTINCT FROM OLD."user_agent" AND NEW."user_agent" IS NOT NULL) THEN
    RAISE EXCEPTION 'La identidad de una sesion movil es inmutable' USING ERRCODE = '42501';
  END IF;
  -- Anonimizacion por retencion (solo el propietario: la API no tiene UPDATE sobre ip ni user_agent): las credenciales, las
  -- caducidades y la revocacion de la sesion no cambian. Tambien cubre sesiones vencidas sin revocar.
  IF (NEW."ip" IS DISTINCT FROM OLD."ip" OR NEW."user_agent" IS DISTINCT FROM OLD."user_agent")
     AND NEW."access_hash" IS NOT DISTINCT FROM OLD."access_hash" AND NEW."refresh_hash" IS NOT DISTINCT FROM OLD."refresh_hash"
     AND NEW."previous_refresh_hash" IS NOT DISTINCT FROM OLD."previous_refresh_hash" AND NEW."refresh_count" IS NOT DISTINCT FROM OLD."refresh_count"
     AND NEW."access_expires_at" IS NOT DISTINCT FROM OLD."access_expires_at" AND NEW."idle_expires_at" IS NOT DISTINCT FROM OLD."idle_expires_at"
     AND NEW."last_refreshed_at" IS NOT DISTINCT FROM OLD."last_refreshed_at" AND NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
     AND NEW."revoked_reason" IS NOT DISTINCT FROM OLD."revoked_reason" AND NEW."revoked_by" IS NOT DISTINCT FROM OLD."revoked_by" THEN
    RETURN NEW;
  END IF;
  IF OLD."revoked_at" IS NOT NULL THEN
    IF NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
       OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by" OR NEW."access_hash" IS DISTINCT FROM OLD."access_hash"
       OR NEW."refresh_hash" IS DISTINCT FROM OLD."refresh_hash" OR NEW."refresh_count" IS DISTINCT FROM OLD."refresh_count"
       OR NEW."previous_refresh_hash" IS DISTINCT FROM OLD."previous_refresh_hash" THEN
      RAISE EXCEPTION 'Una sesion movil revocada es historia inmutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."revoked_at" IS NOT NULL OR NEW."revoked_reason" IS NOT NULL THEN
    -- Revocacion: no cambia credenciales ni caducidades.
    IF NEW."access_hash" IS DISTINCT FROM OLD."access_hash" OR NEW."refresh_hash" IS DISTINCT FROM OLD."refresh_hash"
       OR NEW."previous_refresh_hash" IS DISTINCT FROM OLD."previous_refresh_hash" OR NEW."refresh_count" IS DISTINCT FROM OLD."refresh_count" THEN
      RAISE EXCEPTION 'Revocar no cambia las credenciales' USING ERRCODE = '42501';
    END IF;
    NEW."revoked_at" := now();
    RETURN NEW;
  END IF;
  -- Rotacion de la renovacion.
  IF NEW."refresh_count" IS DISTINCT FROM OLD."refresh_count" + 1 OR NEW."refresh_hash" IS NOT DISTINCT FROM OLD."refresh_hash"
     OR NEW."access_hash" IS NOT DISTINCT FROM OLD."access_hash" OR NEW."previous_refresh_hash" IS DISTINCT FROM OLD."refresh_hash" THEN
    RAISE EXCEPTION 'La renovacion rota las dos credenciales y conserva la anterior' USING ERRCODE = '23514', CONSTRAINT = 'ms_rotation';
  END IF;
  SELECT d."status", d."registered_at" INTO dev FROM public."mobile_devices" d WHERE d."id" = OLD."device_id" FOR SHARE;
  IF NOT FOUND OR dev."status" <> 'active' THEN
    RAISE EXCEPTION 'El dispositivo no esta activo' USING ERRCODE = '23514', CONSTRAINT = 'ms_device_active';
  END IF;
  IF NOT public."mobile_user_eligible"(OLD."user_id", dev."registered_at") THEN
    RAISE EXCEPTION 'La cuenta no puede renovar sesiones moviles' USING ERRCODE = '23514', CONSTRAINT = 'ms_user_eligible';
  END IF;
  NEW."last_refreshed_at" := now();
  RETURN NEW;
END;
$$;
