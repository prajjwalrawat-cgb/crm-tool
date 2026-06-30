-- 0038_updated_by.sql
-- Track the last user to change a record (audit). Activity log already records
-- every change with an actor; this surfaces the latest editor on the row.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "updated_by" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "updated_by" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "updated_by" text;
