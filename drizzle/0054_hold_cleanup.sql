-- 0054_hold_cleanup.sql
-- Phase 2 / Module 6 (Hold Stage Cleanup). Reason code + revisit date + note
-- for deals parked in the Hold stage.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "hold_reason" text;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "hold_revisit_on" date;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "hold_note" text;
--> statement-breakpoint
-- Supports the daily revisit-due scan (WHERE stage='hold' AND hold_revisit_on <= today).
CREATE INDEX IF NOT EXISTS "deals_tenant_hold_revisit_idx"
  ON "deals" ("tenant_id", "hold_revisit_on")
  WHERE "stage" = 'hold';
