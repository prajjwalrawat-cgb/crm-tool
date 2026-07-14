-- 0045_deal_detail_expansion.sql
-- Deal Detail page build-out: structured tasks, stakeholders, stage history,
-- documents, and next-step / competitor / source fields.
--
-- Design note: we deliberately REUSE `activity_logs` as the activity feed
-- rather than introducing a separate `activities` table — the per-entity
-- timeline and the AI deal analysis already read from `activity_logs`, and a
-- parallel table would fragment both. New manual-log verbs (call/meeting) ride
-- the existing text `action` column; no enum change is needed for those.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "task_type" AS ENUM ('call', 'email', 'meeting', 'internal', 'followup');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "task_recurrence" AS ENUM ('daily', 'weekly', 'custom');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "deal_contact_role" AS ENUM ('decision_maker', 'influencer', 'champion', 'blocker', 'other');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "deal_document_category" AS ENUM ('proposal', 'contract', 'pricing', 'other');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- tasks: structured-creation columns
-- ---------------------------------------------------------------------------
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "type" "task_type";
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "recurrence" "task_recurrence";
--> statement-breakpoint
-- Stage this task blocks (deal can't leave the stage until it's done). Stored
-- as the deal_stage enum value; NULL = non-blocking. Loose reference (enum,
-- not FK) — stages are an enum, not a table.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "stage_blocking" "deal_stage";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deals: next step / competitor / source (lost_reason already added in 0044)
-- ---------------------------------------------------------------------------
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "next_step" text;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "competitor" text;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deal_contacts: stakeholders linked to a deal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "deal_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "role" "deal_contact_role" NOT NULL DEFAULT 'other',
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- No duplicate contact on the same deal.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_contacts_deal_contact_unique"
  ON "deal_contacts" ("deal_id", "contact_id");
--> statement-breakpoint
-- Enforce at most one primary contact per deal at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_contacts_one_primary_per_deal"
  ON "deal_contacts" ("deal_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_contacts_tenant_deal_idx"
  ON "deal_contacts" ("tenant_id", "deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_contacts_tenant_contact_idx"
  ON "deal_contacts" ("tenant_id", "contact_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deal_stage_history: one row per (deal, stage) occupancy interval.
-- exited_at NULL = the deal is currently in this stage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "deal_stage_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "stage" "deal_stage" NOT NULL,
  "entered_at" timestamptz NOT NULL DEFAULT now(),
  "exited_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_stage_history_deal_idx"
  ON "deal_stage_history" ("deal_id", "entered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_stage_history_tenant_stage_idx"
  ON "deal_stage_history" ("tenant_id", "stage");
--> statement-breakpoint
-- At most one open (current) interval per deal.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_stage_history_one_open_per_deal"
  ON "deal_stage_history" ("deal_id") WHERE "exited_at" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deal_documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "deal_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "uploaded_by" text NOT NULL,
  "file_name" text NOT NULL,
  "file_url" text NOT NULL,
  "storage_path" text,
  "file_type" text NOT NULL DEFAULT 'application/octet-stream',
  "size_bytes" bigint NOT NULL DEFAULT 0,
  "category" "deal_document_category" NOT NULL DEFAULT 'other',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_documents_tenant_deal_idx"
  ON "deal_documents" ("tenant_id", "deal_id", "created_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deal_stage_history trigger: keep the occupancy intervals in lockstep with
-- deals.stage on every INSERT / stage-UPDATE, regardless of which code path
-- performed the change. Activity (stage_changed) is written app-side already,
-- so this trigger deliberately does NOT touch activity_logs — avoids the
-- double-write the verification checklist calls out.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "deal_stage_history_sync"() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO "deal_stage_history" ("tenant_id", "deal_id", "stage", "entered_at", "exited_at")
    VALUES (NEW."tenant_id", NEW."id", NEW."stage", COALESCE(NEW."created_at", now()), NULL);
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (NEW."stage" IS DISTINCT FROM OLD."stage") THEN
      UPDATE "deal_stage_history"
        SET "exited_at" = now()
        WHERE "deal_id" = NEW."id" AND "exited_at" IS NULL;
      INSERT INTO "deal_stage_history" ("tenant_id", "deal_id", "stage", "entered_at", "exited_at")
      VALUES (NEW."tenant_id", NEW."id", NEW."stage", now(), NULL);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_stage_history_ins" ON "deals";
--> statement-breakpoint
CREATE TRIGGER "trg_deal_stage_history_ins"
  AFTER INSERT ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deal_stage_history_sync"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_stage_history_upd" ON "deals";
--> statement-breakpoint
CREATE TRIGGER "trg_deal_stage_history_upd"
  AFTER UPDATE OF "stage" ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deal_stage_history_sync"();
--> statement-breakpoint

-- Backfill an open interval for every existing deal that has no history yet.
-- Idempotent: NOT EXISTS guard means re-running is a no-op. Runs as the
-- migration role (BYPASSRLS) so all tenants are covered in one pass.
INSERT INTO "deal_stage_history" ("tenant_id", "deal_id", "stage", "entered_at", "exited_at")
SELECT d."tenant_id", d."id", d."stage", d."created_at", NULL
FROM "deals" d
WHERE NOT EXISTS (
  SELECT 1 FROM "deal_stage_history" h WHERE h."deal_id" = d."id"
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: same tenant-scoping pattern as 0003 / 0027.
-- ---------------------------------------------------------------------------
ALTER TABLE "deal_contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_contacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_stage_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_stage_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "deal_contacts_tenant_select" ON "deal_contacts"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_contacts_tenant_insert" ON "deal_contacts"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_contacts_tenant_update" ON "deal_contacts"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_contacts_tenant_delete" ON "deal_contacts"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

CREATE POLICY "deal_stage_history_tenant_select" ON "deal_stage_history"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_stage_history_tenant_insert" ON "deal_stage_history"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_stage_history_tenant_update" ON "deal_stage_history"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_stage_history_tenant_delete" ON "deal_stage_history"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

CREATE POLICY "deal_documents_tenant_select" ON "deal_documents"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_documents_tenant_insert" ON "deal_documents"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_documents_tenant_update" ON "deal_documents"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_documents_tenant_delete" ON "deal_documents"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- Explicit grants for the RLS role (default privileges from 0004 also cover
-- new tables, but be explicit so this migration is self-contained).
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_contacts" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_stage_history" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_documents" TO "app_user";
