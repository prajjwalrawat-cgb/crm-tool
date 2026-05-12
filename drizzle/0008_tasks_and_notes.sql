-- Phase: Operational CRM — tasks + notes.
--
-- Both tables follow the established multi-tenant pattern:
--   - tenant_id FK with ON DELETE CASCADE
--   - soft-delete (deleted_at / deleted_by) so destructive UX has an undo
--   - RLS policies that read app.tenant_id via current_setting()
--   - FORCE RLS so the table-owning postgres role can't bypass policies
--   - explicit GRANTs so the app_user role (used by the app connection)
--     gets the privileges RLS will then re-scope per row
--
-- Tasks: polymorphically linked to deals/companies/contacts. The link
-- is loose (no FK) because entities are soft-deleted and we want tasks
-- to outlive a parent entity's removal — the detail page handles the
-- "linked entity has been deleted" case at render time.
--
-- Notes: required link to one entity (notes don't exist standalone).
-- The index covers the per-entity timeline lookup that the detail
-- pages issue on every load.

CREATE TYPE "task_status" AS ENUM ('todo', 'in_progress', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "task_priority" AS ENUM ('low', 'medium', 'high', 'urgent');
--> statement-breakpoint

CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" "task_status" DEFAULT 'todo' NOT NULL,
  "priority" "task_priority" DEFAULT 'medium' NOT NULL,
  "due_date" date,
  "assigned_user_id" text,
  "created_by" text NOT NULL,
  "completed_at" timestamp with time zone,
  "entity_type" text,
  "entity_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "deleted_by" text
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tasks_tenant_status_idx" ON "tasks" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "tasks_tenant_assigned_idx" ON "tasks" USING btree ("tenant_id","assigned_user_id");
--> statement-breakpoint
CREATE INDEX "tasks_tenant_due_idx" ON "tasks" USING btree ("tenant_id","due_date");
--> statement-breakpoint
CREATE INDEX "tasks_tenant_entity_idx" ON "tasks" USING btree ("tenant_id","entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "tasks_tenant_deleted_idx" ON "tasks" USING btree ("tenant_id","deleted_at");
--> statement-breakpoint

CREATE TABLE "notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "body" text NOT NULL,
  "author_user_id" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "deleted_by" text
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "notes_tenant_entity_idx" ON "notes" USING btree ("tenant_id","entity_type","entity_id","created_at");
--> statement-breakpoint
CREATE INDEX "notes_tenant_author_idx" ON "notes" USING btree ("tenant_id","author_user_id");
--> statement-breakpoint
CREATE INDEX "notes_tenant_deleted_idx" ON "notes" USING btree ("tenant_id","deleted_at");
--> statement-breakpoint

-- =============================================================================
-- RLS: tasks (same pattern as deals/companies/contacts — soft-delete
-- hidden by default, opt-in via app.include_deleted)
-- =============================================================================
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tasks_tenant_select" ON "tasks"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND (
      deleted_at IS NULL
      OR current_setting('app.include_deleted', true) = 'true'
    )
  );
--> statement-breakpoint
CREATE POLICY "tasks_tenant_insert" ON "tasks"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tasks_tenant_update" ON "tasks"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "tasks_tenant_delete" ON "tasks"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO "app_user";
--> statement-breakpoint

-- =============================================================================
-- RLS: notes (same pattern)
-- =============================================================================
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notes_tenant_select" ON "notes"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND (
      deleted_at IS NULL
      OR current_setting('app.include_deleted', true) = 'true'
    )
  );
--> statement-breakpoint
CREATE POLICY "notes_tenant_insert" ON "notes"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "notes_tenant_update" ON "notes"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "notes_tenant_delete" ON "notes"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notes" TO "app_user";
