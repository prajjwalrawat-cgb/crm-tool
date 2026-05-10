-- pgvector is required for the `vector(1536)` column type below. Supabase
-- ships the extension; this is idempotent on a re-run.
CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint

CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" text,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"model" text NOT NULL,
	"source_hash" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_tenant_entity_unique" ON "embeddings" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "embeddings_tenant_idx" ON "embeddings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ai_invocations_tenant_created_idx" ON "ai_invocations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_summaries_tenant_entity_unique" ON "ai_summaries" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint

-- HNSW index for cosine similarity. Tenant pre-filter happens via the
-- composite predicate; the planner will narrow to a tenant slice before
-- consulting the vector index for typical small-tenant query patterns.
CREATE INDEX "embeddings_vector_idx"
  ON "embeddings"
  USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint

-- ===========================================================================
-- RLS — same pattern as every other tenant-scoped table.
-- ===========================================================================
ALTER TABLE "embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "embeddings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_invocations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_summaries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "embeddings_tenant_select" ON "embeddings"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "embeddings_tenant_insert" ON "embeddings"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "embeddings_tenant_update" ON "embeddings"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "embeddings_tenant_delete" ON "embeddings"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

CREATE POLICY "ai_invocations_tenant_select" ON "ai_invocations"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "ai_invocations_tenant_insert" ON "ai_invocations"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
-- ai_invocations is append-only; no update/delete policies (FORCE RLS denies).
--> statement-breakpoint

CREATE POLICY "ai_summaries_tenant_select" ON "ai_summaries"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "ai_summaries_tenant_insert" ON "ai_summaries"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "ai_summaries_tenant_update" ON "ai_summaries"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY "ai_summaries_tenant_delete" ON "ai_summaries"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "embeddings", "ai_invocations", "ai_summaries"
  TO "app_user";
