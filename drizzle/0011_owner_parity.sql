-- Phase: ownership parity.
--
-- Adds `owner_id` to companies + contacts so the operational picker
-- (existing on deals) can extend to all three entity types. Stored as
-- text (Clerk user id) — matches the convention deals already use.
--
-- Indexes mirror the deals_tenant_owner_idx pattern so "My companies"
-- and "Unassigned contacts" filters resolve from a single composite
-- scan.
--
-- No backfill: existing rows stay unassigned (NULL), and the picker
-- exposes "Assign to me" + the teammate dropdown for owners to claim
-- records they create going forward.

ALTER TABLE "companies" ADD COLUMN "owner_id" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "owner_id" text;
--> statement-breakpoint
CREATE INDEX "companies_tenant_owner_idx" ON "companies" USING btree ("tenant_id","owner_id");
--> statement-breakpoint
CREATE INDEX "contacts_tenant_owner_idx" ON "contacts" USING btree ("tenant_id","owner_id");
