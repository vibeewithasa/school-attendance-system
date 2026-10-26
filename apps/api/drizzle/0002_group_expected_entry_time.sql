ALTER TABLE "groups" ADD COLUMN "expected_entry_time" time(0);--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_expected_entry_time_range" CHECK ("groups"."expected_entry_time" < TIME '24:00:00');--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_expected_entry_time_minute" CHECK (EXTRACT(SECOND FROM "groups"."expected_entry_time") = 0);