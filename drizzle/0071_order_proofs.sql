-- 0071 — Order confirmation (client PO) on Won deals.
--
-- PROBLEM
-- A deal could be marked Won on the rep's word. Nothing recorded the client's
-- purchase order (or other proof the order was received), and nothing tied the
-- deal value the team typed in to the value the client actually committed to.
--
-- RULE
-- A deal enters Won only when it carries at least one order proof (PO, work
-- order, signed contract …) and the proofs' PRE-TAX value, in the deal's
-- currency, equals the deal value (within ₹1 / one major unit of rounding).
-- While a deal is Won its value can't drift away from its proofs either.
--
-- SHAPE
--   * deal_order_proofs — one row per proof document. The file itself is a
--     deal_documents row (category 'purchase_order'); this row holds what the
--     document says: reference number, date, buyer, pre-tax value, tax, total.
--     `ai_read` keeps what the AI read off the document, so a value the rep
--     corrected stays visible next to the one they submitted.
--   * trg_deal_order_proof_check — the database backstop, same pattern as
--     0060: the server actions check first and give the user a clear message;
--     the trigger makes sure a write path that forgot the rule fails loudly.
--
-- GRANDFATHERING
-- Existing Won deals are left as they are. The trigger fires only when a deal
-- ENTERS Won, or when a Won deal's value or currency changes. The deals list
-- flags Won deals whose proofs are missing or short (filter `po=missing`).
--
-- SCOPE OF THE BACKSTOP
-- The trigger applies to the `app_user` role, which every request drops to
-- (0026). Seed and maintenance scripts that run as the table owner are
-- trusted and not blocked.

ALTER TYPE "deal_document_category" ADD VALUE IF NOT EXISTS 'purchase_order';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deal_order_proofs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "deal_documents"("id") ON DELETE CASCADE,
  "proof_type" text NOT NULL DEFAULT 'purchase_order',
  "reference_no" text NOT NULL,
  "issued_on" date,
  "buyer_name" text,
  "currency" text NOT NULL,
  "subtotal_minor" bigint NOT NULL,
  "tax_minor" bigint NOT NULL DEFAULT 0,
  "total_minor" bigint NOT NULL,
  "ai_read" jsonb,
  "submitted_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "deal_order_proofs_type_check" CHECK (
    "proof_type" IN ('purchase_order', 'work_order', 'signed_contract', 'letter_of_intent', 'email_confirmation', 'other')
  ),
  CONSTRAINT "deal_order_proofs_amounts_check" CHECK (
    "subtotal_minor" > 0 AND "tax_minor" >= 0 AND "total_minor" >= "subtotal_minor"
  ),
  CONSTRAINT "deal_order_proofs_reference_check" CHECK (length(btrim("reference_no")) > 0)
);
--> statement-breakpoint
-- The same PO can't be attached to one deal twice.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_order_proofs_deal_reference_unique"
  ON "deal_order_proofs" ("deal_id", lower(btrim("reference_no")));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_order_proofs_tenant_deal_idx"
  ON "deal_order_proofs" ("tenant_id", "deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_order_proofs_tenant_reference_idx"
  ON "deal_order_proofs" ("tenant_id", lower(btrim("reference_no")));
--> statement-breakpoint

ALTER TABLE "deal_order_proofs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deal_order_proofs_tenant_all" ON "deal_order_proofs"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
-- No UPDATE: a proof says what the document says. A wrong one is removed and
-- submitted again, so the record never quietly changes under a Won deal.
GRANT SELECT, INSERT, DELETE ON "deal_order_proofs" TO "app_user";
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON "deal_order_proofs" FROM "app_user";
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "deal_order_proofs" FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "deal_order_proof_check"() RETURNS trigger AS $$
DECLARE
  v_count integer;
  v_other_currency integer;
  v_sum bigint;
BEGIN
  IF current_user <> 'app_user' THEN
    RETURN NEW;
  END IF;
  IF NEW."stage" <> 'won' OR NEW."deleted_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Already Won and the value didn't change: an unrelated edit, or a legacy
  -- Won deal being touched. Not this rule's business.
  IF TG_OP = 'UPDATE'
     AND OLD."stage" = 'won'
     AND OLD."amount_minor" = NEW."amount_minor"
     AND OLD."currency" = NEW."currency" THEN
    RETURN NEW;
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE "currency" <> NEW."currency"),
    COALESCE(sum("subtotal_minor") FILTER (WHERE "currency" = NEW."currency"), 0)
  INTO v_count, v_other_currency, v_sum
  FROM "deal_order_proofs"
  WHERE "deal_id" = NEW."id";

  IF v_count = 0 OR v_other_currency > 0 OR abs(v_sum - NEW."amount_minor") > 100 THEN
    RAISE EXCEPTION
      'ORDER_PROOF_REQUIRED: deal % at % % has % order proof(s) worth % pre-tax',
      NEW."id", NEW."currency", NEW."amount_minor", v_count, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_deal_order_proof_check" ON "deals";
--> statement-breakpoint
CREATE TRIGGER "trg_deal_order_proof_check"
  BEFORE INSERT OR UPDATE ON "deals"
  FOR EACH ROW EXECUTE FUNCTION "deal_order_proof_check"();
