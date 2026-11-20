# Quote Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tenant admins design their own quote formats from typed sections. Reps generate versioned, GST-correct quotes from a deal and download them as PDFs that match the preview exactly.

**Architecture:**
- **Data and logic.** New tenant tables live in migration `0078`. Pure modules in `src/lib/quotes/` hold the template schema, the money maths and the numbering. A query layer sits on `tenantTransaction`, and thin server actions follow the `src/lib/invoices/actions.ts` pattern.
- **Rendering.** One `@react-pdf/renderer` component tree, `QuoteDocument`, renders the builder preview, the rep preview and the downloaded PDF in the browser, and renders the frozen "sent" PDF on the server.

**Tech Stack:**
- Next 16.2.4 (read `node_modules/next/dist/docs/` before writing route, action or config code — see AGENTS.md)
- React 19.2.4
- Drizzle + Postgres with RLS
- zod
- `@react-pdf/renderer`
- `@dnd-kit/sortable` (already installed)
- `@tiptap/react` + `@tiptap/starter-kit` (already installed)
- Supabase Storage
- Tests are `tsx` self-test scripts, following the pattern in `scripts/selftest-offerings.ts`

**Spec:** `docs/superpowers/specs/2026-11-19-quote-builder-design.md`

## Global Constraints

- **INR and GST only.** Every quote's `currency` is `'INR'`. Keep the column, but nothing in the UI changes it.
- **Money format.** All money is integer minor units (paise). Rates and discounts are integer basis points (bps): 1800 bps means 18%. No floats are stored.
- **Server totals are the truth.** The server recomputes totals on every save. Values computed in the browser are for display only.
- **RLS on every new table.** Each new table has `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, with ENABLE and FORCE row-level security and the four `_tenant_select/insert/update/delete` policies plus `GRANT … TO app_user`, copied from the loop in `drizzle/0077_ai_suggestions.sql`.
- **Migration wiring.** `scripts/apply-0078.ts` is a copy of `apply-0077.ts` with the marker hash `'manual-0078-quotes'`. It goes into the `build` chain in `package.json` right after `apply-0077.ts`.
- **Test database only.** Tests run against the Docker test DB (`crm-test-pg` on port 15434, reached through `.env.local`). Never point a test or a migration at `.env` — that database is production.
- **Permissions.**
  - `manageQuoteTemplates` = `['owner','admin']`.
  - `manageQuotes` = `['owner','admin','manager','member']`.
  - Viewers can read and download quotes.
  - Quote access is tenant-wide, the same as `getDealById` (which has no owner restriction).
- **Statuses.** `quote_status` enum is `draft | sent | superseded`.
- **Fonts.** A fixed set of three: `noto-sans` (the default), `inter` and `roboto`. Each ships Regular and Bold TTFs that contain the ₹ glyph.
- **GST rates.** Any `tax_rate_bps` from 0 to 4000 is allowed. The UI suggests 0, 25, 300, 500, 1800 and 4000 (the post-September-2025 slabs).

## Review Focus

1. **A rep saves a quote that is already sent**, from a stale tab or a second tab. The save is rejected with "This quote was sent and is locked. Create a revision to change it." The quote is unchanged. *(Task 5 test)*
2. **An admin edits or archives a template after quotes were made from it.** Existing quotes keep rendering from their snapshot, unchanged. *(Task 5 test)*
3. **Two reps create quotes at the same moment.** They get distinct, consecutive numbers. *(Task 4 test)*
4. **The overall discount is at least the discounted subtotal** (or is 100%). A larger amount is rejected with a clear error. Exactly 100% gives zero taxable value and zero tax, never a negative number. *(Task 2 test)*
5. **A placeholder has no value**, for example a deal with no contact. It renders as an empty string, never as a literal `{{client.contact}}`. *(Task 3 test)*

---

### Task 1: Migration 0078 and Drizzle schema

**Files:**
- Create: `drizzle/0078_quotes.sql`, `scripts/apply-0078.ts`, `src/db/schema/quotes.ts`
- Modify: `src/db/schema/index.ts` (export the new tables), `src/db/schema/enums.ts` (`quoteStatus`), `package.json` (`build` chain; add `"selftest:quotes-db"`)
- Test: `scripts/selftest-quotes-db.ts` (created here; extended in Tasks 4, 5 and 8)

**Interfaces:**
- **Produces Drizzle tables:**
  - `quoteSettings`
  - `quoteNumberSequences`
  - `quoteTemplates`
  - `quotes`
  - `quoteItems`
- **Produces types:** `QuoteRow` and `QuoteItemRow` (from `$inferSelect`).

**Tables and columns**

`quote_settings` (PK `tenant_id`)

| Column | Type and default |
|---|---|
| `number_prefix` | `text`, default `'Q'` |
| `number_separator` | `text`, default `'/'` |
| `number_include_fy` | `bool`, default `true` |
| `number_padding` | `smallint`, default `4`, CHECK 1–8 |
| `default_validity_days` | `int`, default `30`, CHECK 1–365 |
| `updated_by` | `text` |
| `updated_at` | `timestamptz` |

The tenant's default template is held by `quote_templates.is_default`. The spec also mentioned a default-template setting; there is deliberately no column for it here, so there is only one source of truth.

`quote_number_sequences`

| Column | Type and default |
|---|---|
| `tenant_id` | |
| `fiscal_year` | `text` — `''` when the number format has no FY token |
| `last_value` | `int`, NOT NULL |

- PK `(tenant_id, fiscal_year)`.

`quote_templates`

| Column | Type and default |
|---|---|
| `id` | uuid |
| `tenant_id` | |
| `name` | `text` NOT NULL |
| `is_default` | `bool`, default `false` |
| `body` | `jsonb` NOT NULL — `{ theme, sections }` |
| `archived_at` | `timestamptz` |
| `updated_by` | `text` |
| `created_at`, `updated_at` | timestamps |

- Partial unique index on `(tenant_id) WHERE is_default AND archived_at IS NULL`.
- The spec described `theme` and `sections` as two jsonb columns. The plan stores them in one `body` column, validated as a unit by `quoteTemplateBodySchema`.

`quotes`

| Column | Type and default |
|---|---|
| `id` | uuid |
| `tenant_id` | |
| `deal_id` | uuid NOT NULL, FK to deals, `ON DELETE CASCADE` |
| `quote_number` | `text` NOT NULL |
| `revision` | `int` NOT NULL, default `1` |
| `parent_quote_id` | uuid, FK to quotes |
| `status` | `quote_status`, default `'draft'` |
| `template_id` | uuid, FK to quote_templates, `ON DELETE SET NULL` |
| `template_snapshot` | `jsonb` NOT NULL |
| `content` | `jsonb` NOT NULL, default `'{}'` |
| `seller_profile_id` | uuid, FK to invoice_seller_profiles, `ON DELETE SET NULL` |
| `seller`, `buyer` | `jsonb` NOT NULL |
| `consignee` | `jsonb` |
| `quote_date` | `date` NOT NULL |
| `valid_until` | `date` NOT NULL |
| `currency` | `text`, default `'INR'` |
| `overall_discount_type` | `text`, CHECK in (`none`, `amount`, `percent`), default `'none'` |
| `overall_discount_value` | `bigint`, default `0` |
| `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor` | `bigint`, default `0` |
| `sent_at` | `timestamptz` |
| `sent_by` | `text` |
| `pdf_document_id` | uuid, FK to deal_documents, `ON DELETE RESTRICT` |
| `created_by`, `updated_by` | `text` |
| `created_at`, `updated_at` | timestamps |

- UNIQUE `(tenant_id, quote_number, revision)`.
- Index on `(tenant_id, deal_id)`.
- `overall_discount_value` holds minor units when the type is `amount`, and bps when it is `percent`.

`quote_items`

| Column | Type and default |
|---|---|
| `id` | uuid |
| `tenant_id` | |
| `quote_id` | FK to quotes, `ON DELETE CASCADE` |
| `sort_order` | `int` |
| `description` | `text` NOT NULL |
| `hsn_sac` | `text` |
| `unit` | `text` |
| `quantity` | `numeric(14,3)` NOT NULL |
| `rate_minor` | `bigint` NOT NULL |
| `discount_bps` | `int`, default `0`, CHECK 0–10000 |
| `tax_rate_bps` | `int`, default `0`, CHECK 0–4000 |
| `amount_minor` | `bigint` NOT NULL |
| `allocated_discount_minor` | `bigint`, default `0` |
| `tax_minor` | `bigint`, default `0` |
| `offering_id` | uuid, FK to offerings, `ON DELETE SET NULL` |
| `group_label` | `text` |

- [ ] **Step 1: Write the failing test.** In `scripts/selftest-quotes-db.ts`:
  - Copy the harness from `scripts/selftest-offerings.ts`: `check`, `report`, skip when `DATABASE_URL` is unset, and create two throwaway tenants with slugs `zz-selftest-quotes-a` and `zz-selftest-quotes-b`, deleted in `finally`.
  - Add the check `'RLS: tenant B cannot see tenant A quote_templates'`. Insert a template row under A with `runWithSystemContext(A)`, then select it under `runWithSystemContext(B)` and expect 0 rows.
- [ ] **Step 2: Run the test and confirm it fails.**
  - Run: `pnpm selftest:quotes-db`
  - Expected: FAIL with `relation "quote_templates" does not exist`.
- [ ] **Step 3: Write the SQL migration, the apply script, the Drizzle schema and the `build` chain entry.**
  - The SQL is idempotent: `CREATE TABLE IF NOT EXISTS`, and the `DO $$ … duplicate_object` guard for the enum.
- [ ] **Step 4: Apply and run.**
  - Run: `pnpm tsx scripts/apply-0078.ts && pnpm tsx scripts/apply-0078.ts`. The second run must print "already exists, skipping" or "ok" with no failure.
  - Then run `pnpm selftest:quotes-db`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add drizzle/0078_quotes.sql scripts/apply-0078.ts src/db/schema package.json scripts/selftest-quotes-db.ts
  git commit -m "feat(quotes): 0078 schema for quote templates, quotes and numbering"
  ```

---

### Task 2: Quote totals (money maths)

**Files:**
- Create: `src/lib/quotes/totals.ts`
- Test: `scripts/selftest-quotes.ts` (pure; also add a `"selftest:quotes"` script, and append it to the `selftest` chain in Task 11)

**Interfaces:**
- **Produces:**
  ```ts
  export type QuoteLineInput = { quantity: number; rateMinor: number; discountBps: number; taxRateBps: number };
  export type OverallDiscount = { type: 'none' } | { type: 'amount'; valueMinor: number } | { type: 'percent'; bps: number };
  export type QuoteLineTotals = { grossMinor: number; lineDiscountMinor: number; amountMinor: number; allocatedDiscountMinor: number; taxableMinor: number; taxMinor: number };
  export type TaxGroup = { rateBps: number; taxableMinor: number; taxMinor: number };
  export type QuoteTotals = { lines: QuoteLineTotals[]; subtotalMinor: number; lineDiscountMinor: number; overallDiscountMinor: number; discountMinor: number; taxableMinor: number; taxGroups: TaxGroup[]; taxMinor: number; totalMinor: number };
  export class QuoteTotalsError extends Error { code: 'discount_exceeds_subtotal' | 'invalid_input' }
  export function computeQuoteTotals(lines: QuoteLineInput[], overall: OverallDiscount): QuoteTotals;
  ```

**Rules:**
- **Line amounts.**
  - `gross = round(qty × rate)`
  - `lineDiscount = round(gross × discountBps / 10000)`
  - `amount = gross − lineDiscount`
- **Overall discount.**
  - Amount form: the `valueMinor` given.
  - Percent form: `round(Σamount × bps / 10000)`.
  - Spread it across lines with `floor(overall × amount_i / Σamount)`. The remainder goes to the line with the largest amount (the first one on a tie).
  - A line whose amount is zero gets nothing.
- **Tax.**
  - `taxable_i = amount_i − allocated_i`
  - `tax_i = round(taxable_i × taxRateBps / 10000)`
  - `taxGroups` aggregates by `rateBps`, in ascending order, and skips rates whose taxable value is zero.
- **Totals.**
  - `subtotal = Σgross`
  - `discount = ΣlineDiscount + overall`
  - `total = Σtaxable + Σtax`
- **Errors.**
  - An overall discount greater than `Σamount` throws `discount_exceeds_subtotal`.
  - A negative qty or rate, or bps outside its range, throws `invalid_input`.

- [ ] **Step 1: Write the failing tests** in `scripts/selftest-quotes.ts`:
  ```ts
  const A = { quantity: 2, rateMinor: 50_000, discountBps: 0, taxRateBps: 1800 };
  const B = { quantity: 1, rateMinor: 100_000, discountBps: 1000, taxRateBps: 500 };
  const t = computeQuoteTotals([A, B], { type: 'amount', valueMinor: 19_000 });
  check('subtotal is gross', t.subtotalMinor === 200_000);
  check('allocation proportional', t.lines[0].allocatedDiscountMinor === 10_000 && t.lines[1].allocatedDiscountMinor === 9_000);
  check('discount = line + overall', t.discountMinor === 29_000);
  check('tax per line', t.lines[0].taxMinor === 16_200 && t.lines[1].taxMinor === 4_050);
  check('tax groups ascending', JSON.stringify(t.taxGroups.map(g => g.rateBps)) === '[500,1800]');
  check('total', t.totalMinor === 171_000 + 20_250);
  const r = computeQuoteTotals([1,2,3].map(() => ({ quantity: 1, rateMinor: 10_000, discountBps: 0, taxRateBps: 0 })), { type: 'amount', valueMinor: 100 });
  check('remainder to first-largest', r.lines.map(l => l.allocatedDiscountMinor).join() === '34,33,33');
  check('percent overall', computeQuoteTotals([A, B], { type: 'percent', bps: 500 }).overallDiscountMinor === 9_500);
  check('100% overall → zero tax, not negative', (() => { const z = computeQuoteTotals([A], { type: 'percent', bps: 10000 }); return z.taxMinor === 0 && z.totalMinor === 0; })());
  check('overall > subtotal throws', throwsCode(() => computeQuoteTotals([A], { type: 'amount', valueMinor: 100_001 }), 'discount_exceeds_subtotal'));
  check('fractional qty rounds', computeQuoteTotals([{ quantity: 1.333, rateMinor: 999, discountBps: 0, taxRateBps: 0 }], { type: 'none' }).subtotalMinor === 1332);
  check('empty quote is all zeros', computeQuoteTotals([], { type: 'none' }).totalMinor === 0);
  ```
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `pnpm tsx scripts/selftest-quotes.ts`
  - Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement `computeQuoteTotals`** in `src/lib/quotes/totals.ts`, following the rules above.
- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `pnpm tsx scripts/selftest-quotes.ts`
  - Expected: all PASS.
- [ ] **Step 5: Commit** with the message `feat(quotes): totals with per-line GST and overall discount allocation`.

---

### Task 3: Template schema, rich text and placeholders

**Files:**
- Create:
  - `src/lib/quotes/template-schema.ts`
  - `src/lib/quotes/rich-text.ts`
  - `src/lib/quotes/default-template.ts`
- Test: `scripts/selftest-quotes.ts`

**Interfaces:**
- **Produces from `rich-text.ts`:**
  - `RichTextDoc`: TipTap JSON restricted to the nodes `doc, paragraph, heading(level 2|3), bulletList, orderedList, listItem, text, hardBreak, placeholder` and the marks `bold, italic`.
  - `richTextDocSchema` (zod)
  - `richTextFromPlain(s: string): RichTextDoc`
- **Produces from `template-schema.ts`:**
  ```ts
  export const SECTION_TYPES = ['header','client','text','line_items','totals','payment_schedule','terms','custom_fields','signature','page_break'] as const;
  export const PLACEHOLDERS = ['client.name','client.contact','client.gstin','deal.name','rep.name','rep.email','quote.number','quote.date','quote.valid_until','seller.name'] as const;
  export type Placeholder = typeof PLACEHOLDERS[number];
  export const quoteThemeSchema;   // { fontFamily: 'noto-sans'|'inter'|'roboto'; primaryColor: /^#[0-9a-f]{6}$/i; accentColor: same; baseFontSize: 8..12; pageSize: 'A4'|'LETTER'; marginsMm: 10..30; logoSource: 'org'|'invoice'|'none' }
  export const quoteSectionSchema; // z.discriminatedUnion('type', [...]); every member has { id: string; type; enabled: boolean; title: string } plus settings
  export const quoteTemplateBodySchema; // { theme, sections } with the superRefine rules below
  export type QuoteTheme; export type QuoteSection; export type QuoteTemplateBody;
  export type SectionContent = { text?: RichTextDoc; milestones?: { label: string; percentBps: number }[]; terms?: RichTextDoc };
  export type QuoteContent = Record<string /* section id */, SectionContent>;
  export function findUnknownPlaceholders(doc: RichTextDoc): string[];
  export function resolvePlaceholders(doc: RichTextDoc, values: Partial<Record<Placeholder, string | null>>): RichTextDoc;
  export function defaultContentFor(body: QuoteTemplateBody): QuoteContent;
  export function mergeContentForTemplate(body: QuoteTemplateBody, previous: QuoteContent): QuoteContent; // keep matching ids, defaults for new ones
  ```
- **Produces from `default-template.ts`:** `defaultTemplateBody(): QuoteTemplateBody`. It contains every section type in this order: header, client, text ("Introduction"), line_items, totals, payment_schedule, terms, signature.

**Per-type settings** (copied from the spec's section table):
- **header:** `logoPosition: 'left'|'right'|'center'`, `logoHeightMm: 8..40`, `titleText`, `showSellerFields: ('gstin'|'pan'|'address'|'email'|'phone')[]`, `metaFields: ('number'|'date'|'valid_until'|'rep')[]`
- **client:** `showShipTo: boolean`, `billToLabel`, `shipToLabel`
- **text:** `defaultText: RichTextDoc`, `repEditable: boolean`
- **line_items:** `columns: { key: 'sno'|'description'|'hsn_sac'|'unit'|'quantity'|'rate'|'discount'|'tax_rate'|'amount'; label: string; visible: boolean }[]` (order = display order; `description` and `amount` must stay visible), `groupByLabel: boolean`
- **totals:** `showSubtotal`, `discountDisplay: 'combined'|'split'|'hidden'`, `showTaxBreakdown`, `showRoundOff`, `showAmountInWords`
- **payment_schedule:** `defaultMilestones: { label, percentBps }[]`, `repEditable`
- **terms:** `defaultText`, `repEditable`
- **custom_fields:** `fields: { key: string; label: string }[]`
- **signature:** `signatoryName`, `signatoryTitle`, `showClientAcceptance`
- **page_break:** no settings

**Body rules** (`superRefine`, each with a message on the offending section's path):
- Section ids are unique.
- There is exactly one `line_items` section and exactly one `totals` section. Both are enabled, and `totals` comes after `line_items`.
- Every text and terms default contains no unknown placeholders.
- Milestones in every payment schedule sum to 10000 bps.

- [ ] **Step 1: Write the failing tests.**
  - `defaultTemplateBody()` parses.
  - A body with a duplicate id is rejected.
  - A body with no `totals` section is rejected.
  - A disabled `line_items` section is rejected.
  - Milestones summing to 9000 bps are rejected.
  - A default containing `{{deal.amount}}` is rejected, and the error message contains `deal.amount`.
  - `resolvePlaceholders` turns `{{client.name}}` into `'Acme'` and `{{client.contact}}` with a `null` value into `''`. The text of the output contains no `{{`.
  - `mergeContentForTemplate` keeps the edited text for a section id that still exists, drops removed ids, and adds defaults for new ids.
- [ ] **Step 2: Run them and confirm they fail** (`pnpm tsx scripts/selftest-quotes.ts`).
- [ ] **Step 3: Implement the three modules.**
  - Placeholders are a custom inline TipTap node `{ type: 'placeholder', attrs: { key } }`, not raw `{{…}}` text.
  - `findUnknownPlaceholders` checks both those nodes and any leftover `{{x}}` text.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** with the message `feat(quotes): template section schema, rich text and placeholders`.

---

### Task 4: Quote numbering

**Files:**
- Create: `src/lib/quotes/numbering.ts`
- Test: `scripts/selftest-quotes.ts` (pure parts) and `scripts/selftest-quotes-db.ts` (allocation)

**Interfaces:**
- **Produces:**
  ```ts
  export type QuoteNumberFormat = { prefix: string; separator: string; includeFiscalYear: boolean; padding: number };
  export function fiscalYearLabel(isoDate: string, startMonth: number): string; // startMonth 1 → '2026'; else '2026-27'
  export function formatQuoteNumber(fmt: QuoteNumberFormat, fyLabel: string | null, seq: number): string;
  export async function allocateQuoteNumber(tx: DbExecutor, tenantId: string, quoteDate: string): Promise<string>;
  ```
- **How `allocateQuoteNumber` works:**
  - It reads `quote_settings` (defaults apply if there is no row) and `organization_settings.fiscal_year_start_month`.
  - It then runs `INSERT INTO quote_number_sequences … VALUES (tenant, fy, 1) ON CONFLICT (tenant_id, fiscal_year) DO UPDATE SET last_value = quote_number_sequences.last_value + 1 RETURNING last_value`.
  - `fy` is `''` when `includeFiscalYear` is false.

- [ ] **Step 1: Write the failing tests.**
  - **Pure tests:**
    - `fiscalYearLabel('2026-11-20',4) === '2026-27'`
    - `fiscalYearLabel('2027-03-31',4) === '2026-27'`
    - `fiscalYearLabel('2027-04-01',4) === '2027-28'`
    - `fiscalYearLabel('2026-11-20',1) === '2026'`
    - `formatQuoteNumber({prefix:'Q',separator:'/',includeFiscalYear:true,padding:4},'2026-27',42) === 'Q/2026-27/0042'`
    - The same call with the FY off gives `'Q/0042'`.
  - **DB tests:**
    - Five concurrent `allocateQuoteNumber` calls for one tenant (each in its own `tenantTransaction`, run with `Promise.all`) return five distinct numbers ending `0001`–`0005`.
    - A date in the next fiscal year restarts at `0001`.
    - Tenant B's first number is `0001`, whatever tenant A has issued.
- [ ] **Step 2: Run them and confirm they fail** (`pnpm tsx scripts/selftest-quotes.ts`; `pnpm selftest:quotes-db`).
- [ ] **Step 3: Implement `numbering.ts`.**
- [ ] **Step 4: Run both test scripts and confirm they pass.**
- [ ] **Step 5: Commit** with the message `feat(quotes): per-fiscal-year quote numbering`.

---

### Task 5: Quote and template data layer

**Files:**
- Create:
  - `src/lib/quotes/queries.ts`
  - `src/lib/quotes/schema.ts` (zod for the inputs)
  - `src/lib/quotes/types.ts`
- Test: `scripts/selftest-quotes-db.ts`

**Interfaces:**
- **Consumes:**
  - Task 2 `computeQuoteTotals`
  - Task 3 `quoteTemplateBodySchema`, `defaultTemplateBody`, `defaultContentFor`, `mergeContentForTemplate`
  - Task 4 `allocateQuoteNumber`
  - `listSellerProfiles` (`src/lib/invoices/seller-profiles.ts`)
  - `PdfParty` and `PdfSeller` (`src/lib/invoices/types.ts`) as the shapes of `buyer` and `seller`
- **Produces from `schema.ts`:**
  - `quoteDraftInputSchema`, which accepts:
    - `quoteDate` and `validUntil` (ISO dates, with `validUntil >= quoteDate`)
    - `sellerProfileId`
    - `buyer: PdfParty`
    - `consignee: PdfParty | null`
    - `items` (1–200 of `{ description (1..2000 chars), hsnSac?, unit?, quantity (>0, ≤3dp), rateMinor (int ≥0), discountBps (0..10000), taxRateBps (0..4000), offeringId?, groupLabel? }`)
    - `overallDiscount: OverallDiscount`
    - `content: QuoteContent`
  - `quoteSettingsInputSchema`
- **Produces from `types.ts`:**
  - `QuoteDetail`: the row, plus `items` (with each line's totals), plus `totals: QuoteTotals`.
  - `QuoteListItem`: `{ id, quoteNumber, revision, status, dealId, dealName, companyName, totalMinor, createdBy, createdAt, sentAt }`.
- **Produces from `queries.ts`** (every function runs inside `tenantTransaction`):
  ```ts
  export class QuoteFrozenError extends Error {}      // message: 'This quote was sent and is locked. Create a revision to change it.'
  export class QuoteNotFoundError extends Error {}
  export async function ensureStarterTemplate(tenantId: string, userId: string): Promise<void>; // creates 'Standard quotation' (is_default) when the tenant has no templates
  export async function listQuoteTemplates(tenantId: string, opts?: { includeArchived?: boolean }): Promise<QuoteTemplateRow[]>;
  export async function getQuoteTemplate(tenantId: string, id: string): Promise<QuoteTemplateRow | null>;
  export async function saveQuoteTemplate(tenantId: string, userId: string, input: { id?: string; name: string; body: unknown }): Promise<{ id: string }>; // parses body; throws ZodError
  export async function duplicateQuoteTemplate(tenantId: string, userId: string, id: string): Promise<{ id: string }>;
  export async function setDefaultQuoteTemplate(tenantId: string, id: string): Promise<void>;
  export async function archiveQuoteTemplate(tenantId: string, id: string): Promise<void>; // refuses the current default
  export async function getQuoteSettings(tenantId: string): Promise<QuoteSettings>;
  export async function saveQuoteSettings(tenantId: string, userId: string, input: QuoteSettingsInput): Promise<void>;
  export async function createQuoteFromDeal(tenantId: string, userId: string, input: { dealId: string; templateId?: string }): Promise<{ id: string; quoteNumber: string }>;
  export async function getQuote(tenantId: string, id: string): Promise<QuoteDetail | null>;
  export async function updateQuoteDraft(tenantId: string, userId: string, id: string, input: QuoteDraftInput): Promise<QuoteDetail>;
  export async function reapplyTemplate(tenantId: string, userId: string, id: string, templateId?: string): Promise<void>; // draft only
  export async function createQuoteRevision(tenantId: string, userId: string, id: string): Promise<{ id: string }>;
  export async function listQuotesForDeal(tenantId: string, dealId: string): Promise<QuoteListItem[]>;
  export async function listQuotes(tenantId: string, f: { status?: QuoteStatus; createdBy?: string; from?: string; to?: string; cursor?: string; limit?: number }): Promise<{ rows: QuoteListItem[]; nextCursor: string | null }>;
  export async function setDealAmountFromQuote(tenantId: string, userId: string, quoteId: string): Promise<void>;
  ```

**Behaviour the tests pin:**
- **`createQuoteFromDeal`:**
  - Reads the deal under the tenant and throws `QuoteNotFoundError` if it isn't found, which covers cross-tenant ids.
  - Calls `ensureStarterTemplate`.
  - Uses the given template or the default one.
  - Snapshots `body` into `template_snapshot` and sets `content = defaultContentFor(body)`.
  - Prefills `buyer` from the deal's company (name, address, GSTIN — whatever `companies` holds, mapped onto `PdfParty`) and the contact's name and email.
  - Takes the seller from the first seller profile. If the tenant has none, it falls back to the `organization_settings` invoice seller fields.
  - Sets `quote_date` to today (IST), `valid_until` to `quote_date + default_validity_days`, and starts with zero items.
- **`updateQuoteDraft`:**
  - Locks the row with `FOR UPDATE` and throws `QuoteFrozenError` unless its status is `draft`.
  - Replaces all items.
  - Recomputes totals with `computeQuoteTotals` and stores each line's `amount_minor`, `allocated_discount_minor` and `tax_minor`, plus the header totals.
  - Maps a `QuoteTotalsError` to a zod-style field error on `overallDiscount`.
- **`createQuoteRevision`:**
  - Allowed only from a `sent` quote that has no newer revision.
  - Copies the snapshot, content and items, sets the same `quote_number`, `revision + 1`, `parent_quote_id`, and `status` `draft`.
  - Marks the source quote `superseded`.
  - A sent quote stays immutable apart from that status flip.
- **`setDealAmountFromQuote`:**
  - Sets the deal's `amount_minor` to the quote's taxable value (`subtotal − discount`).
  - Goes through the same lib function that `patchDealAction` uses (in `src/app/dashboard/deals/actions.ts`), so the audit log and governance triggers fire. Extract a lib function if the action has the logic inline.

- [ ] **Step 1: Write the failing DB tests:**
  - `createQuoteFromDeal` on tenant A's deal makes a draft with number `Q/<fy>/0001`, revision 1, a buyer name equal to the company name, and a starter template that `is_default`.
  - The same call with tenant A's deal id under tenant B's context throws `QuoteNotFoundError`.
  - `updateQuoteDraft` with the Task 2 A/B lines and an overall discount of 19000 stores `total_minor = 191250` and item `allocated_discount_minor` values of 10000 and 9000.
  - Editing the template's text section after quote creation leaves `getQuote(...).template_snapshot` unchanged. Archiving that template also leaves `getQuote` working.
  - After the status is set to `sent` (a direct SQL update in the test), `updateQuoteDraft` throws `QuoteFrozenError` and the stored items are unchanged.
  - `createQuoteRevision` on the sent quote gives revision 2 with the same number, and the source becomes `superseded`. A second revision call on the superseded source throws.
  - `archiveQuoteTemplate` on the default template throws.
  - `setDefaultQuoteTemplate` moves the default; exactly one default remains.
- [ ] **Step 2: Run them and confirm they fail** (`pnpm selftest:quotes-db`).
- [ ] **Step 3: Implement `schema.ts`, `types.ts` and `queries.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass** (`pnpm selftest:quotes-db`).
- [ ] **Step 5: Commit** with the message `feat(quotes): quote and template data layer with revisions and locking`.

---

### Task 6: Permissions and server actions

**Files:**
- Modify: `src/lib/rbac.ts` (add `manageQuoteTemplates` and `manageQuotes`, each with a doc comment in the existing style)
- Create: `src/lib/quotes/actions.ts` (`'use server'`)
- Test: `scripts/selftest-quotes.ts` (role matrix)

**Interfaces:**
- **Consumes:** all of Task 5.
- **Produces** (each returns `{ ok: true, … } | { ok: false; error: string; fieldErrors?: Record<string, string[]> }`):
  - `saveQuoteTemplateAction(raw)`
  - `duplicateQuoteTemplateAction(id)`
  - `setDefaultQuoteTemplateAction(id)`
  - `archiveQuoteTemplateAction(id)`
  - `saveQuoteSettingsAction(raw)`
  - `createQuoteAction({ dealId, templateId? })`, which returns `{ ok: true; id }`
  - `updateQuoteDraftAction(id, raw)`, which returns `{ ok: true; quote: QuoteDetail }`
  - `reapplyTemplateAction(id, templateId?)`
  - `createQuoteRevisionAction(id)`
  - `setDealAmountFromQuoteAction(id)`
  - `getQuoteForPdfAction(id)`, which returns `{ ok: true; quote: QuoteDetail; logoUrl: string | null }` and is readable by any member, viewers included.
- **Pattern:** follow `createInvoiceAction` in `src/lib/invoices/actions.ts`:
  - `auth` → zod → `requireTenant` → `runWithTenantContext` → `requireMembership()`, then `can(membership.role, perm)`.
  - `QuoteFrozenError` and `QuoteNotFoundError` map to `{ ok:false, error: err.message }`.
  - Call `revalidatePath` for `/dashboard/quotes`, `/dashboard/deals/${dealId}` and `/dashboard/settings/quote-templates` as relevant.

- [ ] **Step 1: Write the failing tests:**
  - `can('member','manageQuotes')` is true.
  - `can('viewer','manageQuotes')` is false.
  - `can('manager','manageQuoteTemplates')` is false.
  - `can('admin','manageQuoteTemplates')` is true.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Add the permissions, then write `actions.ts`.**
- [ ] **Step 4: Run the tests and `pnpm exec tsc --noEmit` and confirm both pass.**
- [ ] **Step 5: Commit** with the message `feat(quotes): permissions and server actions`.

---

### Task 7: The `QuoteDocument` PDF renderer

**Files:**
- Modify: `package.json` (add `@react-pdf/renderer` with an exact version whose peer range includes React 19 — use the latest 4.x at install time and pin it without `^`), `next.config.ts` (add `@react-pdf/renderer` to `serverExternalPackages` — confirm the option name in `node_modules/next/dist/docs/` first)
- Create:
  - `public/fonts/quote/` (six TTFs: Noto Sans, Inter and Roboto, each in Regular and Bold, with their OFL/Apache licence files)
  - `src/lib/quotes/pdf/fonts.ts`
  - `src/lib/quotes/pdf/quote-document.tsx`
  - `src/lib/quotes/pdf/sections/*.tsx` (one per section type)
  - `src/lib/quotes/pdf/amount-in-words.ts`
  - `src/lib/quotes/pdf/sample-data.ts`
- Modify: `src/lib/invoices/pdf.ts`, so that it imports `amountInWords` from the new module (moved, not duplicated)
- Test: `scripts/selftest-quotes-pdf.ts` (add a `"selftest:quotes-pdf"` script)

**Interfaces:**
- **Consumes:** Task 3 types, Task 2 `QuoteTotals`, Task 5 `QuoteDetail`, and `gstBreakdown` and `gstStateCode` from `src/lib/invoices/gst.ts`.
- **Produces:**
  ```ts
  export type QuoteRenderInput = { body: QuoteTemplateBody; quote: QuoteDetail; logoUrl: string | null; placeholderValues: Partial<Record<Placeholder, string | null>>; dealCustomFields: Record<string, unknown> }; // custom_fields section reads dealCustomFields[key]; missing → '—'
  export function QuoteDocument(props: QuoteRenderInput): JSX.Element;            // quote-document.tsx
  export function registerQuoteFonts(base: 'browser' | 'server'): void;           // fonts.ts; browser → '/fonts/quote/…', server → path.join(process.cwd(),'public/fonts/quote/…'); idempotent
  export function sampleRenderInput(body: QuoteTemplateBody): QuoteRenderInput;   // sample-data.ts, for the builder preview
  export function amountInWords(totalMinor: number, currency: string): string;   // moved from invoices/pdf.ts
  export function buildPlaceholderValues(quote: QuoteDetail, rep: { name: string; email: string }): Partial<Record<Placeholder, string | null>>;
  ```

**Rendering rules:**
- Disabled sections are skipped.
- `page_break` renders `<View break />`.
- The tax breakdown uses one `gstBreakdown` per tax group. Seller state comes from `seller.gstin`. The place of supply is the consignee if present, else the buyer, the same as for invoices.
- Line items wrap across pages, with the table header repeated (`fixed`).
- Text blocks render the restricted TipTap nodes only.

- [ ] **Step 1: Write the failing tests.** Under `--require ./scripts/_shim-server-only.cjs`, `registerQuoteFonts('server')` is called, then `renderToBuffer(QuoteDocument(sampleRenderInput(defaultTemplateBody())))` is rendered. The assertions:
  - The buffer starts with `%PDF`.
  - The text extracted with `unpdf`'s `extractText` contains `'₹'`, the sample quote number, `'CGST'` (the sample seller and buyer are in the same state), and the amount in words.
  - A body with every optional section disabled still renders.
  - A sample with 60 line items gives a PDF of at least 2 pages.
  - An inter-state sample shows `'IGST'` and not `'CGST'`.
- [ ] **Step 2: Run them and confirm they fail** (`pnpm selftest:quotes-pdf`).
- [ ] **Step 3: Install the package, add the fonts, write the renderer, and move `amountInWords`.**
- [ ] **Step 4: Run the tests** (`pnpm selftest:quotes-pdf`) **and confirm they pass.** Then check the invoice PDF still downloads in the running app; `amountInWords` was moved out from under it.
- [ ] **Step 5: Commit** with the message `feat(quotes): react-pdf QuoteDocument with section renderers`.

---

### Task 8: Mark as sent (server render, filing, delete protection)

**Files:**
- Create:
  - `src/lib/quotes/send.ts`
  - `src/lib/quotes/pdf/render-server.ts` (`import 'server-only'`)
  - `src/lib/deals/protected-documents.ts`
- Modify:
  - `src/lib/quotes/actions.ts` (add `markQuoteSentAction`)
  - `src/app/dashboard/deals/[id]/document-actions.ts` (use `protectedDocumentReason`, and add a quote message)
- Test: `scripts/selftest-quotes-db.ts`

**Interfaces:**
- **Produces:**
  ```ts
  export async function renderQuotePdfServer(input: QuoteRenderInput): Promise<Uint8Array>;
  export type SendDeps = { render: (q: QuoteDetail) => Promise<Uint8Array>; upload: typeof uploadDealDocument; removeUpload: typeof deleteDealDocument };
  export async function markQuoteSent(tenantId: string, userId: string, id: string, deps: SendDeps): Promise<{ documentId: string }>;
  export async function protectedDocumentReason(tx: DbExecutor, tenantId: string, documentId: string): Promise<'order_proof' | 'quote' | null>;
  export async function markQuoteSentAction(id: string): Promise<{ ok: true; documentId: string } | { ok: false; error: string }>; // perm manageQuotes
  ```
- **The `markQuoteSent` sequence:**
  1. Load the quote. It must be a draft with at least one item; otherwise reject with "Add at least one line item before sending."
  2. Render it.
  3. Upload it as `${quoteNumber} Rev ${revision}.pdf`, sanitised by the existing uploader.
  4. In one `tenantTransaction`:
     - Re-check that the status is still `draft`, with `FOR UPDATE`.
     - Insert a `deal_documents` row with `category 'proposal'`, `uploadedBy userId`, the `fileUrl` and `storagePath`, `fileType 'application/pdf'`, and `sizeBytes`.
     - Update the quote: `status 'sent'`, `sent_at now()`, `sent_by`, `pdf_document_id`.
  5. If the transaction throws, call `removeUpload(path)` and rethrow.
- **Delete message for a quote document:** "This file is the sent copy of a quote and can’t be deleted. Create a revision instead."

- [ ] **Step 1: Write the failing DB tests.** Use fake deps: `render` returns `new Uint8Array([37,80,68,70])`, and `upload` records its call and returns `{ url:'u', path:'p' }`.
  - `markQuoteSent` on a draft with items leaves the status `sent`, creates one `deal_documents` row with category `proposal`, and sets `pdf_document_id`.
  - On a draft with no items, it throws and `upload` is never called.
  - A second call on the same quote throws `QuoteFrozenError`.
  - When `render` succeeds but the DB step fails (simulated by deleting the quote between the render and the transaction, inside the fake `render`), `removeUpload` is called with `'p'`.
  - `protectedDocumentReason` returns `'quote'` for the filed document id.
- [ ] **Step 2: Run them and confirm they fail** (`pnpm selftest:quotes-db`).
- [ ] **Step 3: Implement the modules, the action, and the `document-actions.ts` refactor.** Keep the order-proof message unchanged.
- [ ] **Step 4: Run the tests and confirm they pass.** Also run `pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-quotes-pdf.ts` with an extra check that `renderQuotePdfServer` returns `%PDF` bytes.
- [ ] **Step 5: Commit** with the message `feat(quotes): mark as sent with server-rendered, protected PDF`.

---

### Task 9: Admin UI (template builder and quote settings)

**Files:**
- Create:
  - `src/app/dashboard/settings/quote-templates/page.tsx` (list)
  - `src/app/dashboard/settings/quote-templates/[id]/page.tsx` (editor shell)
  - `src/app/dashboard/settings/quote-templates/_components/` with:
    - `template-list.tsx`
    - `template-builder.tsx` (three-pane client component)
    - `section-list.tsx` (`@dnd-kit/sortable`, toggles, "Add section" menu)
    - `section-settings/<type>.tsx` (one form per type)
    - `theme-settings.tsx`
    - `rich-text-editor.tsx` (TipTap with only the allowed nodes and marks, plus a placeholder picker that inserts `placeholder` nodes)
    - `pdf-preview.tsx` (`usePDF` / `BlobProvider` from `@react-pdf/renderer`, debounced 400 ms, loaded with `next/dynamic` `ssr:false`)
  - `src/app/dashboard/settings/quotes/page.tsx` (number format with a live example, validity days)
- Modify: `src/app/dashboard/settings/_components/settings-nav.tsx`, adding:
  - `{ href: '/dashboard/settings/quote-templates', label: 'Quote templates', icon: FileText, visibility: 'adminOnly' }`
  - `{ href: '/dashboard/settings/quotes', label: 'Quotes', icon: Hash, visibility: 'adminOnly' }`

**Behaviour:**
- Both pages redirect non-admins, using the same guard the Offerings settings page uses.
- The list page calls `ensureStarterTemplate` and shows name, default badge, last updated, and Duplicate, Set default, Archive and Edit.
- In the builder, edits stay in local state. **Save** calls `saveQuoteTemplateAction`. Field errors map back to the offending section using the zod path index, and the section is highlighted in the list.
- Leaving with unsaved changes asks for confirmation.
- The preview renders `sampleRenderInput(currentBody)`. An invalid body shows the last valid preview with an "Invalid — not saved" banner.
- `line_items` and `totals` have no delete or disable control. The UI enforces this, and the server rule in Task 3 is the backstop.

- [ ] **Step 1: Build the list page and the settings page.** Check with `pnpm exec tsc --noEmit && pnpm lint` (no new errors).
- [ ] **Step 2: Build the builder, the section forms and the preview.** Check with `pnpm exec tsc --noEmit && pnpm lint`.
- [ ] **Step 3: Run the app** (use the `run` skill, against `.env.local`).
  - As an admin, open Quote templates. Confirm that the starter template appears.
  - Reorder the sections, add a text block with `{{client.name}}`, change the primary colour, and save. The preview updates within about 1 s.
  - Reload and confirm that the changes persisted.
  - As a member, confirm that the nav items are hidden and that the URL redirects.
- [ ] **Step 4: Commit** with the message `feat(quotes): admin template builder with live PDF preview`.

---

### Task 10: Rep UI (deal Quotes card, editor, list)

**Files:**
- Create:
  - `src/app/dashboard/deals/[id]/_components/deal-quotes-card.tsx`
  - `src/app/dashboard/quotes/page.tsx` (list, with filters for status, rep and date range; cursor pagination)
  - `src/app/dashboard/quotes/[id]/page.tsx`
  - `src/app/dashboard/quotes/[id]/_components/`, containing:
    - `quote-editor.tsx`
    - `line-items-table.tsx`
    - `section-content-editor.tsx`
    - `quote-actions-bar.tsx`
    - `download-quote-button.tsx`
- Modify:
  - `src/app/dashboard/deals/[id]/page.tsx` (render `DealQuotesCard` next to `DealDocumentsCard`)
  - `src/app/dashboard/_components/nav-config.ts` (add "Quotes", `href '/dashboard/quotes'`, next to Invoices)

**Behaviour:**
- **Deal card:**
  - Lists quotes and revisions (number, Rev, status badge, total, date).
  - **New quote** opens a template picker (default preselected; hidden when only one template exists) and calls `createQuoteAction`, then navigates to the editor.
- **Editor, while the quote is a draft:**
  - The left side shows, in template order, the editable sections: client details, text blocks with `repEditable`, payment schedule, terms and line items. Non-editable sections appear as read-only labels.
  - The right side shows the debounced live PDF (`QuoteDocument` with real data plus `buildPlaceholderValues`).
- **Line items table:**
  - Inline rows with description, HSN/SAC, unit, qty, rate (₹, converted to minor units on input), discount %, GST % (a select of the suggested slabs plus "Other"), an optional offering label, and a group label when the template groups rows.
  - Running totals come from `computeQuoteTotals` on the client, for display only.
  - The overall discount control has three choices: None, ₹ or %.
- **Action bar:**
  - Save calls `updateQuoteDraftAction` and shows field errors.
  - Download PDF renders in the browser with `pdf(<QuoteDocument/>).toBlob()`.
  - Mark as sent confirms ("This locks Rev n and files the PDF on the deal."), then calls `markQuoteSentAction`.
  - Re-apply template is shown only if the template has changed since the snapshot.
- **When the quote is sent:**
  - The editor is read-only.
  - The actions are Download (the filed PDF's `fileUrl`), New revision, and Set deal value from this quote (which confirms, showing the old value and the new value).
- **When the quote is superseded:** the editor is read-only and links to the newer revision.
- **Viewers:** read-only and download only.

- [ ] **Step 1: Build the deal card and the list page.** Check with `pnpm exec tsc --noEmit && pnpm lint`.
- [ ] **Step 2: Build the editor and the action bar.** Check with `pnpm exec tsc --noEmit && pnpm lint`.
- [ ] **Step 3: Run the app against `.env.local`.**
  - As a member, on a deal: New quote → add the Task 2 A/B lines with an overall discount of ₹190 → Save. The total shows ₹1,912.50.
  - Download the PDF and confirm it matches the preview.
  - Mark as sent: the PDF appears in the deal's documents, and deleting it shows the protection message.
  - New revision gives Rev 2 as a draft, and Rev 1 becomes superseded.
  - Set deal value updates the deal amount to ₹1,710.
  - As a viewer, confirm there are no edit controls.
- [ ] **Step 4: Commit** with the message `feat(quotes): rep quote editor, deal quotes card and quotes list`.

---

### Task 11: Wire up the self-tests and verify the whole branch

**Files:**
- Modify: `package.json`. Append to `selftest`:
  - `tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-quotes.ts`
  - `tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-quotes-pdf.ts`
  - `tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-quotes-db.ts`

- [ ] **Step 1: Run** `pnpm selftest` against the test DB. Expected: every script PASSES, and the quote DB checks run rather than skip.
- [ ] **Step 2: Run** `pnpm exec tsc --noEmit && pnpm lint`. Expected: no new errors.
- [ ] **Step 3: Run** `pnpm build` with `DATABASE_URL` pointing at the **test** DB, because the build applies migrations. Expected: `apply-0078` runs, and so does `next build`.
- [ ] **Step 4: Commit** with the message `chore(quotes): add quote self-tests to the selftest chain`.
