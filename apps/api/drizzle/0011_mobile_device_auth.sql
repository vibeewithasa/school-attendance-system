-- Autenticacion movil AISLADA de dispositivos Android (PROTOTIPO de sandbox). PROPUESTA TECNICA, pendiente de ratificacion
-- institucional (ADR 0005, NO aceptado); NO aplicar en eta15_dev sin autorizacion explicita. Contenido:
--   1. Tablas `mobile_device_requests`, `mobile_devices` y `mobile_sessions` (parte generada por Drizzle) y, a mano, los triggers de
--      integridad: transiciones de la solicitud, dispositivo solo desde una solicitud aprobada, sesion solo de un dispositivo activo de
--      una cuenta elegible, una sesion activa por dispositivo y deteccion de reuso de la renovacion. Sin borrado fisico.
--   1b. Estado EFIMERO de seguridad compartido entre instancias: `mobile_proof_jtis` (pruebas DPoP ya aceptadas, UNIQUE por clave y
--      hash del jti: el rechazo de una repeticion es atomico entre procesos y sobrevive a un reinicio) y `mobile_nonces` (desafios de
--      un solo uso ligados a una clave). Sin DELETE para la API: solo el propietario retira filas vencidas hace mas de una hora.
--   2. RBAC: dos permisos escolares nuevos (`mobile_devices:manage` para Direccion y `mobile_devices:enroll`, alcance own, para
--      prefectura). No se modifica ninguna migracion anterior ni se concede nada a otros roles.
-- Sin DROP, TRUNCATE ni DELETE: la marca allow-destructive no es necesaria. No almacena claves privadas, tokens ni JWT en claro.
-- Los privilegios de eta15_api NO se conceden aqui: van en la propuesta tools/db/privileges/0006-mobile-auth-write.*.
CREATE TABLE "mobile_device_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"key_thumbprint" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"device_label" text NOT NULL,
	"platform" text DEFAULT 'android' NOT NULL,
	"pairing_code_hash" "bytea" NOT NULL,
	"claim_failures" smallint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requested_ip" "inet",
	"claimed_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mdr_thumbprint_format" CHECK ("mobile_device_requests"."key_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "mdr_jwk_valid" CHECK (jsonb_typeof("mobile_device_requests"."public_key_jwk") = 'object' AND ("mobile_device_requests"."public_key_jwk" ->> 'kty') = 'EC' AND ("mobile_device_requests"."public_key_jwk" ->> 'crv') = 'P-256'
      AND ("mobile_device_requests"."public_key_jwk" ->> 'x') ~ '^[A-Za-z0-9_-]{43}$' AND ("mobile_device_requests"."public_key_jwk" ->> 'y') ~ '^[A-Za-z0-9_-]{43}$' AND ("mobile_device_requests"."public_key_jwk" -> 'd') IS NULL),
	CONSTRAINT "mdr_label_length" CHECK (char_length(btrim("mobile_device_requests"."device_label")) BETWEEN 1 AND 60),
	CONSTRAINT "mdr_platform_values" CHECK ("mobile_device_requests"."platform" IN ('android')),
	CONSTRAINT "mdr_code_hash_length" CHECK (octet_length("mobile_device_requests"."pairing_code_hash") = 32),
	CONSTRAINT "mdr_claim_failures_range" CHECK ("mobile_device_requests"."claim_failures" BETWEEN 0 AND 10),
	CONSTRAINT "mdr_status_values" CHECK ("mobile_device_requests"."status" IN ('pending', 'claimed', 'approved', 'activated', 'rejected', 'cancelled')),
	CONSTRAINT "mdr_expiry_window" CHECK ("mobile_device_requests"."expires_at" > "mobile_device_requests"."created_at" AND "mobile_device_requests"."expires_at" <= "mobile_device_requests"."created_at" + interval '30 minutes'),
	CONSTRAINT "mdr_claim_consistent" CHECK (("mobile_device_requests"."status" <> 'pending' OR "mobile_device_requests"."user_id" IS NULL) AND ("mobile_device_requests"."status" NOT IN ('claimed', 'approved', 'activated') OR ("mobile_device_requests"."user_id" IS NOT NULL AND "mobile_device_requests"."claimed_at" IS NOT NULL))),
	CONSTRAINT "mdr_approval_consistent" CHECK (("mobile_device_requests"."approved_by" IS NULL) = ("mobile_device_requests"."approved_at" IS NULL) AND ("mobile_device_requests"."status" NOT IN ('approved', 'activated') OR "mobile_device_requests"."approved_by" IS NOT NULL) AND ("mobile_device_requests"."approved_by" IS NULL OR "mobile_device_requests"."approved_by" <> "mobile_device_requests"."user_id")),
	CONSTRAINT "mdr_activation_consistent" CHECK (("mobile_device_requests"."status" = 'activated') = ("mobile_device_requests"."activated_at" IS NOT NULL)),
	CONSTRAINT "mdr_closed_consistent" CHECK (("mobile_device_requests"."status" IN ('rejected', 'cancelled')) = ("mobile_device_requests"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mobile_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"key_thumbprint" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"label" text NOT NULL,
	"request_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "md_thumbprint_key" UNIQUE("key_thumbprint"),
	CONSTRAINT "md_request_key" UNIQUE("request_id"),
	CONSTRAINT "md_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "md_thumbprint_format" CHECK ("mobile_devices"."key_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "md_jwk_valid" CHECK (jsonb_typeof("mobile_devices"."public_key_jwk") = 'object' AND ("mobile_devices"."public_key_jwk" ->> 'kty') = 'EC' AND ("mobile_devices"."public_key_jwk" ->> 'crv') = 'P-256'
      AND ("mobile_devices"."public_key_jwk" ->> 'x') ~ '^[A-Za-z0-9_-]{43}$' AND ("mobile_devices"."public_key_jwk" ->> 'y') ~ '^[A-Za-z0-9_-]{43}$' AND ("mobile_devices"."public_key_jwk" -> 'd') IS NULL),
	CONSTRAINT "md_label_length" CHECK (char_length(btrim("mobile_devices"."label")) BETWEEN 1 AND 60),
	CONSTRAINT "md_status_values" CHECK ("mobile_devices"."status" IN ('active', 'revoked')),
	CONSTRAINT "md_revoke_reason_values" CHECK ("mobile_devices"."revoke_reason" IS NULL OR "mobile_devices"."revoke_reason" IN ('titular', 'authority', 'lost', 'replaced')),
	CONSTRAINT "md_revocation_consistent" CHECK (("mobile_devices"."status" = 'revoked') = ("mobile_devices"."revoked_at" IS NOT NULL) AND ("mobile_devices"."revoked_at" IS NULL) = ("mobile_devices"."revoke_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "mobile_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_hash" "bytea" NOT NULL,
	"refresh_hash" "bytea" NOT NULL,
	"previous_refresh_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"refresh_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" uuid,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "ms_access_hash_key" UNIQUE("access_hash"),
	CONSTRAINT "ms_refresh_hash_key" UNIQUE("refresh_hash"),
	CONSTRAINT "ms_access_hash_length" CHECK (octet_length("mobile_sessions"."access_hash") = 32),
	CONSTRAINT "ms_refresh_hash_length" CHECK (octet_length("mobile_sessions"."refresh_hash") = 32),
	CONSTRAINT "ms_previous_hash_length" CHECK ("mobile_sessions"."previous_refresh_hash" IS NULL OR octet_length("mobile_sessions"."previous_refresh_hash") = 32),
	CONSTRAINT "ms_expiry_order" CHECK ("mobile_sessions"."absolute_expires_at" > "mobile_sessions"."created_at" AND "mobile_sessions"."idle_expires_at" <= "mobile_sessions"."absolute_expires_at" AND "mobile_sessions"."access_expires_at" <= "mobile_sessions"."absolute_expires_at"),
	CONSTRAINT "ms_refresh_count_nonneg" CHECK ("mobile_sessions"."refresh_count" >= 0),
	CONSTRAINT "ms_revoked_reason_values" CHECK ("mobile_sessions"."revoked_reason" IS NULL OR "mobile_sessions"."revoked_reason" IN ('logout', 'device_revoked', 'replaced', 'account_inactive', 'role_changed', 'refresh_reuse', 'authority')),
	CONSTRAINT "ms_revocation_consistent" CHECK (("mobile_sessions"."revoked_at" IS NULL) = ("mobile_sessions"."revoked_reason" IS NULL)),
	CONSTRAINT "ms_user_agent_length" CHECK ("mobile_sessions"."user_agent" IS NULL OR char_length("mobile_sessions"."user_agent") <= 256)
);
--> statement-breakpoint
CREATE TABLE "mobile_nonces" (
	"nonce_hash" "bytea" PRIMARY KEY NOT NULL,
	"key_thumbprint" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "mn_thumbprint_format" CHECK ("mobile_nonces"."key_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "mn_nonce_hash_length" CHECK (octet_length("mobile_nonces"."nonce_hash") = 32),
	CONSTRAINT "mn_expiry_window" CHECK ("mobile_nonces"."expires_at" > "mobile_nonces"."issued_at" AND "mobile_nonces"."expires_at" <= "mobile_nonces"."issued_at" + interval '15 minutes'),
	CONSTRAINT "mn_consumed_order" CHECK ("mobile_nonces"."consumed_at" IS NULL OR "mobile_nonces"."consumed_at" >= "mobile_nonces"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "mobile_proof_jtis" (
	"key_thumbprint" text NOT NULL,
	"jti_hash" "bytea" NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mpj_pkey" PRIMARY KEY("key_thumbprint","jti_hash"),
	CONSTRAINT "mpj_thumbprint_format" CHECK ("mobile_proof_jtis"."key_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "mpj_jti_hash_length" CHECK (octet_length("mobile_proof_jtis"."jti_hash") = 32),
	CONSTRAINT "mpj_expiry_window" CHECK ("mobile_proof_jtis"."expires_at" > "mobile_proof_jtis"."seen_at" AND "mobile_proof_jtis"."expires_at" <= "mobile_proof_jtis"."seen_at" + interval '15 minutes')
);
--> statement-breakpoint
ALTER TABLE "mobile_device_requests" ADD CONSTRAINT "mdr_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_device_requests" ADD CONSTRAINT "mdr_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_device_requests" ADD CONSTRAINT "mdr_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "md_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "md_request_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."mobile_device_requests"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "md_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "md_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "ms_device_user_fkey" FOREIGN KEY ("device_id","user_id") REFERENCES "public"."mobile_devices"("id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "ms_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "mdr_open_thumbprint_key" ON "mobile_device_requests" USING btree ("key_thumbprint") WHERE "mobile_device_requests"."status" IN ('pending', 'claimed', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "mdr_open_user_key" ON "mobile_device_requests" USING btree ("user_id") WHERE "mobile_device_requests"."status" IN ('claimed', 'approved');--> statement-breakpoint
CREATE INDEX "mdr_status_expires_idx" ON "mobile_device_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "md_user_active_idx" ON "mobile_devices" USING btree ("user_id") WHERE "mobile_devices"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ms_one_active_per_device" ON "mobile_sessions" USING btree ("device_id") WHERE "mobile_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ms_user_active_idx" ON "mobile_sessions" USING btree ("user_id") WHERE "mobile_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mn_key_expires_idx" ON "mobile_nonces" USING btree ("key_thumbprint","expires_at");--> statement-breakpoint
CREATE INDEX "mn_expires_idx" ON "mobile_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mpj_key_expires_idx" ON "mobile_proof_jtis" USING btree ("key_thumbprint","expires_at");--> statement-breakpoint
CREATE INDEX "mpj_expires_idx" ON "mobile_proof_jtis" USING btree ("expires_at");
--> statement-breakpoint

-- =====================================================================================================================
-- Triggers de integridad de la autenticacion movil (PROTOTIPO de sandbox; propuesta tecnica, NO aprobada por la institucion).
--   * Las tres tablas no admiten borrado fisico (ni TRUNCATE), tampoco para el propietario.
--   * Una solicitud solo avanza por transiciones permitidas; la persona titular, la autoridad y la huella quedan ligadas.
--   * Un dispositivo solo existe a partir de una solicitud APROBADA y vigente; solo pasa de activo a revocado.
--   * Una sesion solo existe para un dispositivo ACTIVO de una cuenta elegible; una sola activa por dispositivo.
-- Todas las funciones son SECURITY INVOKER con search_path fijo y sin EXECUTE para PUBLIC; usan los privilegios de eta15_api, por
-- eso las tablas exigen la propuesta de privilegios 0006 (tools/db/privileges). SQLSTATE: 23514 con CONSTRAINT nombrado para reglas de
-- negocio y 42501 para inmutabilidades.
-- =====================================================================================================================

CREATE TRIGGER "mdr_set_updated_at" BEFORE UPDATE ON "mobile_device_requests"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

-- 1. Cuenta elegible para el canal movil: escolar, activa, sin bloqueo, con el rol `prefectura` vigente (y, si `p_not_before` no es
--    nulo, concedido ANTES de ese instante: si el rol se revoco y se volvio a conceder, un dispositivo anterior no revive) y SIN ningun
--    rol vigente que exija MFA (el canal movil no tiene segundo factor: fallar cerrado).
CREATE FUNCTION "mobile_user_eligible"(p_user uuid, p_not_before timestamp with time zone DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."users" u
     WHERE u."id" = p_user AND u."status" = 'active' AND u."account_domain" = 'school'
       AND (u."locked_until" IS NULL OR u."locked_until" <= now())
       AND EXISTS (SELECT 1 FROM public."user_roles" ur JOIN public."roles" r ON r."id" = ur."role_id"
                    WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL AND r."key" = 'prefectura'
                      AND (p_not_before IS NULL OR ur."granted_at" <= p_not_before))
       AND NOT EXISTS (SELECT 1 FROM public."user_roles" ur JOIN public."roles" r ON r."id" = ur."role_id"
                        WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL AND r."requires_mfa")
  );
$$;--> statement-breakpoint

-- 2. Persona con autoridad para aprobar, rechazar y revocar vinculaciones: cuenta escolar activa con un rol vigente que conceda
--    `mobile_devices:manage`.
CREATE FUNCTION "mobile_actor_can_manage"(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."users" u
      JOIN public."user_roles" ur ON ur."user_id" = u."id" AND ur."revoked_at" IS NULL
      JOIN public."role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN public."permissions" p ON p."id" = rp."permission_id"
     WHERE u."id" = p_user AND u."status" = 'active' AND u."account_domain" = 'school'
       AND (u."locked_until" IS NULL OR u."locked_until" <= now())
       AND p."key" = 'mobile_devices:manage'
  );
$$;--> statement-breakpoint

-- 3. Sin borrado fisico (solicitudes, dispositivos y sesiones).
CREATE FUNCTION "mobile_auth_no_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'La autenticacion movil no se elimina: solicitudes, dispositivos y sesiones se conservan' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "mdr_no_delete" BEFORE DELETE ON "mobile_device_requests" FOR EACH ROW EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint
CREATE TRIGGER "mdr_no_truncate" BEFORE TRUNCATE ON "mobile_device_requests" FOR EACH STATEMENT EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint
CREATE TRIGGER "md_no_delete" BEFORE DELETE ON "mobile_devices" FOR EACH ROW EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint
CREATE TRIGGER "md_no_truncate" BEFORE TRUNCATE ON "mobile_devices" FOR EACH STATEMENT EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint
CREATE TRIGGER "ms_no_delete" BEFORE DELETE ON "mobile_sessions" FOR EACH ROW EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint
CREATE TRIGGER "ms_no_truncate" BEFORE TRUNCATE ON "mobile_sessions" FOR EACH STATEMENT EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint

-- 4. Alta de una solicitud: nace PENDIENTE y anonima (sin titular, sin aprobacion), sin intentos fallidos.
CREATE FUNCTION "mdr_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'pending' OR NEW."user_id" IS NOT NULL OR NEW."claimed_at" IS NOT NULL
     OR NEW."approved_by" IS NOT NULL OR NEW."approved_at" IS NOT NULL OR NEW."activated_at" IS NOT NULL
     OR NEW."closed_by" IS NOT NULL OR NEW."closed_at" IS NOT NULL OR NEW."claim_failures" <> 0 THEN
    RAISE EXCEPTION 'Una solicitud de vinculacion nace pendiente y sin titular' USING ERRCODE = '23514', CONSTRAINT = 'mdr_born_pending';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "mdr_guard_insert" BEFORE INSERT ON "mobile_device_requests"
  FOR EACH ROW EXECUTE FUNCTION "mdr_guard_insert"();--> statement-breakpoint

-- 5. Transiciones de una solicitud. La identidad (clave, huella, codigo, etiqueta, caducidad) es inmutable; los estados terminales
--    (activada, rechazada, cancelada) son historia. pending -> claimed (la persona titular, elegible, con la solicitud vigente);
--    claimed -> approved (otra persona con autoridad, nunca el titular); approved -> activated (solo con el dispositivo ya registrado);
--    cualquier estado abierto -> rejected/cancelled. En pending solo se permite sumar UN intento fallido de reclamo.
CREATE FUNCTION "mdr_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."key_thumbprint" IS DISTINCT FROM OLD."key_thumbprint"
     OR NEW."public_key_jwk" IS DISTINCT FROM OLD."public_key_jwk" OR NEW."pairing_code_hash" IS DISTINCT FROM OLD."pairing_code_hash"
     OR NEW."device_label" IS DISTINCT FROM OLD."device_label" OR NEW."platform" IS DISTINCT FROM OLD."platform"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."requested_ip" IS DISTINCT FROM OLD."requested_ip" THEN
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
$$;--> statement-breakpoint
CREATE TRIGGER "mdr_guard_update" BEFORE UPDATE ON "mobile_device_requests"
  FOR EACH ROW EXECUTE FUNCTION "mdr_guard_update"();--> statement-breakpoint

-- 6. Alta de un dispositivo: solo a partir de una solicitud APROBADA y vigente (se bloquea), con la misma persona titular, clave,
--    aprobador y etiqueta; la cuenta debe seguir siendo elegible; maximo 3 dispositivos activos por persona. `registered_at` lo fija la base.
CREATE FUNCTION "md_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  req record;
BEGIN
  SELECT r."status", r."user_id", r."key_thumbprint", r."public_key_jwk", r."approved_by", r."expires_at", r."device_label" INTO req
    FROM public."mobile_device_requests" r WHERE r."id" = NEW."request_id" FOR UPDATE;
  IF NOT FOUND OR req."status" <> 'approved' OR req."user_id" IS DISTINCT FROM NEW."user_id"
     OR req."key_thumbprint" <> NEW."key_thumbprint" OR req."public_key_jwk" <> NEW."public_key_jwk"
     OR req."approved_by" IS DISTINCT FROM NEW."approved_by" OR req."device_label" <> NEW."label" THEN
    RAISE EXCEPTION 'Un dispositivo solo se registra a partir de una solicitud aprobada' USING ERRCODE = '23514', CONSTRAINT = 'md_from_approved_request';
  END IF;
  IF req."expires_at" <= now() THEN
    RAISE EXCEPTION 'La solicitud vencio' USING ERRCODE = '23514', CONSTRAINT = 'md_request_not_expired';
  END IF;
  IF NOT public."mobile_user_eligible"(NEW."user_id") THEN
    RAISE EXCEPTION 'La cuenta no puede tener dispositivos moviles' USING ERRCODE = '23514', CONSTRAINT = 'md_user_eligible';
  END IF;
  IF NEW."status" IS DISTINCT FROM 'active' OR NEW."revoked_at" IS NOT NULL OR NEW."revoked_by" IS NOT NULL OR NEW."revoke_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'Un dispositivo nace activo' USING ERRCODE = '23514', CONSTRAINT = 'md_born_active';
  END IF;
  IF (SELECT count(*) FROM public."mobile_devices" d WHERE d."user_id" = NEW."user_id" AND d."status" = 'active') >= 3 THEN
    RAISE EXCEPTION 'Maximo 3 dispositivos activos por persona' USING ERRCODE = '23514', CONSTRAINT = 'md_device_limit';
  END IF;
  NEW."registered_at" := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "md_guard_insert" BEFORE INSERT ON "mobile_devices"
  FOR EACH ROW EXECUTE FUNCTION "md_guard_insert"();--> statement-breakpoint

-- 7. Cambio de un dispositivo: identidad inmutable; solo se registra `last_seen_at` y la REVOCACION (activo -> revocado, sin vuelta;
--    la hora la fija la base). Revocar un dispositivo no revoca sus sesiones aqui: lo hace el servicio en la misma transaccion y,
--    ademas, cada peticion comprueba que el dispositivo siga activo.
CREATE FUNCTION "md_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."key_thumbprint" IS DISTINCT FROM OLD."key_thumbprint" OR NEW."public_key_jwk" IS DISTINCT FROM OLD."public_key_jwk"
     OR NEW."label" IS DISTINCT FROM OLD."label" OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by" OR NEW."registered_at" IS DISTINCT FROM OLD."registered_at" THEN
    RAISE EXCEPTION 'La identidad de un dispositivo registrado es inmutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" = 'revoked' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by" OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason" THEN
      RAISE EXCEPTION 'Un dispositivo revocado no se reactiva' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'revoked' THEN
    IF NEW."revoke_reason" IS NULL OR NEW."revoked_by" IS NULL THEN
      RAISE EXCEPTION 'La revocacion registra quien y por que' USING ERRCODE = '23514', CONSTRAINT = 'md_revocation_complete';
    END IF;
    NEW."revoked_at" := now();
    RETURN NEW;
  END IF;
  IF NEW."revoked_at" IS NOT NULL OR NEW."revoked_by" IS NOT NULL OR NEW."revoke_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'La revocacion se registra completa' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "md_guard_update" BEFORE UPDATE ON "mobile_devices"
  FOR EACH ROW EXECUTE FUNCTION "md_guard_update"();--> statement-breakpoint

-- 8. Alta de una sesion movil: el dispositivo debe estar ACTIVO (se bloquea con FOR SHARE: una revocacion simultanea espera o ya se
--    vio aqui) y la cuenta debe ser elegible CON el rol concedido antes de registrar el dispositivo. Nace sin renovaciones ni revocacion.
CREATE FUNCTION "ms_guard_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  dev record;
BEGIN
  SELECT d."status", d."registered_at" INTO dev FROM public."mobile_devices" d WHERE d."id" = NEW."device_id" FOR SHARE;
  IF NOT FOUND OR dev."status" <> 'active' THEN
    RAISE EXCEPTION 'El dispositivo no esta activo' USING ERRCODE = '23514', CONSTRAINT = 'ms_device_active';
  END IF;
  IF NOT public."mobile_user_eligible"(NEW."user_id", dev."registered_at") THEN
    RAISE EXCEPTION 'La cuenta no puede abrir sesiones moviles' USING ERRCODE = '23514', CONSTRAINT = 'ms_user_eligible';
  END IF;
  IF NEW."revoked_at" IS NOT NULL OR NEW."revoked_reason" IS NOT NULL OR NEW."revoked_by" IS NOT NULL
     OR NEW."refresh_count" <> 0 OR NEW."previous_refresh_hash" IS NOT NULL OR NEW."last_refreshed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'Una sesion movil nace sin renovaciones ni revocacion' USING ERRCODE = '23514', CONSTRAINT = 'ms_born_clean';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ms_guard_insert" BEFORE INSERT ON "mobile_sessions"
  FOR EACH ROW EXECUTE FUNCTION "ms_guard_insert"();--> statement-breakpoint

-- 9. Cambio de una sesion movil: identidad y caducidad absoluta inmutables; una sesion revocada es historia. O se REVOCA (una vez; la hora
--    la fija la base) o se ROTA la renovacion: contador +1, token de renovacion y de acceso nuevos, el anterior pasa a
--    previous_refresh_hash (deteccion de reuso) y el dispositivo y la cuenta deben seguir siendo validos.
CREATE FUNCTION "ms_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  dev record;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."device_id" IS DISTINCT FROM OLD."device_id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR NEW."absolute_expires_at" IS DISTINCT FROM OLD."absolute_expires_at"
     OR NEW."ip" IS DISTINCT FROM OLD."ip" OR NEW."user_agent" IS DISTINCT FROM OLD."user_agent" THEN
    RAISE EXCEPTION 'La identidad de una sesion movil es inmutable' USING ERRCODE = '42501';
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
$$;--> statement-breakpoint
CREATE TRIGGER "ms_guard_update" BEFORE UPDATE ON "mobile_sessions"
  FOR EACH ROW EXECUTE FUNCTION "ms_guard_update"();--> statement-breakpoint

-- 9. Estado EFIMERO de seguridad (pruebas DPoP ya aceptadas y nonces). Las pruebas aceptadas son solo-agregar: ni UPDATE ni TRUNCATE.
--    Un nonce solo cambia una vez (consumed_at: NULL -> hora) y nada mas de la fila es modificable. Un DELETE solo lo admite el
--    PROPIETARIO (la API no tiene el privilegio) y solo para filas vencidas hace mas de una hora: una limpieza no puede borrar el
--    estado que todavia protege contra la repeticion (la ventana de aceptacion y los nonces duran minutos).
CREATE FUNCTION "mobile_ephemeral_guard_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."expires_at" > now() - interval '1 hour' THEN
    RAISE EXCEPTION 'El estado efimero de seguridad solo se retira una hora despues de vencer' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "mobile_proof_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Una prueba DPoP aceptada no se modifica' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "mn_guard_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."nonce_hash" IS DISTINCT FROM OLD."nonce_hash" OR NEW."key_thumbprint" IS DISTINCT FROM OLD."key_thumbprint"
     OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'La identidad y la vigencia de un nonce son inmutables' USING ERRCODE = '42501';
  END IF;
  IF OLD."consumed_at" IS NOT NULL OR NEW."consumed_at" IS NULL THEN
    RAISE EXCEPTION 'Un nonce se gasta una sola vez' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "mpj_guard_delete" BEFORE DELETE ON "mobile_proof_jtis" FOR EACH ROW EXECUTE FUNCTION "mobile_ephemeral_guard_delete"();--> statement-breakpoint
CREATE TRIGGER "mpj_no_update" BEFORE UPDATE ON "mobile_proof_jtis" FOR EACH ROW EXECUTE FUNCTION "mobile_proof_guard_update"();--> statement-breakpoint
CREATE TRIGGER "mpj_no_truncate" BEFORE TRUNCATE ON "mobile_proof_jtis" FOR EACH STATEMENT EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint
CREATE TRIGGER "mn_guard_delete" BEFORE DELETE ON "mobile_nonces" FOR EACH ROW EXECUTE FUNCTION "mobile_ephemeral_guard_delete"();--> statement-breakpoint
CREATE TRIGGER "mn_guard_update" BEFORE UPDATE ON "mobile_nonces" FOR EACH ROW EXECUTE FUNCTION "mn_guard_update"();--> statement-breakpoint
CREATE TRIGGER "mn_no_truncate" BEFORE TRUNCATE ON "mobile_nonces" FOR EACH STATEMENT EXECUTE FUNCTION "mobile_auth_no_delete"();--> statement-breakpoint

REVOKE ALL ON FUNCTION "mobile_user_eligible"(uuid, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mobile_actor_can_manage"(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mobile_auth_no_delete"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mdr_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mdr_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "md_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "md_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "ms_guard_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "ms_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mobile_ephemeral_guard_delete"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mobile_proof_guard_update"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "mn_guard_update"() FROM PUBLIC;--> statement-breakpoint

-- =====================================================================================================================
-- Parte 2: politica RBAC (datos de configuracion; ninguna cuenta, sesion ni dispositivo existe todavia). PROVISIONAL.
--   * `mobile_devices:manage` (escolar, no de autoridad): solo Direccion (alcance all): aprobar, rechazar y revocar vinculaciones.
--   * `mobile_devices:enroll` (escolar): solo prefectura (alcance own): reclamar la solicitud de SU dispositivo y revocarlo.
--   Cada alta de role_permissions queda auditada por role_permissions_audit: 2 altas = 2 eventos.
-- =====================================================================================================================

INSERT INTO "permissions" ("key", "description", "domain", "is_authority") VALUES
  ('mobile_devices:manage', 'Aprobar, rechazar y revocar vinculaciones de dispositivos moviles (dominio escolar)', 'school', false),
  ('mobile_devices:enroll', 'Vincular y revocar los dispositivos moviles propios', 'school', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "role_domain", "permission_id", "permission_domain", "scope")
SELECT r."id", r."domain", p."id", p."domain", v."scope"
FROM (VALUES
  ('direccion', 'mobile_devices:manage', 'all'),
  ('prefectura', 'mobile_devices:enroll', 'own')
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
   WHERE p."key" LIKE 'mobile_devices:%'
     AND NOT ((r."key" = 'direccion' AND p."key" = 'mobile_devices:manage' AND rp."scope" = 'all')
              OR (r."key" = 'prefectura' AND p."key" = 'mobile_devices:enroll' AND rp."scope" = 'own'));
  IF v_n <> 0 THEN RAISE EXCEPTION '0011: solo direccion (manage, all) y prefectura (enroll, own) tienen permisos de dispositivos moviles'; END IF;
  SELECT count(*) INTO v_n
    FROM "role_permissions" rp JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE p."key" LIKE 'mobile_devices:%';
  IF v_n <> 2 THEN RAISE EXCEPTION '0011: se esperaban 2 asignaciones de permisos de dispositivos moviles'; END IF;
  SELECT count(*) INTO v_n FROM "permissions" p WHERE p."key" LIKE 'mobile_devices:%' AND p."is_authority";
  IF v_n <> 0 THEN RAISE EXCEPTION '0011: los permisos de dispositivos moviles no son de autoridad'; END IF;
END
$$;
