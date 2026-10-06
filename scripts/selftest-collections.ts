/**
 * Self-test for the collections diagnostic (collections addendum, Phase A).
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-collections.ts
 *
 * Pure section first — the rules the report stands on, against hand-built
 * fixtures with known answers. The database section (approval lifecycle,
 * payments, the report's SQL input, tenant isolation) needs DATABASE_URL and
 * is SKIPPED, not failed, without one. It builds its own tenants and drops
 * them afterwards.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });
config();

import {
  buildDiagnostic,
  drillDown,
  effectiveDealTerms,
  flagFor,
  invoiceStatus,
  median,
  type BookedDealIn,
  type CollectionSettings,
  type DiagnosticInput,
  type InvoiceIn,
} from '../src/lib/collections/diagnostic';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const S: CollectionSettings = { standardCreditDays: 30, materialExcessDays: 15 };
const L = 100_000_00; // ₹1 lakh in paise
const PERIOD = { start: '2026-04-01', end: '2027-04-01' };

const deal = (id: string, owner: string, lakhs: number, closedOn: string, days: number | null, approvedBy: string | null = null): BookedDealIn => ({
  dealId: id,
  name: `Deal ${id}`,
  ownerId: owner,
  amountMinor: lakhs * L,
  closedOn,
  terms: days == null ? null : { agreedCreditDays: days, approvedBy, approvedAt: approvedBy ? '2026-05-01T00:00:00Z' : null },
});
const inv = (id: string, dealId: string | null, owner: string | null, date: string, lakhs: number, payments: Array<[number, string]>, override: number | null = null, dealDays: number | null = null): InvoiceIn => ({
  invoiceId: id,
  piNumber: `PI-${id}`,
  dealId,
  ownerId: owner,
  invoiceDate: date,
  totalMinor: lakhs * L,
  creditDaysOverride: override,
  dealTerms: dealDays == null ? null : { agreedCreditDays: dealDays, approvedBy: null, approvedAt: null },
  payments: payments.map(([l, d]) => ({ amountMinor: l * L, paidOn: d })),
});

/* ------------------------------------------------------------------ *
 * 1. Credit terms                                                     *
 * ------------------------------------------------------------------ */
{
  const none = effectiveDealTerms(null, S);
  check('no recorded terms → standard, flagged assumed (not silently compliant)', none.days === 30 && none.assumed && !none.unapprovedOverride);
  const within = effectiveDealTerms({ agreedCreditDays: 30, approvedBy: null, approvedAt: null }, S);
  check('terms at the standard need no approval', !within.overStandard && !within.unapprovedOverride && !within.assumed);
  const unapproved = effectiveDealTerms({ agreedCreditDays: 90, approvedBy: null, approvedAt: null }, S);
  check('90 days with no approver → unapproved override', unapproved.overStandard && unapproved.unapprovedOverride);
  const approved = effectiveDealTerms({ agreedCreditDays: 90, approvedBy: 'mgr', approvedAt: '2026-05-01' }, S);
  check('90 days approved by a manager → approved, not flagged', approved.approved && !approved.unapprovedOverride);
}

/* ------------------------------------------------------------------ *
 * 2. One invoice                                                      *
 * ------------------------------------------------------------------ */
{
  const paid = invoiceStatus(inv('a', 'd', 'u', '2026-05-01', 10, [[4, '2026-05-10'], [6, '2026-05-25']]), S, '2026-10-01');
  check('fully paid in two parts: paid on the day the total was reached', paid.state === 'paid' && paid.fullyPaidOn === '2026-05-25' && paid.daysToCollect === 24);
  check('…and that is on time against a 30-day due date', paid.dueDate === '2026-05-31' && paid.collectedOnTime === true && !paid.overdue);
  const partial = invoiceStatus(inv('b', 'd', 'u', '2026-05-01', 10, [[4, '2026-05-10']]), S, '2026-10-01');
  check('part-paid is NOT collected: no days-to-collect, outstanding 6 L, overdue', partial.state === 'partial' && partial.daysToCollect === null && partial.outstandingMinor === 6 * L && partial.overdue);
  const late = invoiceStatus(inv('c', 'd', 'u', '2026-05-01', 10, [[10, '2026-07-15']]), S, '2026-10-01');
  check('paid in full after the due date → late', late.state === 'paid' && late.collectedOnTime === false && late.daysToCollect === 75);
  const viaDeal = invoiceStatus(inv('d', 'd', 'u', '2026-05-01', 10, [], null, 60), S, '2026-06-15');
  check('credit days come from the deal when the invoice has none', viaDeal.creditDays === 60 && viaDeal.creditDaysSource === 'deal' && !viaDeal.overdue);
  const override = invoiceStatus(inv('e', 'd', 'u', '2026-05-01', 10, [], 15, 60), S, '2026-06-15');
  check('an invoice-level override beats the deal’s terms', override.creditDays === 15 && override.creditDaysSource === 'invoice' && override.overdue);
  const unlinked = invoiceStatus(inv('f', null, null, '2026-05-01', 10, []), S, '2026-05-02');
  check('an unlinked invoice uses the standard', unlinked.creditDays === 30 && unlinked.creditDaysSource === 'standard' && unlinked.state === 'unpaid');
  const over = invoiceStatus(inv('g', 'd', 'u', '2026-05-01', 10, [[12, '2026-05-05']]), S, '2026-10-01');
  check('overpayment still counts as paid, nothing outstanding', over.state === 'paid' && over.outstandingMinor === 0);
}

/* ------------------------------------------------------------------ *
 * 3. Flags                                                            *
 * ------------------------------------------------------------------ */
check('median of an even list averages the middle two', median([0.5, 1.5, 1, 2]) === 1.25);
check('above median + credit at standard → outperforming', flagFor(1.2, 30, 1, S) === 'outperforming');
check('above median + credit far above standard → funding_customers', flagFor(1.2, 90, 1, S) === 'funding_customers');
check('above median + credit slightly above (within margin) → standard', flagFor(1.2, 40, 1, S) === 'standard');
check('below median → underperforming', flagFor(0.6, 30, 1, S) === 'underperforming');
check('no target → standard, never a guess', flagFor(null, 120, 1, S) === 'standard');

/* ------------------------------------------------------------------ *
 * 4. The leaderboard, end to end                                      *
 * ------------------------------------------------------------------ *
 * Four SPOCs, target 100 L each for the period:
 *   funder  — 150 L booked at 90 days (unapproved) — the post's pattern
 *   steady  — 120 L booked at 30 days               — outperforming
 *   mid     — 100 L booked, no terms recorded       — assumed standard
 *   slow    —  50 L booked at 30 days               — underperforming
 */
const input: DiagnosticInput = {
  settings: S,
  period: PERIOD,
  asOf: '2026-12-31',
  deals: [
    deal('f1', 'funder', 100, '2026-05-01', 90),
    deal('f2', 'funder', 50, '2026-06-01', 90, 'mgr'),
    deal('s1', 'steady', 120, '2026-05-15', 30),
    deal('m1', 'mid', 100, '2026-07-01', null),
    deal('w1', 'slow', 50, '2026-08-01', 30),
    deal('old', 'steady', 999, '2025-12-01', 30), // outside the period
  ],
  invoices: [
    inv('i1', 'f1', 'funder', '2026-05-01', 100, [[40, '2026-09-01']], null, 90), // partial
    inv('i2', 'f2', 'funder', '2026-06-01', 50, [[50, '2026-10-01']], null, 90), // paid, 122 days
    inv('i3', 's1', 'steady', '2026-05-15', 120, [[120, '2026-06-10']], null, 30), // paid, 26 days
    inv('i4', 'w1', 'slow', '2026-08-01', 50, [], null, 30), // unpaid
    inv('i5', null, null, '2026-09-01', 20, [[20, '2026-09-20']]), // unattributed
    inv('i6', 'old', 'steady', '2025-12-01', 999, [[999, '2026-04-05']], null, 30), // billed before, collected in period
  ],
  targets: new Map([
    ['funder', 100 * L],
    ['steady', 100 * L],
    ['mid', 100 * L],
    ['slow', 100 * L],
  ]),
  owners: ['funder', 'steady', 'mid', 'slow'],
};
const diag = buildDiagnostic(input);
const row = (o: string) => diag.rows.find((r) => r.ownerId === o)!;
check('seeded high-achiever on long terms is flagged funding_customers', row('funder').flag === 'funding_customers', JSON.stringify(row('funder')));
check('high achiever on standard terms is outperforming', row('steady').flag === 'outperforming');
check('below-median SPOC is underperforming', row('slow').flag === 'underperforming');
check('median achievement is 1.1 (1.5, 1.2, 1.0, 0.5)', diag.medianAchievementPct === 1.1);
check('funder’s agreed credit is value-weighted: 90 d', row('funder').avgAgreedCreditDays === 90);
check('funder has one unapproved long-terms deal', row('funder').unapprovedOverrideDeals === 1);
check('mid’s deal with no terms counts at standard and is marked assumed', row('mid').avgAgreedCreditDays === 30 && row('mid').assumedTermsDeals === 1);
check(
  'part-payment is NOT in funder’s days-to-collect: only the paid-in-full 122-day invoice counts',
  row('funder').avgDaysToCollect === 122 && row('funder').collectedInvoices === 1 && row('funder').partialInvoices === 1 && row('funder').partialOutstandingMinor === 60 * L,
);
check('leaderboard is sorted by agreed credit, longest first', diag.rows[0]!.ownerId === 'funder');
check('a deal booked before the period is not counted', row('steady').bookedMinor === 120 * L);

const s = diag.summary;
const paymentsInPeriod = input.invoices.flatMap((i) => i.payments).filter((p) => p.paidOn >= PERIOD.start && p.paidOn < PERIOD.end);
check('summary collected = sum of the underlying payments in the period', s.collectedMinor === paymentsInPeriod.reduce((a, p) => a + p.amountMinor, 0) && s.collectedMinor === (40 + 50 + 120 + 20 + 999) * L);
check('summary invoiced = sum of invoices dated in the period', s.invoicedMinor === (100 + 50 + 120 + 50 + 20) * L);
check('summary booked = sum of deals won in the period', s.bookedMinor === (150 + 120 + 100 + 50) * L);
check('gap = booked − collected', s.bookingVsCollectionGapMinor === s.bookedMinor - s.collectedMinor);
check('the unlinked invoice is counted in totals but attributed to nobody', s.unattributedInvoices === 1 && s.unattributedInvoicedMinor === 20 * L);
check('summary counts assumed and unapproved deals', s.assumedTermsDeals === 1 && s.unapprovedOverrideDeals === 1);

/* ---- period filtering ---- */
{
  const q1 = buildDiagnostic({ ...input, period: { start: '2026-04-01', end: '2026-07-01' } });
  check('a quarter only counts deals won inside it', q1.summary.bookedMinor === (150 + 120) * L);
  check('a quarter only counts payments received inside it', q1.summary.collectedMinor === (120 + 999) * L);
}

/* ---- drill-down ---- */
{
  const d = drillDown(input, 'funder');
  check('drill-down lists only above-standard deals (both of funder’s)', d.length === 2);
  const f1 = d.find((x) => x.dealId === 'f1')!;
  const f2 = d.find((x) => x.dealId === 'f2')!;
  check('drill-down: unapproved deal shows as such, part-paid & past due → overdue', f1.unapproved && f1.collection === 'overdue');
  check('drill-down: approved deal names its approver, paid late → late', f2.approvedBy === 'mgr' && f2.collection === 'late');
  check('drill-down for a SPOC on standard terms is empty', drillDown(input, 'steady').length === 0);
}

/* ------------------------------------------------------------------ *
 * Database checks                                                     *
 * ------------------------------------------------------------------ */
async function databaseChecks(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping the database checks.');
    return;
  }
  const { runCollectionsDbChecks } = await import('./selftest-collections-db');
  await runCollectionsDbChecks(check);
}

databaseChecks()
  .catch((err) => check('database checks ran without throwing', false, err instanceof Error ? err.stack : String(err)))
  .finally(() => {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `\n      ${r.detail}` : ''}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(exitCode);
  });
