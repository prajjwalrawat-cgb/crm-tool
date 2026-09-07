-- 0061_team_metric_snapshots.sql
-- Period-close snapshots of the Team Performance scorecard, so every tile and
-- rep row can show movement instead of a number with no past.
--
-- Design notes
-- ------------
-- 1. WHY A TABLE AND NOT A LIVE RECOMPUTE. "Untouched deals" and "field
--    completeness" are STATES, not event streams: they are computed from
--    `deals.updated_at` and from which columns are currently NULL. There is no
--    way to ask Postgres what either looked like on 31 August — the rows have
--    been overwritten since. A "vs last period" number can therefore only come
--    from something written down at the time. The cumulative metrics (revenue,
--    pushes, deals added) COULD be replayed from the logs, but replaying six
--    aggregates over a full fiscal year on every page load is exactly the
--    thing the spec rules out, and mixing replayed and stored baselines would
--    give two metrics on one strip different meanings of "last period".
--
-- 2. RAW COUNTERS, NOT PERCENTAGES. `value` stores numerators and
--    denominators (fy_revenue_minor AND revenue_target_minor,
--    completeness_filled AND completeness_applicable), never a derived
--    percentage. A stored percentage cannot be re-derived if the definition
--    behind it changes, and it silently misreports when the denominator moves
--    — a rep whose target was raised mid-year would appear to have gone
--    backwards. Deltas are computed from the raw pairs at read time.
--
-- 3. PERIOD-CLOSE, MONTHLY. `period` is a 'YYYY-MM' month key and one row per
--    (tenant, metric, rep, period) is written by a cron on the 1st, capturing
--    the month that has just ended. Daily rows would multiply the table by 30
--    to answer a question nobody asks ("vs last Tuesday"). The unique index
--    makes a re-run idempotent: re-capturing a period overwrites it rather
--    than doubling it, which matters because the job retries.
--
-- 4. rep_id NULL IS THE TEAM ROW, the same convention `forecast_snapshots`
--    (0052) already uses. It is stored rather than summed at read time because
--    the team figure is not always the sum of the rep figures — reps who have
--    since left the workspace are in the team total of a past month and in no
--    current row.
--
-- 5. NO FK ON rep_id. User ids come from an external directory for
--    Clerk-backed tenants — same reason `deals.owner_id`,
--    `deal_date_changes.changed_by` and `deal_audit_log.changed_by` are all
--    FK-less text.

CREATE TABLE IF NOT EXISTS "team_metric_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- One of the keys in TEAM_METRICS (src/lib/team-analytics/snapshots.ts).
  "metric" text NOT NULL,
  -- NULL = the team-wide row for this (metric, period).
  "rep_id" text,
  -- 'YYYY-MM' — the month this value closed.
  "period" text NOT NULL,
  -- Minor units for money, plain counts for everything else. bigint covers
  -- both without a second column.
  "value" bigint NOT NULL DEFAULT 0,
  "computed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Idempotent re-capture (design note 3). COALESCE because NULL rep_id is the
-- team row and NULLs don't compare equal in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "team_metric_snapshots_unique"
  ON "team_metric_snapshots" (
    "tenant_id", "metric", COALESCE("rep_id", ''), "period"
  );
--> statement-breakpoint

-- The read path: "every metric for this tenant at this period".
CREATE INDEX IF NOT EXISTS "team_metric_snapshots_tenant_period_idx"
  ON "team_metric_snapshots" ("tenant_id", "period");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS — same tenant-scoping pattern as 0052 / 0058 / 0060. The `::text` cast
-- is on the column, matching 0059's index-eligible form.
-- ---------------------------------------------------------------------------
ALTER TABLE "team_metric_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "team_metric_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "team_metric_snapshots_tenant_select" ON "team_metric_snapshots";
--> statement-breakpoint
CREATE POLICY "team_metric_snapshots_tenant_select" ON "team_metric_snapshots"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "team_metric_snapshots_tenant_insert" ON "team_metric_snapshots";
--> statement-breakpoint
CREATE POLICY "team_metric_snapshots_tenant_insert" ON "team_metric_snapshots"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "team_metric_snapshots_tenant_update" ON "team_metric_snapshots";
--> statement-breakpoint
CREATE POLICY "team_metric_snapshots_tenant_update" ON "team_metric_snapshots"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "team_metric_snapshots_tenant_delete" ON "team_metric_snapshots";
--> statement-breakpoint
CREATE POLICY "team_metric_snapshots_tenant_delete" ON "team_metric_snapshots"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "team_metric_snapshots" TO "app_user";
