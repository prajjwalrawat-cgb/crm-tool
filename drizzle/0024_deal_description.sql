-- Add an optional free-text description to deals so reps can capture
-- context that doesn't fit in name (key blockers, decision criteria,
-- next steps). Nullable; existing rows keep NULL.

ALTER TABLE deals ADD COLUMN description text;
