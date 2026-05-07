ALTER TABLE "tenants" ADD COLUMN "clerk_org_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_clerk_org_id_unique" UNIQUE("clerk_org_id");