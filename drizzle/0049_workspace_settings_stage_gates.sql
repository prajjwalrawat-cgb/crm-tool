-- 0049_workspace_settings_stage_gates.sql
-- Phase 2 / Module 1 (Stage-Gate Enforcement) + the cross-cutting per-workspace
-- feature-flag table that gates every Phase-2 module.
--
-- Two tables:
--   workspace_settings — one row per tenant, five boolean feature flags. Defaults
--     OFF at the column level; the CGB workspace is flipped ON by the seed script
--     (seed-stage-gates.ts / seed-owner path), not here, so a fresh non-CGB
--     tenant stays dark until an admin opts in.
--   stage_gates — admin-defined per-stage entry requirements. `evaluateStageTransition`
--     reads these; every deal stage-mutation path enforces them.
--
-- RLS: identical tenant-scoping pattern to 0045 (keyed on app.tenant_id).

-- ---------------------------------------------------------------------------
-- workspace_settings: per-tenant Phase-2 feature flags.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workspace_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "stage_gates_enabled" boolean NOT NULL DEFAULT false,
  "deal_scoring_enabled" boolean NOT NULL DEFAULT false,
  "email_sync_enabled" boolean NOT NULL DEFAULT false,
  "forecasts_enabled" boolean NOT NULL DEFAULT false,
  "dedup_enabled" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- stage_gates: per-stage entry requirements (Salesforce "Path" + validation rules).
-- `stage` is the stage being ENTERED. One row per (tenant, stage, rule_type).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "stage_gates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "stage" "deal_stage" NOT NULL,
  "rule_type" text NOT NULL,
  "rule_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "severity" text NOT NULL DEFAULT 'block',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stage_gates_rule_type_check" CHECK ("rule_type" IN (
    'field_required', 'min_stakeholders', 'min_activities',
    'amount_required', 'task_complete', 'custom_note'
  )),
  CONSTRAINT "stage_gates_severity_check" CHECK ("severity" IN ('block', 'warn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stage_gates_tenant_stage_rule_uniq"
  ON "stage_gates" ("tenant_id", "stage", "rule_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_gates_tenant_stage_active_idx"
  ON "stage_gates" ("tenant_id", "stage", "is_active");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: same tenant-scoping pattern as 0045 / 0027.
-- ---------------------------------------------------------------------------
ALTER TABLE "workspace_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stage_gates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stage_gates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "workspace_settings_tenant_select" ON "workspace_settings"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "workspace_settings_tenant_insert" ON "workspace_settings"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "workspace_settings_tenant_update" ON "workspace_settings"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "workspace_settings_tenant_delete" ON "workspace_settings"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

CREATE POLICY "stage_gates_tenant_select" ON "stage_gates"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "stage_gates_tenant_insert" ON "stage_gates"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "stage_gates_tenant_update" ON "stage_gates"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "stage_gates_tenant_delete" ON "stage_gates"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- Explicit grants for the RLS role (default privileges from 0004 also cover
-- new tables, but be explicit so this migration is self-contained).
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_settings" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "stage_gates" TO "app_user";
