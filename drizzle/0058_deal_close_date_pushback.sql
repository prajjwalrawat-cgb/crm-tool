-- 0058_deal_close_date_pushback.sql
-- "Timeline pushed" tracking: every close-date change is an event, and the
-- forward-moving ones (pushbacks) are counted so the board can flag deals the
-- team is quietly letting slip.
--
-- Design notes
-- ------------
-- 1. The counters live on `deals` as a trigger-maintained cache, not as a
--    subquery over the log. The kanban reads them once per card and the
--    "slipped only" filter is a single indexed predicate; deriving either from
--    `deal_date_changes` would put an aggregate in the board's hot path.
--
-- 2. `original_close_date` is write-once, but it is NOT "the value at INSERT"
--    in this codebase: a deal starts life at Lead, and a Lead may not carry a
--    close date at all (see `violatesLeadCloseDate`). So the baseline is the
--    FIRST close date the deal ever carried — set at INSERT when the deal is
--    created dated, otherwise captured on the first NULL -> date write. After
--    that the trigger pins it, so no app path can rewrite the commitment a
--    manager is being shown.
--
-- 3. `push_count` only ever counts forward moves between two real dates. A
--    pull-in, a correction, and the date-clearing that happens when a deal is
--    dragged back to Lead are all logged in `deal_date_changes` (they belong in
--    the timeline) but none of them increments the counter.
--
-- 4. `total_slip_days` is recomputed on EVERY close-date change as
--    (current - original), floored at 0 — not only on pushes. A deal pushed by
--    40 days and then pulled all the way back is no longer slipping, and a
--    stale 40 would keep a red bar on a card that's back on schedule.
--    `push_count` stays monotonic, so "pushed 3x, 0 days slipped now" is
--    expressible and truthful.
--
-- 5. Attribution comes from the `app.user_id` GUC that `app_set_ctx` (0026)
--    already sets, so every write path — server action, bulk upload, script —
--    is attributed without threading an actor argument through it. The optional
--    "why is this pushed back?" note rides in on a second transaction-local
--    GUC, `app.close_date_reason`, set by the caller right before the UPDATE.

-- ---------------------------------------------------------------------------
-- deals: derived pushback columns (trigger-maintained; the app never writes
-- these — the trigger pins them on every close-date UPDATE)
-- ---------------------------------------------------------------------------
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "original_close_date" date;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "push_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "last_pushed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "total_slip_days" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Partial index for the board's "show slipped deals only" filter. Partial
-- because the slipping cohort is the small minority of a healthy pipeline.
CREATE INDEX IF NOT EXISTS "deals_tenant_pushed_idx"
  ON "deals" ("tenant_id", "push_count")
  WHERE "push_count" > 0;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deal_date_changes: one row per close-date change, push or not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "deal_date_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  -- Either side may be NULL: NULL -> date is the first commitment, and
  -- date -> NULL is the clear that happens when a deal goes back to Lead.
  "old_close_date" date,
  "new_close_date" date,
  -- Actor id, matching `deals.owner_id` / `deals.updated_by`: a text user id
  -- with no FK. Users live in an external directory for Clerk-backed tenants,
  -- so a FK here would be wrong for the same reason it is wrong there.
  -- NULL when the change came from a path with no actor GUC set.
  "changed_by" text,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  -- Optional free-text note the rep attaches ("client procurement delay").
  "reason" text,
  -- Whether this change was counted as a pushback. Persisted rather than
  -- re-derived so the timeline can never disagree with `deals.push_count`
  -- about what counted.
  "is_push" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
-- Reverse-chronological reads for one deal (the detail-page timeline).
CREATE INDEX IF NOT EXISTS "deal_date_changes_tenant_deal_idx"
  ON "deal_date_changes" ("tenant_id", "deal_id", "changed_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Trigger: maintain the derived columns and append the change log.
--
-- BEFORE (not AFTER) so the derived columns are set by assigning to NEW —
-- an AFTER trigger would need a recursive UPDATE on `deals`. The log INSERT is
-- safe from a BEFORE UPDATE trigger: the parent row already exists (this is an
-- UPDATE), and the insert shares the statement's transaction, so it rolls back
-- with a failed update.
--
-- Deliberately does NOT write `activity_logs` — close-date edits already flow
-- through the deal's activity/timeline via the update actions, and a second
-- write here would double-report them (same reasoning as 0045's stage-history
-- trigger).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "deal_close_date_pushback_sync"() RETURNS trigger AS $$
DECLARE
  v_actor  text;
  v_reason text;
  v_is_push boolean := false;
BEGIN
  IF (TG_OP = 'INSERT') THEN
    -- A deal created with a date commits to it; one created bare (Lead) has no
    -- baseline yet and picks one up on its first dated write.
    NEW."original_close_date" := NEW."expected_close_date";
    NEW."push_count"          := 0;
    NEW."last_pushed_at"      := NULL;
    NEW."total_slip_days"     := 0;
    RETURN NEW;
  END IF;

  -- The trigger fires whenever expected_close_date appears in the SET list,
  -- even when the value is unchanged. Pin the derived columns to their stored
  -- values so such a write can't disturb them either.
  IF (NEW."expected_close_date" IS NOT DISTINCT FROM OLD."expected_close_date") THEN
    NEW."original_close_date" := OLD."original_close_date";
    NEW."push_count"          := OLD."push_count";
    NEW."last_pushed_at"      := OLD."last_pushed_at";
    NEW."total_slip_days"     := OLD."total_slip_days";
    RETURN NEW;
  END IF;

  -- Write-once baseline. COALESCE, not an IF: once set it survives every
  -- later change, including a clear back to NULL.
  NEW."original_close_date" :=
    COALESCE(OLD."original_close_date", NEW."expected_close_date");

  -- A push is a forward move between two real dates. Setting a first date,
  -- clearing a date, and pulling one in are all changes but not pushes.
  v_is_push := OLD."expected_close_date" IS NOT NULL
           AND NEW."expected_close_date" IS NOT NULL
           AND NEW."expected_close_date" > OLD."expected_close_date";

  IF v_is_push THEN
    NEW."push_count"     := COALESCE(OLD."push_count", 0) + 1;
    NEW."last_pushed_at" := now();
  ELSE
    NEW."push_count"     := COALESCE(OLD."push_count", 0);
    NEW."last_pushed_at" := OLD."last_pushed_at";
  END IF;

  NEW."total_slip_days" := CASE
    WHEN NEW."expected_close_date" IS NULL OR NEW."original_close_date" IS NULL
      THEN 0
    ELSE GREATEST(0, NEW."expected_close_date" - NEW."original_close_date")
  END;

  v_actor  := NULLIF(current_setting('app.user_id', true), '');
  v_reason := NULLIF(
    BTRIM(COALESCE(current_setting('app.close_date_reason', true), '')),
    ''
  );

  INSERT INTO "deal_date_changes" (
    "tenant_id", "deal_id", "old_close_date", "new_close_date",
    "changed_by", "changed_at", "reason", "is_push"
  ) VALUES (
    NEW."tenant_id",
    NEW."id",
    OLD."expected_close_date",
    NEW."expected_close_date",
    v_actor,
    now(),
    LEFT(v_reason, 1000),
    v_is_push
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_close_date_pushback_ins" ON "deals";
--> statement-breakpoint
CREATE TRIGGER "trg_deal_close_date_pushback_ins"
  BEFORE INSERT ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deal_close_date_pushback_sync"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_close_date_pushback_upd" ON "deals";
--> statement-breakpoint
CREATE TRIGGER "trg_deal_close_date_pushback_upd"
  BEFORE UPDATE OF "expected_close_date" ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deal_close_date_pushback_sync"();
--> statement-breakpoint

-- Backfill the baseline for deals that already carry a date. Idempotent (the
-- NULL guard), and it does not touch expected_close_date, so the UPDATE-OF
-- trigger stays quiet and no phantom change rows are logged. Existing deals
-- start at push_count 0: history before this migration wasn't recorded, so
-- claiming a count would be inventing one.
UPDATE "deals"
   SET "original_close_date" = "expected_close_date"
 WHERE "original_close_date" IS NULL
   AND "expected_close_date" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS — same tenant-scoping pattern as 0045 / 0049.
-- ---------------------------------------------------------------------------
ALTER TABLE "deal_date_changes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_date_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deal_date_changes_tenant_select" ON "deal_date_changes"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_date_changes_tenant_insert" ON "deal_date_changes"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_date_changes_tenant_update" ON "deal_date_changes"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_date_changes_tenant_delete" ON "deal_date_changes"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_date_changes" TO "app_user";
