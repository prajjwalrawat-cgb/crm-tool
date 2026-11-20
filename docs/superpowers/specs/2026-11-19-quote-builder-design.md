# Quotes with tenant-built formats — design

Date: 2026-11-19
Status: approved 2026-11-20

## Intent

Sales reps in Saleinx have no way to produce a quote today. Proposals live
outside the CRM, and the only generated document is the proforma invoice,
whose layout is hard-coded for every tenant.

Every tenant quotes differently, so each tenant's **own admins** must be able
to design their quote format inside Saleinx. That means a section builder
that is fully customisable within the section types we provide, with a preview
that is exactly what the client will receive. Reps then generate quotes from a
deal in that format.

The longer arc (not this phase): the client approves the quote, and the approved
quote goes to invoicing or finance reads its details by query. This phase keeps
quote data structured (items, tax and totals as rows, not text in a document) so
that later step stays straightforward.

## Goals (phase 1)

1. Tenant admins build one or more quote templates in Settings from typed
   sections, with a live preview that is the real PDF.
2. A rep creates a quote from a deal, edits its content and line items, and
   downloads it as a PDF in the tenant's format.
3. Quotes are versioned (v1, v2…) as negotiation goes back and forth. A sent
   version is frozen.
4. GST is correct for Indian tenants (CGST+SGST vs IGST), reusing the
   invoice logic.

## Non-goals (phase 1, planned for later)

- Client approval or acceptance, e-signature, and a public quote link.
- Converting a quote into a proforma invoice, or pushing it to finance.
- Finance querying quotes (AskMira or an API).
- A price list or catalog pricing. Reps type line-item prices by hand.
- Discount or margin approval.
- Emailing the quote from inside Saleinx. Reps download it and send it themselves.

## Anti-goals (would be a failure even if it works)

- The PDF the client receives differs from what the admin previewed.
- An admin can produce a template that breaks totals or GST, or produces an
  unreadable PDF.
- Editing a template silently changes a quote that was already sent.
- Quote numbers and amounts end up only inside a rendered document where finance
  cannot read them.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Typed sections, configured per tenant. A single renderer, `@react-pdf/renderer`, draws both the builder preview and the downloaded PDF. | The preview is the real PDF and no server infrastructure is needed. Layout freedom is bounded by the section types; new kinds of section are added by us. |
| B | The same sections rendered as HTML, then converted to PDF by headless Chrome on the server. | More styling freedom, but it needs Chromium on the server and is slower, with more ways for the output to drift. This is the fallback if tenants outgrow A. |
| C | A free-form rich-text document with placeholders. | Most freedom, but non-technical admins break it easily, totals and GST are fragile, and the data is not structured for finance. |

We are also not extending the invoice's jsPDF approach. It places every element by
hand at fixed coordinates, so it cannot reasonably draw sections that can be
reordered or configured, and it cannot serve as a live preview.

The user chose A.

## Decided by the user

- Each tenant has its own format, built with a section builder.
- Each tenant's own admins build the format, not the Saleinx team.
- Approach A.
- Phase 1 is quote generation by sales. Approval and finance come later.
- Reps can give an overall discount on the whole quote as well as per-line
  discounts.
- India, INR and GST only for now.

## Design

### Data model (migration `0078_quotes.sql`)

All tables carry `tenant_id`, with RLS policies following the 0075 pattern
(`current_setting('app.tenant_id', true)::uuid`). The migration also needs
`scripts/apply-0078.ts` and an entry in the `build` chain in `package.json`.

**`quote_templates`**
- `id`, `tenant_id`, `name`, `is_default` (at most one per tenant, enforced by a
  partial unique index), `archived_at`.
- `theme jsonb`: font family (from a fixed set), primary and accent colours,
  base font size, page size (A4 or Letter), margins, and the logo source
  (organisation logo, invoice logo, or an uploaded one).
- `sections jsonb`: an ordered array of `{ id, type, enabled, title, settings }`,
  validated by a zod schema per section type. The zod schemas are the single
  source of truth for what a template can contain.
- `updated_by`, `created_at`, `updated_at`.

**`quotes`**
- `id`, `tenant_id`, `deal_id` (FK to deals; a quote always belongs to a deal),
  `quote_number`, `revision` (int, starting at 1), `parent_quote_id` (the
  previous revision), `status` (`draft | sent | superseded`; phase 2 adds
  `accepted | rejected | expired`).
- `template_id` plus `template_snapshot jsonb`: a full copy of the theme and
  sections taken when the quote is created. Later template edits do not touch
  the quote unless the rep re-applies the template while it is a draft.
- `content jsonb`: the quote's own values for its editable sections (text
  blocks, payment schedule rows, terms), keyed by section id.
- `seller_profile_id` (FK to `invoice_seller_profiles`) and `seller jsonb`
  snapshot. `buyer jsonb` and optional `consignee jsonb`, in the same shape as
  invoices, prefilled from the deal's company and contact.
- `quote_date`, `valid_until`, `currency`.
- `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`, recomputed on
  the server on every save.
- `sent_at`, `sent_by`, `pdf_document_id` (FK to `deal_documents`, set when the
  quote is marked sent), `created_by`, `updated_by`, timestamps.
- Unique on `(tenant_id, quote_number, revision)`.

**`quote_items`**
- `quote_id`, `sort_order`, `description`, `hsn_sac`, `unit`, `quantity`,
  `rate_minor`, `discount_bps`, `tax_rate_bps`, `amount_minor` (after discount,
  before tax), optional `offering_id` (FK to `offerings`; a label only, with no
  price lookup), and optional `group_label` for grouped tables
  (e.g. "Licences", "Implementation").

**`quote_settings`** (one row per tenant)
- Number format: prefix, an optional financial-year token, and padding. For
  example `Q/2026-27/0042`.
- Counters live in **`quote_number_sequences`**, keyed by
  `(tenant_id, fiscal_year)`. The fiscal year comes from the tenant's fiscal
  year start month, and the counter restarts at 1 each fiscal year when the
  format uses the FY token. A format without the token uses a single row.
- The number is allocated when the draft is created, with a row lock inside the
  insert transaction, so abandoned drafts leave gaps. That is acceptable for
  quotes, which are not tax documents. Revisions keep the number and show as
  "Rev 2".
- Default validity in days, and the default template.

### Section types (phase 1)

Each type has a renderer for the PDF and a settings form for the builder.

| Type | Admin configures | Rep fills in |
|---|---|---|
| Header | logo position and size, which seller fields show, title text ("Quotation" / "Proposal"), meta fields shown (number, date, validity, rep name) | nothing |
| Client block | bill-to and ship-to visibility, field labels | can edit the prefilled buyer details |
| Text block (repeatable) | heading, default rich text (bold, italic, lists, headings), and whether reps may edit it | the content, if editable |
| Line items | columns shown, column order, renamed headings, show HSN/SAC, show per-line discount, group rows by label, show item images (later) | the items |
| Totals | which rows show (subtotal, discount, the tax breakdown CGST/SGST/IGST, round-off), amount in words | nothing (computed) |
| Payment schedule | default milestones (label and %) | can adjust milestones |
| Terms and conditions | default terms text | can edit |
| Custom fields | which deal custom fields to show, and their labels | nothing (read from the deal) |
| Signature / acceptance | the seller signatory name and title, and a client acceptance box | nothing |
| Page break | none | none |

Placeholders in text blocks: a small fixed set (`{{client.name}}`,
`{{deal.name}}`, `{{rep.name}}`, `{{quote.valid_until}}`, …) chosen from a
picker. Unknown tokens are rejected when the template is saved.

### Rendering

- `@react-pdf/renderer` (pin an exact version that supports React 19 and works
  with this Next version, which is to be verified against
  `node_modules/next/dist/docs/` per AGENTS.md).
- One set of components, `QuoteDocument({ template, quote, mode })`, used for:
  - the builder preview, with sample data, rendered in the browser;
  - the rep's preview, with real data;
  - the downloaded PDF.
- Fonts come from a fixed bundled set (for example Noto Sans, Inter and Roboto),
  each registered with a ₹ glyph. Admins cannot upload fonts in phase 1.
- When a quote is marked sent, the PDF is generated **on the server** from the
  stored quote, using the same components, so the filed copy cannot differ
  from the saved numbers. It is uploaded to the `deal-documents` bucket and
  recorded as a `deal_documents` row with category `proposal`. That frozen file
  is the sent version. `deleteDealDocumentAction` must refuse to delete a
  document referenced by `quotes.pdf_document_id`, the same way it protects
  order-proof files. Browser rendering is used only for the previews and for
  draft downloads.

### Screens

- **Settings → Quote templates** (admin): a list of templates with
  duplicate, archive and set-default actions. The editor is three panes:
  - left: the sections list, which is drag-reorderable, with on/off toggles and
    an "Add section" menu;
  - middle: the selected section's settings, plus theme settings;
  - right: the live PDF preview, debounced.
  - Saves are explicit. Validation errors appear on the offending section.
- **Settings → Quotes**: number format, default validity, default template.
- **Deal page → Quotes card**: lists the deal's quotes and revisions with their
  status and total, and has a **New quote** button (pick a template; it defaults
  to the tenant default).
- **Quote editor** (`/dashboard/quotes/[id]`): the editable sections on the left,
  the PDF preview on the right. The line-items table is edited inline. Actions:
  Save, Download PDF, Mark as sent (which freezes it), and New revision (copies
  the quote to Rev n+1 and marks the old one superseded).
- **Quotes list** (`/dashboard/quotes`): all quotes the user can see, filtered by
  status, rep and date.

### Permissions (`src/lib/rbac.ts`)

- `manageQuoteTemplates`: owner and admin. It covers templates and quote
  settings.
- `manageQuotes`: owner, admin, manager and member. It means creating and editing
  quotes on deals the user can see, and it follows the existing deal visibility
  rules.
- Viewers can read quotes and download them.

### GST and money

- Reuse `src/lib/invoices/gst.ts` for the intra- or inter-state split and
  `money.ts` for minor-unit arithmetic.
- Tax applies per line (`tax_rate_bps`), because quotes often mix goods and
  services. Totals group the tax by rate.
- A line amount is `round(qty × rate × (1 − line discount))`, worked out in
  minor units.
- **Overall discount (user decision).** A rep may also give a discount on the
  whole quote, as a flat amount or a percentage. It is stored on `quotes` as
  `overall_discount_type` (`none | amount | percent`) and
  `overall_discount_value`.
  - The discount is spread across the lines in proportion to their amounts,
    **before** tax. Any rounding remainder goes to the largest line.
  - Each line's taxable value is its amount minus its share of the discount, and
    GST is worked out on that taxable value.
  - `discount_minor` holds the total discount: the line discounts plus the
    overall discount. The Totals section can show it as one row or as two.
  - Each line's allocated share is stored as `quote_items.allocated_discount_minor`
    so that the later invoice step can carry it across exactly.
- All totals are computed on the server; the client-side values are for display
  only.
- **India and INR only for now (user decision).** Every quote is in INR with
  GST, and there is no per-quote currency or generic tax mode. Keep the
  `currency` column so that other currencies can be added later without a
  migration.

## Calls I made (correct any of these)

1. Multiple templates per tenant, with one default. For example, a tenant may
   use different formats for products and for services.
2. Quotes always belong to a deal. There are no standalone quotes.
3. Versions use the same number with "Rev n", and a sent version is frozen.
4. Tax rates are per line, unlike invoices, which use one rate per invoice. The
   future quote-to-invoice step will need to handle that, either by extending
   invoices to per-line rates or by restricting conversion.
5. Creating a quote does not change the deal's amount. A button, "Set deal
   value from this quote", lets the rep update it on purpose.
6. Sending happens outside Saleinx in phase 1. "Mark as sent" freezes the quote
   and files the PDF on the deal.
7. Fonts come from a fixed set. There are no custom uploads.
8. Prices are typed by hand. An offering can be attached to a line as a label.
9. The "sent" PDF is rendered on the server and protected from deletion, so the
   filed copy always matches the stored figures.
10. Quote numbers restart each fiscal year when the format includes the FY token.
    A draft gets its number when it is created, so gaps from abandoned drafts
    are accepted.

## Left to the builder

- Component structure, the choice of drag-and-drop library, and the
  rich-text editor (keep its output to a small, serialisable subset that
  react-pdf can render).
- Exact zod shapes for each section's settings.
- Sample data for the builder preview.
- How the preview debounce works, and how browser rendering performance is
  handled.
- The test approach. Tests run against the Docker test DB (`crm-test-pg` on
  port 15434, via `.env.local`), never against `.env`.
