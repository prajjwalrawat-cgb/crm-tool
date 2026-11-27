-- 0082_prospect_sources.sql
--
-- Prospect Board: the list of sources ("where this prospect came from") that
-- the New prospect form and Quick dump offer as a dropdown. Owners/admins
-- edit it under Settings -> Prospect board. Existing workspaces get the
-- default list; prospects keep whatever source they already have.
--
-- Idempotent: safe to replay on every deploy.

ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "prospect_sources" text[] NOT NULL
  DEFAULT ARRAY['WhatsApp', 'Mail', 'Call', 'LinkedIn', 'Found by myself']::text[];
