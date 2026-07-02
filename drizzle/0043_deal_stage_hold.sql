-- 0043_deal_stage_hold.sql
-- Add a "hold" stage to the deal pipeline (a paused, non-closed stage).
-- Placed just before 'won' in the enum ordering.
ALTER TYPE "deal_stage" ADD VALUE IF NOT EXISTS 'hold' BEFORE 'won';
