-- 0080_quotes_optional_deal.sql
--
-- Quotes are created from the Quotes module and may be linked to a deal or
-- stand alone ("No deal"). quotes.deal_id becomes nullable; the FK (ON DELETE
-- CASCADE) and the (tenant_id, deal_id) index are unchanged.
--
-- Idempotent: safe to replay on every deploy.

ALTER TABLE "quotes" ALTER COLUMN "deal_id" DROP NOT NULL;
