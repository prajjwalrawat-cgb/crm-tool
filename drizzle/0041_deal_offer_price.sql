-- 0041_deal_offer_price.sql
-- Optional "Offer Price" on deals: a separate quoted/offered figure that is
-- independent of Amount. Stored as integer minor units; NULL = not set.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "offer_price_minor" bigint;
