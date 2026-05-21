-- Phase 17-A: introduce the 'manager' membership role.
--
-- Two-layer model: role authorizes (RBAC), persona experiences
-- (sidebar / dashboard / AI). Personas derive from role:
--   owner + admin → 'admin' persona
--   manager       → 'manager' persona  (NEW)
--   member + viewer → 'sales' persona
--
-- ALTER TYPE ADD VALUE is the standard Postgres pattern for extending
-- an enum without rewriting existing rows. Idempotent — re-running is
-- a no-op once the value is present.

ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'manager';
