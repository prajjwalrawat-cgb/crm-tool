-- 0025_local_auth.sql
-- Self-hosted email/password auth — replaces Clerk.
-- Adds: users, password_reset_tokens, org_invitations.
-- Relaxes tenants.clerk_org_id to nullable (legacy mapping is preserved
-- for existing rows; new workspaces leave it null).

CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "password_hash" text,
  "first_name" text,
  "last_name" text,
  "image_url" text,
  "email_verified" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_idx" ON "password_reset_tokens" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" "membership_role" NOT NULL DEFAULT 'member',
  "token_hash" text NOT NULL,
  "invited_by_user_id" text,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invitations_token_hash_unique" ON "org_invitations" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_tenant_idx" ON "org_invitations" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_email_idx" ON "org_invitations" ("email");
--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "clerk_org_id" DROP NOT NULL;
