CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"school_year_id" uuid NOT NULL,
	"grade" smallint NOT NULL,
	"code" text NOT NULL,
	"shift" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_year_grade_code_shift_key" UNIQUE NULLS NOT DISTINCT("school_year_id","grade","code","shift"),
	CONSTRAINT "groups_id_school_year_id_key" UNIQUE("id","school_year_id"),
	CONSTRAINT "groups_grade_range" CHECK ("groups"."grade" BETWEEN 1 AND 3),
	CONSTRAINT "groups_code_length" CHECK (char_length("groups"."code") BETWEEN 1 AND 10),
	CONSTRAINT "groups_code_format" CHECK ("groups"."code" ~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$'),
	CONSTRAINT "groups_shift_values" CHECK ("groups"."shift" IN ('matutino', 'vespertino'))
);
--> statement-breakpoint
CREATE TABLE "school_years" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_years_name_key" UNIQUE("name"),
	CONSTRAINT "school_years_name_not_blank" CHECK (btrim("school_years"."name") <> '' AND "school_years"."name" = btrim("school_years"."name")),
	CONSTRAINT "school_years_dates_ordered" CHECK ("school_years"."ends_on" > "school_years"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_school_year_id_fkey" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "school_years_single_active_idx" ON "school_years" USING btree ("is_active") WHERE "school_years"."is_active";