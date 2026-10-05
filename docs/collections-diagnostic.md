# Collections diagnostic: Credit Period vs Achievement

Phase A of the collections addendum. Reps are paid on **booking**, while the company waits on **cash**. This measures the gap, per rep, before anyone changes how incentives are paid. Phase B (collection-linked crediting in the incentive engine) is **not built**. The addendum says to run this report on real data first and decide afterwards.

## Step 0: what existed

| Needed | Found | Built |
| --- | --- | --- |
| Order value per deal | `deals.amount_minor`, owner, `closed_at` | Reused |
| Credit period agreed at booking | Nothing structured (only free-text "payment terms" on PIs) | `deal_credit_terms`: days, who set them, who approved |
| Invoices per deal, with a due date | Proforma invoices exist, but **not linked to deals**; no due date | `proforma_invoices.deal_id` + `credit_days`; due date derived |
| Payments and collection dates | None | `invoice_payments`: one row per payment; partial payments are separate rows |

**Limitation:** collections cover only payments recorded against invoices in Saleinx. Cash recorded only in Tally or another accounting tool is invisible until it's entered here (or until a CSV import or integration is built).

## Where things are

| Piece | Path |
| --- | --- |
| Rules (pure, tested) | `src/lib/collections/diagnostic.ts` |
| Reads/writes | `src/lib/collections/queries.ts`, `src/app/dashboard/collections/actions.ts` |
| Migration | `drizzle/0069_collections.sql`, `scripts/apply-0069.ts` |
| Report | `/dashboard/collections` (managers, admins) |
| Deal credit terms | "Credit terms" card on the deal page |
| Invoice deal link, credit days, payments | "Collection" section in the invoice drawer; Status column on the list |
| Standard credit period | Settings → Credit terms (admins) |
| Tests | `scripts/selftest-collections.ts` (+ `selftest-collections-db.ts`) |

## Rules

- **Credit terms.** A deal with no terms counts at the workspace standard (default 30 days) and is flagged **assumed**, never silently compliant.
- **Approval.** Terms longer than the standard need a manager or admin to approve them (`approveCreditTerms`). If a manager sets them, that counts as their approval. Changing the days clears any earlier approval. Unapproved long terms are flagged on the deal, in the summary, and in the drill-down.
- **An invoice's credit days** come from the invoice's own override, otherwise the deal's terms, otherwise the standard. Due date = invoice date + credit days.
- **Paid** means payments reached the invoice total; the paid date is the day they did. Part-paid invoices are **excluded** from days-to-collect and reported separately.
- **Payments** are recorded by managers and admins only (`recordPayments`), not by the rep whose numbers they move. A PI with payments can't be deleted until those payments are removed.

### Report definitions (period = fiscal year or a fiscal quarter)

- **Booked:** won deals earning quota credit (same rule as Targets), closed in the period, at face value.
- **Invoiced:** PIs dated in the period. **Collected:** payments received in the period, on any invoice.
- **Booked but not yet collected** = booked − collected. Shown first: it's the number a founder needs.
- **Agreed credit / days to collect:** value-weighted averages.
- **Achievement** = booked ÷ the period's share of the annual revenue target (same quarterly split as Targets).
- **Flags,** comparing each rep with the team's median achievement:
  - **Outperforming:** above the median, with credit at or below the standard.
  - **Funding customers:** above the median, with credit more than standard + the "materially above" margin (default 15 days).
  - **Underperforming:** below the median.
  - **Standard:** everything else, including reps with no target.
- **Unattributed:** invoices not linked to a deal are counted in totals but against no rep, and their count is shown.

## Decisions to review

- **Who approves long terms:** managers and admins approve; reps can set terms but not approve them.
- **Who records payments:** managers and admins only.
- **No CSV import or accounting integration yet:** the report fills up as payments are recorded.
- **"Company standard DSO" from the addendum** is shown as the workspace's standard credit period. Saleinx has no separate DSO figure.
- **Currency:** amounts are summed in minor units without FX conversion, the same as Targets.

## Verification

- Pure tests cover the four Phase A checks:
  - a seeded high-achiever on long terms is flagged `funding_customers`;
  - summary totals reconcile to the underlying invoices and payments;
  - a deal with no terms is "assumed";
  - partial payments are excluded from days-to-collect.
- They also cover period filtering, the drill-down, and the invoice status rules.
- The DB half covers:
  - the approval lifecycle;
  - payments, and the guard on deleting an invoice;
  - the report's database input;
  - tenant isolation, via both the query layer and RLS.
- First run against a throwaway Postgres (PGlite) with migrations 0000–0069 replayed, not against Supabase.
