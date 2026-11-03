-- The link with AskMira, the HRMS a company may run its people in (src/lib/askmira).
--
-- A workspace here connects to one AskMira workspace, started by AskMira's admin
-- and allowed by an owner or admin of this workspace (/connect/askmira). The
-- connection's secret is derived from AUTH_SECRET (or ASKMIRA_LINK_SECRET) and
-- the nonce kept here, so the database never holds the secret itself.
--
-- These tables are read before any tenant context exists (a token names its
-- workspace), so they are not tenant-scoped by RLS. RLS is switched ON with no
-- policies: the app_user role every request drops to can never read them; only
-- the server's own connection (the table owner) does.

CREATE TABLE IF NOT EXISTS "askmira_links" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "askmira_tenant_id" uuid NOT NULL UNIQUE,
  "askmira_name" text,
  "askmira_origin" text,
  "secret_nonce" text NOT NULL,
  "connected_by" text,
  "connected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "askmira_connect_codes" (
  "code_hash" text PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "askmira_tenant_id" uuid NOT NULL,
  "askmira_name" text,
  "askmira_origin" text NOT NULL,
  "challenge" text NOT NULL,
  "approved_by" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "askmira_used_tokens" (
  "jti" text PRIMARY KEY,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
-- Members AskMira manages: linked by email when AskMira sends its people, and
-- suspended here (never deleted) when they leave the company in AskMira.
CREATE TABLE IF NOT EXISTS "askmira_people" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "askmira_user_id" text,
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  "suspended_at" timestamptz,
  PRIMARY KEY ("tenant_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "askmira_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "askmira_connect_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "askmira_used_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "askmira_people" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "askmira_links", "askmira_connect_codes", "askmira_used_tokens", "askmira_people" FROM "app_user";
