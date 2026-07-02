-- 0042_deal_margin_approval_targets.sql
-- 1) Per-deal Margin % (stored as basis points: 30% = 3000).
-- 2) Manager approval gate at the Won stage.
-- 3) Annual per-member sales targets (revenue + margin).

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "margin_bps" integer;
--> statement-breakpoint
CREATE TYPE "deal_approval_status" AS ENUM ('none', 'pending', 'approved', 'rejected');
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "approval_status" "deal_approval_status" NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "approved_by" text;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "approved_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "fiscal_year" integer NOT NULL,
  "revenue_target_minor" bigint NOT NULL DEFAULT 0,
  "margin_target_minor" bigint NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "created_by" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_targets_tenant_user_year_unique" ON "sales_targets" ("tenant_id", "user_id", "fiscal_year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_targets_tenant_year_idx" ON "sales_targets" ("tenant_id", "fiscal_year");
