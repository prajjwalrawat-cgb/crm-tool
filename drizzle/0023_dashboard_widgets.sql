-- Phase 17-H: per-user dashboard widget instances.
--
-- `chart_views` (migration 0022) stores customization of *built-in*
-- charts on the dashboard — one row per (user, chart_key, isDefault)
-- holding the studio config (variant, metric, display toggles, title).
--
-- This new table is the foundation for true dashboard editing: each
-- row is a USER-CREATED widget instance with its own layout slot in a
-- react-grid-layout grid. Edit Mode (Cmd/Ctrl+Shift+E) is where users
-- create / move / resize / delete these instances.
--
-- Why a separate table from chart_views: built-in charts have a fixed
-- chart_key and are part of the page composition. Widget instances
-- have generated ids, arbitrary types, and live alongside the built-in
-- charts on the same canvas. Storing them together would conflate two
-- concepts and make queries awkward.
--
-- This turn (Phase 17-H) ships the *table* + schema + edit mode toggle
-- + visual chrome. The actual drag/drop layout engine and the Cmd+Space
-- widget builder will land in the next phase — they require
-- react-grid-layout integration + a builder modal + write actions.

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  -- "widget_type" is the family of widget — 'chart' today, room for
  -- 'kpi', 'list', 'text', 'leaderboard' later. Free-form text so
  -- adding a new family doesn't require a migration.
  widget_type   text NOT NULL,
  -- "chart_type" is the specific renderer/variant for chart widgets
  -- (area / bar / funnel / donut / etc.). Null for non-chart widgets.
  chart_type    text,
  -- "metric" + "dimension" drive the data query. Both nullable so
  -- non-data widgets (e.g. text/markdown blocks) can omit them.
  metric        text,
  dimension     text,
  -- React-grid-layout placement.
  layout_x      integer NOT NULL DEFAULT 0,
  layout_y      integer NOT NULL DEFAULT 0,
  layout_w      integer NOT NULL DEFAULT 4,
  layout_h      integer NOT NULL DEFAULT 4,
  -- User-given title (may be null → widget falls back to a default
  -- label derived from chart_type + metric).
  title         text,
  -- Per-chart config blob (chart-studio shape; same parser layer as
  -- chart_views.config).
  config_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Fast read path for "give me all of user X's widgets in tenant T".
-- Edit mode does this on every dashboard load.
CREATE INDEX IF NOT EXISTS dashboard_widgets_tenant_user_idx
  ON dashboard_widgets (tenant_id, user_id);
