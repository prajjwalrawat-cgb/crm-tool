-- 0068 — Sales incentive plans: per-resource plan terms, append-only version
-- history (the audit trail), an actuals history, and a tenant template.
-- See docs/incentive-calculator.md.
--
-- MONEY IS FIXED-POINT. Terms are in the source workbook's units (₹ Lakh for
-- compensation, ₹ Crore for revenue, fractions for ratios) as `numeric`, never
-- float: ₹ L at 5 dp and ₹ Cr at 7 dp are both exact to the rupee.
--
-- NO BACKFILL. No plan exists until an admin creates one; the SPOC page shows
-- an empty state, not a guessed plan.
--
-- TENANCY. RLS by tenant on all four tables, using the uuid predicate 0059
-- standardised on. Per-user isolation (a SPOC sees only their own plan) is in
-- the app layer — lib/incentives/access — because the viewer's role is not in
-- the session GUCs a policy can read.

CREATE TABLE IF NOT EXISTS "incentive_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "fiscal_year" integer NOT NULL,
  "fixed_ctc" numeric(14,5) NOT NULL,
  "target_variable" numeric(14,5) NOT NULL,
  "gate_revenue_cr" numeric(16,7) NOT NULL,
  "gate_incentive_l" numeric(14,5) NOT NULL,
  "slab1_upper_cr" numeric(16,7) NOT NULL,
  "slab1_rate_l" numeric(14,5) NOT NULL,
  "slab2_rate_l" numeric(14,5) NOT NULL,
  "step_cr" numeric(16,7) NOT NULL DEFAULT 1,
  "accrual_basis" text NOT NULL DEFAULT 'pro_rata',
  "cap_enabled" boolean NOT NULL DEFAULT false,
  "cap_amount_l" numeric(14,5),
  "prior_year_credit_pct" numeric(9,6) NOT NULL DEFAULT 0.25,
  "net_new_credit_pct" numeric(9,6) NOT NULL DEFAULT 1,
  "margin_floor_pct" numeric(9,6) NOT NULL DEFAULT 0.2,
  "margin_miss_treatment" text NOT NULL DEFAULT 'pro_rata',
  "status" text NOT NULL DEFAULT 'draft',
  "actuals_source" text NOT NULL DEFAULT 'manual',
  "version" integer NOT NULL DEFAULT 1,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- The engine validates all of this too; these are the backstop for any
  -- write path that doesn't go through it (a script, a future bulk import).
  CONSTRAINT "incentive_plans_accrual_basis_check" CHECK ("accrual_basis" IN ('pro_rata', 'full_step_only')),
  CONSTRAINT "incentive_plans_margin_miss_check" CHECK ("margin_miss_treatment" IN ('pro_rata', 'nil', 'ignore')),
  CONSTRAINT "incentive_plans_status_check" CHECK ("status" IN ('draft', 'active', 'closed')),
  CONSTRAINT "incentive_plans_actuals_source_check" CHECK ("actuals_source" IN ('manual', 'computed')),
  CONSTRAINT "incentive_plans_step_positive" CHECK ("step_cr" > 0),
  CONSTRAINT "incentive_plans_slabs_ordered" CHECK ("slab1_upper_cr" >= "gate_revenue_cr"),
  CONSTRAINT "incentive_plans_cap_amount" CHECK (NOT "cap_enabled" OR "cap_amount_l" IS NOT NULL),
  CONSTRAINT "incentive_plans_non_negative" CHECK (
    "fixed_ctc" >= 0 AND "target_variable" >= 0 AND "gate_revenue_cr" >= 0
    AND "gate_incentive_l" >= 0 AND "slab1_rate_l" >= 0 AND "slab2_rate_l" >= 0
    AND "prior_year_credit_pct" >= 0 AND "net_new_credit_pct" >= 0
    AND "margin_floor_pct" >= 0 AND "margin_floor_pct" <= 1
    AND COALESCE("cap_amount_l", 0) >= 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incentive_plans_tenant_user_fy_unique"
  ON "incentive_plans" ("tenant_id", "user_id", "fiscal_year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incentive_plans_tenant_fy_idx"
  ON "incentive_plans" ("tenant_id", "fiscal_year");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "incentive_plan_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "plan_id" uuid NOT NULL REFERENCES "incentive_plans"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "action" text NOT NULL,
  "changed_by" text,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  "changes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "snapshot" jsonb NOT NULL,
  "note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incentive_plan_versions_plan_version_unique"
  ON "incentive_plan_versions" ("plan_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incentive_plan_versions_tenant_plan_idx"
  ON "incentive_plan_versions" ("tenant_id", "plan_id", "changed_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "incentive_actuals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "plan_id" uuid NOT NULL REFERENCES "incentive_plans"("id") ON DELETE CASCADE,
  "as_of_date" date NOT NULL,
  "prior_year_revenue_cr" numeric(16,7) NOT NULL,
  "net_new_revenue_cr" numeric(16,7) NOT NULL,
  "blended_margin_pct" numeric(9,6) NOT NULL,
  "source" text NOT NULL,
  "entered_by" text,
  "computed_at" timestamptz,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "incentive_actuals_source_check" CHECK ("source" IN ('manual', 'computed')),
  CONSTRAINT "incentive_actuals_non_negative" CHECK (
    "prior_year_revenue_cr" >= 0 AND "net_new_revenue_cr" >= 0
    AND "blended_margin_pct" >= 0 AND "blended_margin_pct" <= 1
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incentive_actuals_plan_created_idx"
  ON "incentive_actuals" ("plan_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incentive_actuals_tenant_plan_idx"
  ON "incentive_actuals" ("tenant_id", "plan_id");
--> statement-breakpoint
-- One COMPUTED row per plan per day: the nightly job and an on-demand
-- recompute upsert onto it, so re-running replaces that day's figure instead
-- of stacking a second copy. Manual entries are unconstrained — each is its
-- own history point.
CREATE UNIQUE INDEX IF NOT EXISTS "incentive_actuals_computed_daily_unique"
  ON "incentive_actuals" ("plan_id", "as_of_date") WHERE "source" = 'computed';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "incentive_plan_templates" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "fixed_ctc" numeric(14,5) NOT NULL,
  "target_variable" numeric(14,5) NOT NULL,
  "gate_revenue_cr" numeric(16,7) NOT NULL,
  "gate_incentive_l" numeric(14,5) NOT NULL,
  "slab1_upper_cr" numeric(16,7) NOT NULL,
  "slab1_rate_l" numeric(14,5) NOT NULL,
  "slab2_rate_l" numeric(14,5) NOT NULL,
  "step_cr" numeric(16,7) NOT NULL DEFAULT 1,
  "accrual_basis" text NOT NULL DEFAULT 'pro_rata',
  "cap_enabled" boolean NOT NULL DEFAULT false,
  "cap_amount_l" numeric(14,5),
  "prior_year_credit_pct" numeric(9,6) NOT NULL DEFAULT 0.25,
  "net_new_credit_pct" numeric(9,6) NOT NULL DEFAULT 1,
  "margin_floor_pct" numeric(9,6) NOT NULL DEFAULT 0.2,
  "margin_miss_treatment" text NOT NULL DEFAULT 'pro_rata',
  "budget_l" numeric(14,5),
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "incentive_templates_accrual_basis_check" CHECK ("accrual_basis" IN ('pro_rata', 'full_step_only')),
  CONSTRAINT "incentive_templates_margin_miss_check" CHECK ("margin_miss_treatment" IN ('pro_rata', 'nil', 'ignore')),
  CONSTRAINT "incentive_templates_step_positive" CHECK ("step_cr" > 0)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Version history is append-only. Same shape as deal_audit_log (0060): UPDATE
-- is refused by trigger, DELETE is simply not granted to app_user — a BEFORE
-- DELETE trigger would also fire for the ON DELETE CASCADE from the plan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "incentive_plan_versions_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'incentive_plan_versions is append-only (attempted %)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_incentive_plan_versions_immutable" ON "incentive_plan_versions";
--> statement-breakpoint
CREATE TRIGGER "trg_incentive_plan_versions_immutable"
  BEFORE UPDATE ON "incentive_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "incentive_plan_versions_immutable"();
--> statement-breakpoint

ALTER TABLE "incentive_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "incentive_plan_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "incentive_actuals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "incentive_plan_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "incentive_plans_tenant_all" ON "incentive_plans"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "incentive_plan_versions_tenant_select" ON "incentive_plan_versions"
  FOR SELECT USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "incentive_plan_versions_tenant_insert" ON "incentive_plan_versions"
  FOR INSERT WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "incentive_actuals_tenant_all" ON "incentive_actuals"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "incentive_plan_templates_tenant_all" ON "incentive_plan_templates"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint

-- Plans are retired with status = 'closed', never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON "incentive_plans" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT ON "incentive_plan_versions" TO "app_user";
--> statement-breakpoint
-- UPDATE only for the same-day computed upsert; see the partial index above.
GRANT SELECT, INSERT, UPDATE ON "incentive_actuals" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "incentive_plan_templates" TO "app_user";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The GRANTs above ADD privileges; they do not narrow them. 0004's
-- ALTER DEFAULT PRIVILEGES has already handed app_user SELECT, INSERT, UPDATE
-- and DELETE on every new public table (0060 found the same on
-- deal_audit_log), so without these REVOKEs app_user could DELETE plan
-- history, and an UPDATE of it would be silently swallowed by the missing
-- RLS policy instead of failing loudly. Re-running is a no-op.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "incentive_plan_versions" FROM "app_user";
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "incentive_plans", "incentive_actuals", "incentive_plan_templates" FROM "app_user";
--> statement-breakpoint

-- Compensation data has no business being reachable through Supabase's
-- PostgREST roles at all. The app reads these tables only through app_user.
-- Guarded, so the file also applies on a Postgres without these roles.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON "incentive_plans", "incentive_plan_versions", "incentive_actuals", "incentive_plan_templates" FROM %I',
        r
      );
    END IF;
  END LOOP;
END $$;
