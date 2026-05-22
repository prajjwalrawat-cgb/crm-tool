-- Phase 17-G: per-user chart customization persistence.
--
-- The "Chart Studio" is a hidden power-user surface opened via
-- Cmd/Ctrl+K when a chart is focused. Users can switch chart type,
-- rename, toggle display options, etc. Each customization is saved
-- per-user, per-chart, per-tenant — no impact on other reps.
--
-- The `config` column is jsonb so the studio can evolve without
-- migrations: each chart_key declares its own config shape on the
-- client side and validates at save time.
--
-- Visibility scope (role_scope):
--   'user'      → only the saving user sees this view (default)
--   'team'      → manager+admin can save; visible to manager+admin only
--   'tenant'    → admin only; visible to everyone in the tenant
-- Server actions enforce the persona<->scope mapping; the column is
-- a free-form text so we can expand without a migration.
--
-- One "default" view per (tenant, user, chart_key) — the partial
-- unique index below enforces that without blocking multiple
-- non-default saved views for the same chart.

CREATE TABLE IF NOT EXISTS chart_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  chart_key   text NOT NULL,
  title       text,
  role_scope  text NOT NULL DEFAULT 'user',
  config      jsonb NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chart_views_tenant_user_chart_idx
  ON chart_views (tenant_id, user_id, chart_key);

CREATE UNIQUE INDEX IF NOT EXISTS chart_views_default_uniq
  ON chart_views (tenant_id, user_id, chart_key)
  WHERE is_default = true;
