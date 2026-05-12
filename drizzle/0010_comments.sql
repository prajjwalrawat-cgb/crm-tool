-- Phase: comments + mentions.
--
-- Comments are the collaboration layer — distinct from notes (personal
-- memory, editable) and activity_logs (audit stream, append-only).
-- Each comment is tied to one entity (deal/company/contact) and may
-- reply to a parent comment one level deep. Mentions are stored both
-- inline in `body` (markdown-style `@[Name](user-id)` tokens) AND in a
-- denormalized `mentioned_user_ids` array for fast notification
-- fan-out without re-parsing.
--
-- Soft-delete only — comments are part of the audit story and should
-- never disappear from compliance views. UI hides deleted comments
-- from the default thread render.

CREATE TABLE "comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "author_user_id" text NOT NULL,
  "parent_comment_id" uuid,
  "body" text NOT NULL,
  -- text[] of Clerk user ids mentioned in the comment, materialized
  -- on insert so notification dispatch is index-only.
  "mentioned_user_ids" text[] NOT NULL DEFAULT '{}',
  "edited_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "deleted_by" text
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Self-FK on parent: if the parent comment is hard-deleted, replies
-- detach (SET NULL) so the thread doesn't blow up. In practice we
-- soft-delete; the hard-delete branch is defensive.
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- Per-entity thread: serves the detail-page query (load all comments
-- for a deal/company/contact, ordered by created_at).
CREATE INDEX "comments_tenant_entity_idx" ON "comments" USING btree ("tenant_id","entity_type","entity_id","created_at");
--> statement-breakpoint
-- Parent lookup for reply ordering inside a thread.
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_comment_id","created_at");
--> statement-breakpoint
-- Author scoping for "comments I wrote" filters.
CREATE INDEX "comments_tenant_author_idx" ON "comments" USING btree ("tenant_id","author_user_id");
--> statement-breakpoint
CREATE INDEX "comments_tenant_deleted_idx" ON "comments" USING btree ("tenant_id","deleted_at");
--> statement-breakpoint

-- =============================================================================
-- RLS: tenant scoping + soft-delete hidden by default (same pattern
-- as companies/contacts/deals).
-- =============================================================================
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "comments_tenant_select" ON "comments"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND (
      deleted_at IS NULL
      OR current_setting('app.include_deleted', true) = 'true'
    )
  );
--> statement-breakpoint
CREATE POLICY "comments_tenant_insert" ON "comments"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "comments_tenant_update" ON "comments"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "comments_tenant_delete" ON "comments"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "comments" TO "app_user";
