CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_user_id" uuid,
	"subject_user_id" uuid,
	"session_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_event_type_format" CHECK ("audit_events"."event_type" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
	CONSTRAINT "audit_events_outcome_values" CHECK ("audit_events"."outcome" IN ('success', 'failure', 'denied')),
	CONSTRAINT "audit_events_details_object" CHECK (jsonb_typeof("audit_events"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_txid" "xid8",
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_ip" "inet",
	"authorized_at" timestamp with time zone,
	"authorized_by" uuid,
	"verification_method" text,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "auth_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "auth_tokens_purpose_values" CHECK ("auth_tokens"."purpose" IN ('invite', 'password_reset')),
	CONSTRAINT "auth_tokens_token_hash_length" CHECK (octet_length("auth_tokens"."token_hash") = 32),
	CONSTRAINT "auth_tokens_expiry_window" CHECK ("auth_tokens"."expires_at" > "auth_tokens"."created_at" AND "auth_tokens"."expires_at" <= "auth_tokens"."created_at" + interval '24 hours'),
	CONSTRAINT "auth_tokens_authorization_complete" CHECK (("auth_tokens"."authorized_at" IS NULL AND "auth_tokens"."authorized_by" IS NULL AND "auth_tokens"."verification_method" IS NULL) OR ("auth_tokens"."authorized_at" IS NOT NULL AND "auth_tokens"."verification_method" IS NOT NULL AND ("auth_tokens"."authorized_by" IS NULL) = ("auth_tokens"."verification_method" = 'ceremony'))),
	CONSTRAINT "auth_tokens_not_self_authorized" CHECK ("auth_tokens"."authorized_by" IS NULL OR "auth_tokens"."authorized_by" <> "auth_tokens"."user_id"),
	CONSTRAINT "auth_tokens_verification_method_values" CHECK ("auth_tokens"."verification_method" IS NULL OR "auth_tokens"."verification_method" IN ('in_person_id', 'in_person_known', 'ceremony')),
	CONSTRAINT "auth_tokens_used_requires_authorization" CHECK ("auth_tokens"."used_at" IS NULL OR "auth_tokens"."authorized_at" IS NOT NULL),
	CONSTRAINT "auth_tokens_used_xor_invalidated" CHECK ("auth_tokens"."used_at" IS NULL OR "auth_tokens"."invalidated_at" IS NULL),
	CONSTRAINT "auth_tokens_used_txid_consistent" CHECK (("auth_tokens"."used_at" IS NULL) = ("auth_tokens"."used_txid" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"domain" text NOT NULL,
	"is_authority" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_key" UNIQUE("key"),
	CONSTRAINT "permissions_id_domain_key" UNIQUE("id","domain"),
	CONSTRAINT "permissions_key_format" CHECK ("permissions"."key" ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'),
	CONSTRAINT "permissions_domain_values" CHECK ("permissions"."domain" IN ('school', 'technical', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"role_domain" text NOT NULL,
	"permission_id" uuid NOT NULL,
	"permission_domain" text NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_id"),
	CONSTRAINT "role_permissions_domain_match" CHECK ("role_permissions"."permission_domain" = 'shared' OR "role_permissions"."permission_domain" = "role_permissions"."role_domain"),
	CONSTRAINT "role_permissions_scope_values" CHECK ("role_permissions"."scope" IN ('all', 'assigned_groups', 'own'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"domain" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"requires_mfa" boolean DEFAULT false NOT NULL,
	"session_idle_minutes" integer DEFAULT 60 NOT NULL,
	"session_absolute_minutes" integer DEFAULT 720 NOT NULL,
	"max_concurrent_sessions" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_key" UNIQUE("key"),
	CONSTRAINT "roles_id_domain_key" UNIQUE("id","domain"),
	CONSTRAINT "roles_key_format" CHECK ("roles"."key" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "roles_domain_values" CHECK ("roles"."domain" IN ('school', 'technical')),
	CONSTRAINT "roles_session_idle_positive" CHECK ("roles"."session_idle_minutes" BETWEEN 1 AND 1440),
	CONSTRAINT "roles_session_absolute_valid" CHECK ("roles"."session_absolute_minutes" BETWEEN 1 AND 10080 AND "roles"."session_idle_minutes" <= "roles"."session_absolute_minutes"),
	CONSTRAINT "roles_max_sessions_range" CHECK ("roles"."max_concurrent_sessions" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"client_type" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" uuid,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "sessions_token_hash_length" CHECK (octet_length("sessions"."token_hash") = 32),
	CONSTRAINT "sessions_client_type_values" CHECK ("sessions"."client_type" IN ('web', 'android')),
	CONSTRAINT "sessions_expiry_order" CHECK ("sessions"."expires_at" > "sessions"."created_at" AND "sessions"."idle_expires_at" <= "sessions"."expires_at"),
	CONSTRAINT "sessions_revoked_reason_values" CHECK ("sessions"."revoked_reason" IS NULL OR "sessions"."revoked_reason" IN ('logout', 'admin', 'password_changed', 'roles_changed', 'disabled', 'concurrency', 'reuse')),
	CONSTRAINT "sessions_revocation_consistent" CHECK (("sessions"."revoked_at" IS NULL) = ("sessions"."revoked_reason" IS NULL)),
	CONSTRAINT "sessions_user_agent_length" CHECK ("sessions"."user_agent" IS NULL OR char_length("sessions"."user_agent") <= 256)
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"granted_by" uuid,
	"grant_source" text DEFAULT 'grant' NOT NULL,
	"grant_reference" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "user_roles_grant_source_values" CHECK ("user_roles"."grant_source" IN ('grant', 'bootstrap', 'recovery')),
	CONSTRAINT "user_roles_grantor_valid" CHECK (("user_roles"."grant_source" = 'grant' AND "user_roles"."granted_by" IS NOT NULL AND "user_roles"."granted_by" <> "user_roles"."user_id" AND "user_roles"."grant_reference" IS NULL) OR ("user_roles"."grant_source" IN ('bootstrap', 'recovery') AND "user_roles"."granted_by" IS NULL AND "user_roles"."grant_reference" IS NOT NULL AND char_length(btrim("user_roles"."grant_reference")) BETWEEN 3 AND 200)),
	CONSTRAINT "user_roles_revocation_consistent" CHECK (("user_roles"."revoked_at" IS NULL) = ("user_roles"."revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"email_kind" text DEFAULT 'institutional' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"display_name" text NOT NULL,
	"account_domain" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" smallint DEFAULT 0 NOT NULL,
	"last_failed_login_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_id_account_domain_key" UNIQUE("id","account_domain"),
	CONSTRAINT "users_email_normalized" CHECK ("users"."email" = lower(btrim("users"."email"))),
	CONSTRAINT "users_email_format" CHECK ("users"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "users_email_length" CHECK (char_length("users"."email") <= 254),
	CONSTRAINT "users_email_kind_values" CHECK ("users"."email_kind" IN ('institutional', 'personal')),
	CONSTRAINT "users_display_name_length" CHECK (char_length(btrim("users"."display_name")) BETWEEN 1 AND 120),
	CONSTRAINT "users_account_domain_values" CHECK ("users"."account_domain" IN ('school', 'technical')),
	CONSTRAINT "users_status_values" CHECK ("users"."status" IN ('pending', 'active', 'disabled')),
	CONSTRAINT "users_active_has_password" CHECK ("users"."status" <> 'active' OR "users"."password_hash" IS NOT NULL),
	CONSTRAINT "users_active_email_verified" CHECK ("users"."status" <> 'active' OR "users"."email_kind" = 'institutional' OR "users"."email_verified_at" IS NOT NULL),
	CONSTRAINT "users_failed_login_count_nonneg" CHECK ("users"."failed_login_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_subject_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_authorized_by_fkey" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fkey" FOREIGN KEY ("role_id","role_domain") REFERENCES "public"."roles"("id","domain") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_fkey" FOREIGN KEY ("permission_id","permission_domain") REFERENCES "public"."permissions"("id","domain") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_fkey" FOREIGN KEY ("user_id","domain") REFERENCES "public"."users"("id","account_domain") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_fkey" FOREIGN KEY ("role_id","domain") REFERENCES "public"."roles"("id","domain") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_one_active_idx" ON "auth_tokens" USING btree ("user_id","purpose") WHERE "auth_tokens"."used_at" IS NULL AND "auth_tokens"."invalidated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_active_key" ON "user_roles" USING btree ("user_id","role_id") WHERE "user_roles"."revoked_at" IS NULL;