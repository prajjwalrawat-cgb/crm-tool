-- 0037_link_deal_company_contact.sql
-- Map existing deals' free-text company/contact labels to real records.
-- Idempotent: only touches rows not already linked. Unmatched deals keep
-- their free-text label (the display coalesces to it).

-- Company: match free-text company_name to a company by name (same tenant).
UPDATE deals d
SET company_id = c.id, company_name = NULL
FROM companies c
WHERE d.company_id IS NULL
  AND d.company_name IS NOT NULL
  AND c.tenant_id = d.tenant_id
  AND c.deleted_at IS NULL
  AND lower(c.name) = lower(btrim(d.company_name));
--> statement-breakpoint
-- Contact: match free-text contact_name to a contact by full name or email,
-- preferring one in the deal's (now-linked) company. Clears the free-text
-- contact label + email so the linked contact's own values display.
UPDATE deals d
SET contact_id = ct.id, contact_name = NULL, contact_email = NULL
FROM contacts ct
WHERE d.contact_id IS NULL
  AND d.contact_name IS NOT NULL
  AND ct.tenant_id = d.tenant_id
  AND ct.deleted_at IS NULL
  AND (d.company_id IS NULL OR ct.company_id IS NULL OR ct.company_id = d.company_id)
  AND (
    lower(btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')))
      = lower(btrim(d.contact_name))
    OR lower(ct.email) = lower(btrim(d.contact_name))
  );
