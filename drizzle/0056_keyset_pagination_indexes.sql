-- 0055_keyset_pagination_indexes.sql
-- Performance only. No schema, no data, no behavior change.
--
-- The list pages paginate by keyset — `ORDER BY (created_at, id) DESC` with a
-- `WHERE (created_at, id) < (cursor)` predicate — but the only supporting
-- index was on `(tenant_id)` alone. Postgres therefore read *every* live row
-- for the tenant and top-N sorted it to return 50:
--
--   Index Scan using deals_tenant_id_idx (rows=152)
--     -> Sort (top-N heapsort, 75kB)
--       -> Limit (rows=51)
--
-- That is cheap at 152 rows and linear in tenant size after that. These
-- indexes match the sort order exactly, so the planner can walk the index
-- and stop at 51 rows — constant cost regardless of how large the tenant
-- grows, and the cursor predicate becomes a direct seek.
--
-- All three are partial on `deleted_at IS NULL` because every list query
-- carries that predicate, which also keeps them small.
--
-- CREATE INDEX (non-concurrent) takes a brief ACCESS EXCLUSIVE lock. At the
-- current table sizes that is milliseconds. Swap to CREATE INDEX
-- CONCURRENTLY (outside a transaction) if these tables ever get large.

-- Deals list view: ORDER BY created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS "deals_tenant_created_keyset_idx"
  ON "deals" ("tenant_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- Kanban board + its per-column infinite scroll: one query per stage,
-- ORDER BY updated_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS "deals_tenant_stage_updated_keyset_idx"
  ON "deals" ("tenant_id", "stage", "updated_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- Companies list view: ORDER BY created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS "companies_tenant_created_keyset_idx"
  ON "companies" ("tenant_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- Contacts list view: ORDER BY created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS "contacts_tenant_created_keyset_idx"
  ON "contacts" ("tenant_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
