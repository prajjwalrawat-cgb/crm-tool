-- 0057_deal_value_split_elements.sql
-- TCV as a combination of commercial elements, each with its own year profile.
--
-- 0055 split a deal's TCV by contract year. A real contract is usually a mix:
-- a one-off licence and implementation fee plus a recurring AMC or support
-- charge. This extends the same table from a per-year list into a per-element
-- x per-year grid, so "AMC 1,75,000 a year for three years" is expressible
-- instead of collapsing into an anonymous year total.
--
-- Still record-and-report only: `deals.amount_minor` stays the TCV and remains
-- the single figure the board, forecast and targets read. The grid's grand
-- total must equal it (enforced in the action); nothing here re-baselines an
-- existing number.
--
-- `billing_type` records the author's INTENT and drives the auto-fill in the
-- UI (one-time -> year 1, recurring -> spread across the term). It is not a
-- constraint: any cell stays editable afterwards, because real contracts have
-- exceptions (a support fee that starts in year 2, a ramped licence).

-- Elements a contract value can be made of. `other` carries a free-text label
-- so a workspace isn't blocked on an enum change for a one-off line.
DO $$ BEGIN
  CREATE TYPE "deal_value_component" AS ENUM (
    'license',
    'implementation',
    'support',
    'amc',
    'training',
    'hardware',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "deal_value_billing_type" AS ENUM ('one_time', 'recurring');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- 1-based position of the element within the deal's grid. This, not the
-- component, is the element's identity: a deal may legitimately carry two
-- `other` lines with different labels.
ALTER TABLE "deal_value_splits"
  ADD COLUMN IF NOT EXISTS "element_index" smallint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ADD COLUMN IF NOT EXISTS "component" "deal_value_component" NOT NULL DEFAULT 'other';
--> statement-breakpoint
-- Required when component = 'other', ignored otherwise.
--
-- The default is not cosmetic. These columns are additive, so code deployed
-- BEFORE this migration keeps inserting without them and picks up the
-- defaults — which would be component='other' + label=NULL, exactly what the
-- `other_needs_label` check below rejects. That would turn every split save on
-- the running deployment into a constraint violation. Defaulting the label
-- keeps those inserts legal, and 'Contract value' is what a pre-element row
-- actually is: one unnamed line carrying the whole TCV.
ALTER TABLE "deal_value_splits"
  ADD COLUMN IF NOT EXISTS "component_label" text;
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ALTER COLUMN "component_label" SET DEFAULT 'Contract value';
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ADD COLUMN IF NOT EXISTS "billing_type" "deal_value_billing_type" NOT NULL DEFAULT 'recurring';
--> statement-breakpoint

-- Any rows written under 0055 predate the element concept: they are a single
-- unnamed line covering the whole contract value, recurring across its years.
-- Name them so they render as a normal element rather than a blank row.
UPDATE "deal_value_splits"
  SET "component_label" = 'Contract value'
  WHERE "component" = 'other' AND "component_label" IS NULL;
--> statement-breakpoint

-- The grid's key is (deal, element, year). The old unique index allowed one
-- row per year per deal, which is exactly what has to stop being true.
DROP INDEX IF EXISTS "deal_value_splits_deal_year_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deal_value_splits_deal_element_year_uniq"
  ON "deal_value_splits" ("deal_id", "element_index", "year_index");
--> statement-breakpoint

ALTER TABLE "deal_value_splits"
  DROP CONSTRAINT IF EXISTS "deal_value_splits_element_index_positive";
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ADD CONSTRAINT "deal_value_splits_element_index_positive"
  CHECK ("element_index" >= 1);
--> statement-breakpoint

-- A custom line without a label would render as an unnamed row and export as a
-- blank cell, so require the label exactly when the component is `other`.
ALTER TABLE "deal_value_splits"
  DROP CONSTRAINT IF EXISTS "deal_value_splits_other_needs_label";
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ADD CONSTRAINT "deal_value_splits_other_needs_label"
  CHECK (
    "component" <> 'other'
    OR ("component_label" IS NOT NULL AND length(btrim("component_label")) > 0)
  );
