-- 0044_deal_lost_reason.sql
-- Capture WHY a deal was lost. Free text; NULL when the deal isn't lost.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "lost_reason" text;
