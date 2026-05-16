-- Phase: task-scoped collaboration comments.
--
-- Distinct from `comments` (which targets deal/company/contact) — task
-- comments are simpler: no threading, no mentions in v1, no soft delete.
-- A task is itself a relatively short-lived artifact; threading on a
-- per-task discussion doesn't earn the schema weight yet.
--
-- The body column stores raw text. If we later add @mention parsing we
-- can do it identically to `comments` (parse on insert, denormalize the
-- mentioned_user_ids[]). v1 just supports flat replies.

CREATE TABLE "task_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "author_user_id" text NOT NULL,
  "body" text NOT NULL,
  "edited_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Cascade-delete comments when the task is hard-deleted. Task is
-- soft-deleted in practice; on hard delete the comments go too because
-- they have no meaning outside their parent.
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Per-task thread render — load all comments for a task ordered chronologically.
CREATE INDEX "task_comments_tenant_task_idx" ON "task_comments" USING btree ("tenant_id","task_id","created_at");
--> statement-breakpoint
-- Author-scoped "comments I posted" filter.
CREATE INDEX "task_comments_tenant_author_idx" ON "task_comments" USING btree ("tenant_id","author_user_id");
--> statement-breakpoint

-- =============================================================================
-- RLS: tenant scoping. Mirrors the comments table pattern — anyone in
-- the tenant can read all comments and post their own. Edits constrained
-- to the author server-side (no DB-level row predicate; the action
-- enforces).
-- =============================================================================
ALTER TABLE "task_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "task_comments_tenant_select" ON "task_comments"
  FOR SELECT
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "task_comments_tenant_insert" ON "task_comments"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "task_comments_tenant_update" ON "task_comments"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "task_comments_tenant_delete" ON "task_comments"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "task_comments" TO "app_user";
