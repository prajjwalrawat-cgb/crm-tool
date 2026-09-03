-- 0060_deal_stage_governance.sql
-- Stage governance: an unbypassable audit trail over the three fields that
-- move money (stage, close date, amount), a hard stop on unexplained backward
-- stage moves, and the quota de-weighting that gives chronic pushing a cost.
--
-- Design notes
-- ------------
-- 1. WHY A TRIGGER AND NOT ONLY THE SERVICE LAYER. The spec asks for "one
--    immutable audit row per mutation, no exceptions". A service-layer
--    interceptor is only as complete as the list of call sites someone
--    remembered to route through it — and this codebase has many write paths
--    (two stage actions, a full-form update, an inline patch, bulk approve /
--    reject, CSV import, the Lead-cleanup revert, and maintenance scripts).
--    Enforcing in a BEFORE UPDATE trigger makes the guarantee structural: a
--    path that forgets the rules fails loudly instead of writing silently.
--    The service layer still validates FIRST, so users get an actionable
--    message rather than a raw Postgres error — the trigger is the backstop,
--    not the UX.
--
-- 2. RELATIONSHIP TO 0045 AND 0058. Three logs now touch a deal and they are
--    NOT redundant:
--      * deal_stage_history (0045) — stage OCCUPANCY intervals; answers "how
--        long did this sit in Proposal?". One row per interval, mutated on exit.
--      * deal_date_changes (0058) — the close-date TIMELINE the detail page
--        renders, with the is_push flag that backs deals.push_count.
--      * deal_audit_log (here) — the unified WHO CHANGED WHAT, append-only and
--        never updated, spanning all three governed fields with a change_type
--        classification. This is the compliance record; the other two are
--        purpose-built read models.
--    Keeping them separate beats overloading either: the audit log must never
--    be mutated (deal_stage_history is), and it must span fields the date log
--    has no column for.
--
-- 3. TRIGGER ORDER MATTERS. Postgres fires same-timing triggers in name order,
--    so `trg_deal_close_date_pushback_upd` (0058) runs before
--    `trg_deal_governance_upd` (this file) — c < g. That is required, not
--    incidental: 0058 computes NEW.push_count, and quota_weight here is derived
--    from it. Renaming either trigger silently breaks the de-weighting.
--
-- 4. THE ROLLBACK REASON REACHES THE TRIGGER VIA A GUC, the same transaction-
--    local mechanism 0058 uses for the close-date note and 0026 uses for the
--    actor. Threading an argument instead would mean the guarantee only holds
--    for callers that pass it — exactly the bypass this design rules out.
--
-- 5. THE CHECK CONSTRAINT IS `NOT VALID`. Existing Proposal/Negotiation deals
--    with no close date are the very problem being fixed — validating against
--    them would abort the migration. NOT VALID still enforces the rule on
--    every INSERT and UPDATE from here on; it only skips the back-scan. So a
--    legacy dateless deal is grandfathered until someone touches it, and then
--    must be given a date. Run `VALIDATE CONSTRAINT` once the backlog is clean.

-- ---------------------------------------------------------------------------
-- deals: governance columns.
-- `push_count` already exists (0058) and is NOT redeclared here.
-- ---------------------------------------------------------------------------
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "rollback_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "quota_weight" numeric(3,2) NOT NULL DEFAULT 1.00;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "last_stage_changed_at" timestamptz;
--> statement-breakpoint

-- The board's "rolled back" badge reads this per card; partial because a
-- healthy pipeline has almost none.
CREATE INDEX IF NOT EXISTS "deals_tenant_rolled_back_idx"
  ON "deals" ("tenant_id", "rollback_count")
  WHERE "rollback_count" > 0;
--> statement-breakpoint

-- Quota aggregates filter won deals then weight them; this keeps the
-- de-weighted minority cheap to isolate for the reconciliation footnote.
CREATE INDEX IF NOT EXISTS "deals_tenant_deweighted_idx"
  ON "deals" ("tenant_id", "quota_weight")
  WHERE "quota_weight" < 1.00;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- R1 at the DB level (defense in depth). NOT VALID — see design note 5.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_close_date_required'
  ) THEN
    ALTER TABLE "deals" ADD CONSTRAINT "chk_close_date_required"
      CHECK (
        "stage" NOT IN ('proposal','negotiation','won')
        OR "expected_close_date" IS NOT NULL
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Funnel rank. `hold` and `lost` return NULL: they are parking states, not
-- rungs, so no transition involving them is a rollback. Mirrors
-- `stageRank()` in src/lib/deals/stage-governance.ts — change both together.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "deal_stage_rank"(s "deal_stage") RETURNS integer AS $$
  SELECT CASE s
    WHEN 'lead'        THEN 1
    WHEN 'qualified'   THEN 2
    WHEN 'proposal'    THEN 3
    WHEN 'negotiation' THEN 4
    WHEN 'won'         THEN 5
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deal_audit_log — append-only, one row per changed governed field.
--
-- Departures from the spec's literal DDL, to match this codebase:
--   * tenant_id + RLS. Every table here is tenant-scoped; without it the audit
--     tab would read across workspaces.
--   * changed_by is `text` with NO foreign key. User ids come from an external
--     directory for Clerk-backed tenants, so `REFERENCES users(id)` would
--     reject valid actors — the same reason deals.owner_id and
--     deal_date_changes.changed_by are FK-less text.
--   * old_value / new_value are text, as specified: the column spans a stage
--     enum, a date and a bigint, so a typed column is impossible and text
--     keeps the row human-readable in a raw query.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "deal_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  -- NULL only when a write path reached the DB with no actor GUC (a script).
  "changed_by" text,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  -- 'stage' | 'expected_close_date' | 'amount_minor'
  "field_name" text NOT NULL,
  "old_value" text,
  "new_value" text,
  -- 'forward_progress' | 'rollback' | 'pushback' | 'edit'
  "change_type" text NOT NULL,
  -- Required (enforced by the trigger) when change_type = 'rollback'.
  "reason_code" text,
  "reason_note" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_deal"
  ON "deal_audit_log" ("tenant_id", "deal_id", "changed_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Governance trigger.
--
-- BEFORE UPDATE so the derived columns (rollback_count, quota_weight,
-- last_stage_changed_at) are set by assigning to NEW rather than by a
-- recursive UPDATE. The log INSERTs are safe from a BEFORE trigger on an
-- UPDATE — the parent deal row already exists — and share the statement's
-- transaction, so they roll back with a failed or rejected update.
--
-- Deliberately does NOT write activity_logs: the stage actions already record
-- `stage_changed` there, and a second write would double-report it (same
-- reasoning as 0045 and 0058).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "deal_governance_sync"() RETURNS trigger AS $$
DECLARE
  v_actor       text;
  v_reason_code text;
  v_reason_note text;
  v_old_rank    integer;
  v_new_rank    integer;
  v_is_rollback boolean := false;
  v_change_type text;
BEGIN
  v_actor := NULLIF(current_setting('app.user_id', true), '');
  v_reason_code := NULLIF(
    BTRIM(COALESCE(current_setting('app.stage_change_reason_code', true), '')), ''
  );
  v_reason_note := NULLIF(
    BTRIM(COALESCE(current_setting('app.stage_change_reason_note', true), '')), ''
  );

  -- ---------------- stage ----------------
  IF (NEW."stage" IS DISTINCT FROM OLD."stage") THEN
    v_old_rank := deal_stage_rank(OLD."stage");
    v_new_rank := deal_stage_rank(NEW."stage");
    -- A rollback needs BOTH stages ranked. Parking in Hold or reopening from
    -- Lost is not a rollback — those moves carry their own reason fields.
    v_is_rollback := v_old_rank IS NOT NULL
                 AND v_new_rank IS NOT NULL
                 AND v_new_rank < v_old_rank;

    IF v_is_rollback THEN
      -- R2. The hard stop: no reason code, no backward move. This is what
      -- makes "committing without one is impossible" true of every write
      -- path, including ones written after this migration.
      IF v_reason_code IS NULL THEN
        RAISE EXCEPTION
          'ROLLBACK_REASON_REQUIRED: moving % from % to % needs a reason code',
          NEW."id", OLD."stage", NEW."stage"
          USING ERRCODE = 'check_violation';
      END IF;
      NEW."rollback_count" := COALESCE(OLD."rollback_count", 0) + 1;
      v_change_type := 'rollback';
    ELSIF v_new_rank IS NOT NULL AND v_old_rank IS NOT NULL THEN
      v_change_type := 'forward_progress';
    ELSE
      -- To/from a parking state: a real change, but neither progress nor
      -- regression. 'edit' keeps the log honest instead of miscounting it.
      v_change_type := 'edit';
    END IF;

    NEW."last_stage_changed_at" := now();

    INSERT INTO "deal_audit_log" (
      "tenant_id", "deal_id", "changed_by", "changed_at",
      "field_name", "old_value", "new_value",
      "change_type", "reason_code", "reason_note"
    ) VALUES (
      NEW."tenant_id", NEW."id", v_actor, now(),
      'stage', OLD."stage"::text, NEW."stage"::text,
      v_change_type,
      CASE WHEN v_is_rollback THEN LEFT(v_reason_code, 100) ELSE NULL END,
      CASE WHEN v_is_rollback THEN LEFT(v_reason_note, 1000) ELSE NULL END
    );
  ELSE
    NEW."rollback_count"        := OLD."rollback_count";
    NEW."last_stage_changed_at" := OLD."last_stage_changed_at";
  END IF;

  -- ---------------- expected_close_date ----------------
  -- Classification matches the spec: a later date is a pushback, a first date
  -- is an edit, anything else (pull-in, clear) is an edit. The COUNTING of
  -- pushes stays with 0058's trigger, which has already run and set
  -- NEW.push_count; deriving it twice would risk the two disagreeing.
  IF (NEW."expected_close_date" IS DISTINCT FROM OLD."expected_close_date") THEN
    IF OLD."expected_close_date" IS NOT NULL
       AND NEW."expected_close_date" IS NOT NULL
       AND NEW."expected_close_date" > OLD."expected_close_date" THEN
      v_change_type := 'pushback';
    ELSE
      v_change_type := 'edit';
    END IF;

    INSERT INTO "deal_audit_log" (
      "tenant_id", "deal_id", "changed_by", "changed_at",
      "field_name", "old_value", "new_value", "change_type"
    ) VALUES (
      NEW."tenant_id", NEW."id", v_actor, now(),
      'expected_close_date',
      OLD."expected_close_date"::text, NEW."expected_close_date"::text,
      v_change_type
    );
  END IF;

  -- ---------------- amount_minor ----------------
  IF (NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor") THEN
    INSERT INTO "deal_audit_log" (
      "tenant_id", "deal_id", "changed_by", "changed_at",
      "field_name", "old_value", "new_value", "change_type"
    ) VALUES (
      NEW."tenant_id", NEW."id", v_actor, now(),
      'amount_minor',
      OLD."amount_minor"::text, NEW."amount_minor"::text,
      'edit'
    );
  END IF;

  -- ---------------- R6: quota weight ----------------
  -- Recomputed on every governed write, not only on a push, so a correction to
  -- push_count (or a restore) can never leave a stale haircut behind. Reads
  -- NEW.push_count, which 0058's trigger has already settled — see note 3.
  NEW."quota_weight" := CASE
    WHEN COALESCE(NEW."push_count", 0) > 3 THEN 0.50
    ELSE 1.00
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_governance_upd" ON "deals";
--> statement-breakpoint
-- Named to sort AFTER trg_deal_close_date_pushback_upd (see design note 3).
CREATE TRIGGER "trg_deal_governance_upd"
  BEFORE UPDATE OF "stage", "expected_close_date", "amount_minor" ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deal_governance_sync"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Immutability (R5): the audit log is append-only, in two layers.
--
-- LAYER 1 — privileges. The REVOKE below is NOT redundant with the GRANT at
-- the bottom of this file: on a Supabase database, ALTER DEFAULT PRIVILEGES
-- has already granted UPDATE and DELETE on every new public table to the
-- application roles, so a table created here starts out writable no matter
-- what this migration grants. Verified on this deployment, where app_user
-- came out holding UPDATE and DELETE. Revoking makes a tamper attempt fail
-- loudly with "permission denied" instead of being silently swallowed by the
-- missing RLS policy, which is the difference between an audit trail that is
-- provably immutable and one that merely happens not to be written to.
--
-- LAYER 2 — a trigger, which also covers roles that legitimately keep UPDATE
-- (postgres, service_role) and so are unaffected by the revoke.
--
-- DELETE is trigger-free on purpose: a BEFORE DELETE trigger fires for
-- `ON DELETE CASCADE` too, so blocking it would make hard-deleting a deal
-- fail outright. The revoke stops application deletes; referential cleanup
-- runs as the table owner and is unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "deal_audit_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'deal_audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_audit_log_immutable" ON "deal_audit_log";
--> statement-breakpoint
CREATE TRIGGER "trg_deal_audit_log_immutable"
  BEFORE UPDATE ON "deal_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "deal_audit_log_immutable"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill quota_weight for deals that already carry >3 pushes. Touches only
-- quota_weight, so neither the pushback nor the governance trigger fires (both
-- are UPDATE OF on other columns) and no phantom audit rows are written.
-- rollback_count starts at 0 for every existing deal: rollbacks before this
-- migration were never recorded, and claiming a count would be inventing one.
-- ---------------------------------------------------------------------------
UPDATE "deals"
   SET "quota_weight" = 0.50
 WHERE "push_count" > 3
   AND "quota_weight" <> 0.50;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS — same tenant-scoping pattern as 0045 / 0049 / 0058. UPDATE and DELETE
-- policies are deliberately omitted: the immutability trigger rejects both, so
-- granting them would only produce a confusing error one layer later.
-- The `::text` cast is on the column, matching 0059's index-eligible form.
-- ---------------------------------------------------------------------------
ALTER TABLE "deal_audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_audit_log_tenant_select" ON "deal_audit_log";
--> statement-breakpoint
CREATE POLICY "deal_audit_log_tenant_select" ON "deal_audit_log"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_audit_log_tenant_insert" ON "deal_audit_log";
--> statement-breakpoint
CREATE POLICY "deal_audit_log_tenant_insert" ON "deal_audit_log"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT ON "deal_audit_log" TO "app_user";
--> statement-breakpoint
-- See "Immutability" above: this undoes Supabase's default privileges, which
-- would otherwise leave the audit log app-writable.
REVOKE UPDATE, DELETE, TRUNCATE ON "deal_audit_log" FROM "app_user";
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "deal_audit_log" FROM "anon";
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "deal_audit_log" FROM "authenticated";
