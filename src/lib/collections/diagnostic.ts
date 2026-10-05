/**
 * CREDIT PERIOD vs ACHIEVEMENT — the collections diagnostic (Phase A of the
 * collections addendum). Pure + client-safe: the page, the selftest and any
 * future export all run this, never their own arithmetic.
 *
 * The question it answers: is anyone hitting their number by giving
 * customers long credit — i.e. is the company funding customers so a rep can
 * book revenue? Booking is a sales number; collection is a commercial one.
 *
 * DEFINITIONS (each one is shown on the page next to the figure)
 *
 *   Booked       Won deals that earn quota credit, closed in the period, at
 *                face value (deals.amount_minor). The order book.
 *   Agreed credit Value-weighted average of each booked deal's agreed credit
 *                days. A deal with no recorded terms counts at the workspace
 *                standard and is flagged `assumed` — never silently treated
 *                as compliant.
 *   Invoiced     Proforma invoices dated in the period.
 *   Collected    Payments received in the period (by paid date), on any
 *                invoice — cash in, whenever it was billed.
 *   Days to collect  For invoices dated in the period AND collected in full:
 *                days from invoice date to the day cumulative payments
 *                reached the total, value-weighted. Partly paid and unpaid
 *                invoices are excluded from the average and counted
 *                separately, so a part-payment can't make a rep look fast.
 *   Achievement  Booked ÷ the period's share of the annual revenue target.
 *
 * Money is integer minor units throughout; sums are exact. Averages are
 * rounded to one decimal place only for display.
 */

export type CollectionSettings = {
  /** The workspace's standard credit period, in days. */
  standardCreditDays: number;
  /** How far above standard counts as "materially" above (for the flag). */
  materialExcessDays: number;
};

export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  standardCreditDays: 30,
  materialExcessDays: 15,
};

export type CreditTermsIn = {
  agreedCreditDays: number;
  approvedBy: string | null;
  approvedAt: string | null;
} | null;

export type BookedDealIn = {
  dealId: string;
  name: string;
  ownerId: string;
  amountMinor: number;
  /** YYYY-MM-DD the deal closed (won). */
  closedOn: string;
  terms: CreditTermsIn;
};

export type PaymentIn = { amountMinor: number; paidOn: string };

export type InvoiceIn = {
  invoiceId: string;
  piNumber: string;
  dealId: string | null;
  /** The linked deal's owner; null when the invoice isn't linked to a deal. */
  ownerId: string | null;
  invoiceDate: string;
  totalMinor: number;
  /** Credit days set on the invoice itself; overrides the deal's terms. */
  creditDaysOverride: number | null;
  /** The linked deal's terms, if any. */
  dealTerms: CreditTermsIn;
  payments: PaymentIn[];
};

/* ------------------------------------------------------------------ *
 * Dates                                                               *
 * ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / MS_PER_DAY);
}

const inWindow = (iso: string, startISO: string, endISO: string) => iso >= startISO && iso < endISO;

/* ------------------------------------------------------------------ *
 * Credit terms                                                        *
 * ------------------------------------------------------------------ */

export type EffectiveTerms = {
  days: number;
  /** No terms recorded — the standard was assumed. */
  assumed: boolean;
  overStandard: boolean;
  /** Over standard AND approved by someone. */
  approved: boolean;
  /** Over standard with nobody's approval — the case the addendum flags. */
  unapprovedOverride: boolean;
  approvedBy: string | null;
};

export function effectiveDealTerms(terms: CreditTermsIn, s: CollectionSettings): EffectiveTerms {
  if (!terms) {
    return {
      days: s.standardCreditDays,
      assumed: true,
      overStandard: false,
      approved: false,
      unapprovedOverride: false,
      approvedBy: null,
    };
  }
  const over = terms.agreedCreditDays > s.standardCreditDays;
  return {
    days: terms.agreedCreditDays,
    assumed: false,
    overStandard: over,
    approved: over && terms.approvedBy !== null,
    unapprovedOverride: over && terms.approvedBy === null,
    approvedBy: terms.approvedBy,
  };
}

/** Does setting these days need sign-off? Re-evaluated whenever read. */
export function creditTermsNeedApproval(days: number, s: CollectionSettings): boolean {
  return days > s.standardCreditDays;
}

/* ------------------------------------------------------------------ *
 * One invoice                                                         *
 * ------------------------------------------------------------------ */

export type InvoiceState = 'paid' | 'partial' | 'unpaid';

export type InvoiceStatus = {
  creditDays: number;
  /** Where `creditDays` came from. */
  creditDaysSource: 'invoice' | 'deal' | 'standard';
  dueDate: string;
  paidMinor: number;
  outstandingMinor: number;
  state: InvoiceState;
  /** Day cumulative payments reached the total; null unless fully paid. */
  fullyPaidOn: string | null;
  daysToCollect: number | null;
  /** Fully paid on or before the due date. Null while not fully paid. */
  collectedOnTime: boolean | null;
  /** Not fully paid and past due as of `asOf`. */
  overdue: boolean;
};

export function invoiceStatus(inv: InvoiceIn, s: CollectionSettings, asOfISO: string): InvoiceStatus {
  const deal = inv.dealTerms ? effectiveDealTerms(inv.dealTerms, s) : null;
  const creditDays = inv.creditDaysOverride ?? deal?.days ?? s.standardCreditDays;
  const creditDaysSource = inv.creditDaysOverride != null ? 'invoice' : inv.dealTerms ? 'deal' : 'standard';
  const dueDate = addDays(inv.invoiceDate, creditDays);

  const sorted = [...inv.payments].sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0));
  let running = 0;
  let fullyPaidOn: string | null = null;
  for (const p of sorted) {
    running += p.amountMinor;
    if (fullyPaidOn === null && inv.totalMinor > 0 && running >= inv.totalMinor) fullyPaidOn = p.paidOn;
  }
  const paidMinor = running;
  const outstandingMinor = Math.max(0, inv.totalMinor - paidMinor);
  const state: InvoiceState =
    inv.totalMinor <= 0 || fullyPaidOn ? 'paid' : paidMinor > 0 ? 'partial' : 'unpaid';
  return {
    creditDays,
    creditDaysSource,
    dueDate,
    paidMinor,
    outstandingMinor,
    state,
    fullyPaidOn,
    daysToCollect: fullyPaidOn ? daysBetween(inv.invoiceDate, fullyPaidOn) : null,
    collectedOnTime: fullyPaidOn ? fullyPaidOn <= dueDate : null,
    overdue: state !== 'paid' && asOfISO > dueDate,
  };
}

/* ------------------------------------------------------------------ *
 * Leaderboard                                                         *
 * ------------------------------------------------------------------ */

export type SpocFlag = 'outperforming' | 'funding_customers' | 'standard' | 'underperforming';

export const SPOC_FLAG_LABELS: Record<SpocFlag, string> = {
  outperforming: 'Outperforming',
  funding_customers: 'Funding customers',
  standard: 'Standard',
  underperforming: 'Underperforming',
};

export type SpocRow = {
  ownerId: string;
  bookedMinor: number;
  bookedDeals: number;
  /** Value-weighted; null when nothing was booked. */
  avgAgreedCreditDays: number | null;
  assumedTermsDeals: number;
  unapprovedOverrideDeals: number;
  invoicedMinor: number;
  /** Value-weighted over fully collected invoices; null when none. */
  avgDaysToCollect: number | null;
  collectedInvoices: number;
  partialInvoices: number;
  partialOutstandingMinor: number;
  unpaidInvoices: number;
  unpaidOutstandingMinor: number;
  /** Invoices fully collected on or before their due date, by value. Null when none fully collected. */
  onTimeCollectedPct: number | null;
  targetMinor: number | null;
  /** Booked ÷ target for the period. Null when no target is set. */
  achievementPct: number | null;
  standardCreditDays: number;
  flag: SpocFlag;
};

export type CompanySummary = {
  bookedMinor: number;
  invoicedMinor: number;
  collectedMinor: number;
  /** Booked − collected: the order book the company is still waiting on cash for. */
  bookingVsCollectionGapMinor: number;
  /** Invoiced − collected (in-period figures). */
  invoicedNotCollectedMinor: number;
  /** Invoices in the period not linked to a deal — counted in totals, attributed to nobody. */
  unattributedInvoices: number;
  unattributedInvoicedMinor: number;
  /** Booked deals with no recorded terms (standard assumed). */
  assumedTermsDeals: number;
  unapprovedOverrideDeals: number;
};

export type DrillDeal = {
  dealId: string;
  name: string;
  amountMinor: number;
  closedOn: string;
  creditDays: number;
  approvedBy: string | null;
  unapproved: boolean;
  /** How this deal's invoices are being collected. */
  collection: 'on_time' | 'late' | 'outstanding' | 'overdue' | 'not_invoiced';
  invoices: Array<{ invoiceId: string; piNumber: string; totalMinor: number; status: InvoiceStatus }>;
};

export type DiagnosticInput = {
  settings: CollectionSettings;
  period: { start: string; end: string };
  asOf: string;
  deals: BookedDealIn[];
  invoices: InvoiceIn[];
  /** Revenue target for THIS period per owner (already scaled from annual). */
  targets: Map<string, number>;
  /** Owners to show even with no activity (e.g. everyone with a target). */
  owners?: string[];
};

export type Diagnostic = {
  summary: CompanySummary;
  rows: SpocRow[];
  /** Median achievement across SPOCs that have a target; null if none do. */
  medianAchievementPct: number | null;
};

function weightedAvg(pairs: Array<{ value: number; weight: number }>): number | null {
  const w = pairs.reduce((a, p) => a + p.weight, 0);
  if (w <= 0) return null;
  return Math.round((pairs.reduce((a, p) => a + p.value * p.weight, 0) / w) * 10) / 10;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * One flag per SPOC.
 *   above the team median achievement and credit at/below standard  → outperforming
 *   above the median with credit MATERIALLY above standard          → funding_customers
 *   below the median                                                 → underperforming
 *   everything else (at the median, slightly above standard, no target) → standard
 */
export function flagFor(
  achievementPct: number | null,
  avgAgreedCreditDays: number | null,
  medianPct: number | null,
  s: CollectionSettings,
): SpocFlag {
  if (achievementPct === null || medianPct === null) return 'standard';
  const credit = avgAgreedCreditDays ?? s.standardCreditDays;
  if (achievementPct > medianPct) {
    if (credit > s.standardCreditDays + s.materialExcessDays) return 'funding_customers';
    if (credit <= s.standardCreditDays) return 'outperforming';
    return 'standard';
  }
  if (achievementPct < medianPct) return 'underperforming';
  return 'standard';
}

export function buildDiagnostic(input: DiagnosticInput): Diagnostic {
  const { settings: s, period, asOf } = input;
  const booked = input.deals.filter((d) => inWindow(d.closedOn, period.start, period.end));
  const periodInvoices = input.invoices.filter((i) => inWindow(i.invoiceDate, period.start, period.end));
  const statusById = new Map(input.invoices.map((i) => [i.invoiceId, invoiceStatus(i, s, asOf)]));

  const owners = new Set<string>(input.owners ?? []);
  for (const d of booked) owners.add(d.ownerId);
  for (const i of periodInvoices) if (i.ownerId) owners.add(i.ownerId);

  const rowsNoFlag = [...owners].map((ownerId) => {
    const myDeals = booked.filter((d) => d.ownerId === ownerId);
    const terms = myDeals.map((d) => ({ d, t: effectiveDealTerms(d.terms, s) }));
    const myInvoices = periodInvoices.filter((i) => i.ownerId === ownerId);
    const st = myInvoices.map((i) => ({ i, st: statusById.get(i.invoiceId)! }));
    const collected = st.filter((x) => x.st.state === 'paid');
    const partial = st.filter((x) => x.st.state === 'partial');
    const unpaid = st.filter((x) => x.st.state === 'unpaid');
    const bookedMinor = myDeals.reduce((a, d) => a + d.amountMinor, 0);
    const collectedValue = collected.reduce((a, x) => a + x.i.totalMinor, 0);
    const onTimeValue = collected.filter((x) => x.st.collectedOnTime).reduce((a, x) => a + x.i.totalMinor, 0);
    const target = input.targets.get(ownerId) ?? null;
    return {
      ownerId,
      bookedMinor,
      bookedDeals: myDeals.length,
      avgAgreedCreditDays: weightedAvg(terms.map(({ d, t }) => ({ value: t.days, weight: d.amountMinor }))),
      assumedTermsDeals: terms.filter((x) => x.t.assumed).length,
      unapprovedOverrideDeals: terms.filter((x) => x.t.unapprovedOverride).length,
      invoicedMinor: myInvoices.reduce((a, i) => a + i.totalMinor, 0),
      avgDaysToCollect: weightedAvg(collected.map((x) => ({ value: x.st.daysToCollect!, weight: x.i.totalMinor }))),
      collectedInvoices: collected.length,
      partialInvoices: partial.length,
      partialOutstandingMinor: partial.reduce((a, x) => a + x.st.outstandingMinor, 0),
      unpaidInvoices: unpaid.length,
      unpaidOutstandingMinor: unpaid.reduce((a, x) => a + x.st.outstandingMinor, 0),
      onTimeCollectedPct: collectedValue > 0 ? onTimeValue / collectedValue : null,
      targetMinor: target,
      achievementPct: target && target > 0 ? bookedMinor / target : null,
      standardCreditDays: s.standardCreditDays,
    };
  });

  const med = median(rowsNoFlag.map((r) => r.achievementPct).filter((v): v is number => v !== null));
  const rows: SpocRow[] = rowsNoFlag
    .map((r) => ({ ...r, flag: flagFor(r.achievementPct, r.avgAgreedCreditDays, med, s) }))
    .sort(
      (a, b) =>
        (b.avgAgreedCreditDays ?? -1) - (a.avgAgreedCreditDays ?? -1) || b.bookedMinor - a.bookedMinor,
    );

  const collectedMinor = input.invoices
    .flatMap((i) => i.payments)
    .filter((p) => inWindow(p.paidOn, period.start, period.end))
    .reduce((a, p) => a + p.amountMinor, 0);
  const bookedMinor = booked.reduce((a, d) => a + d.amountMinor, 0);
  const invoicedMinor = periodInvoices.reduce((a, i) => a + i.totalMinor, 0);
  const unattributed = periodInvoices.filter((i) => !i.ownerId);
  const bookedTerms = booked.map((d) => effectiveDealTerms(d.terms, s));

  return {
    summary: {
      bookedMinor,
      invoicedMinor,
      collectedMinor,
      bookingVsCollectionGapMinor: bookedMinor - collectedMinor,
      invoicedNotCollectedMinor: invoicedMinor - collectedMinor,
      unattributedInvoices: unattributed.length,
      unattributedInvoicedMinor: unattributed.reduce((a, i) => a + i.totalMinor, 0),
      assumedTermsDeals: bookedTerms.filter((t) => t.assumed).length,
      unapprovedOverrideDeals: bookedTerms.filter((t) => t.unapprovedOverride).length,
    },
    rows,
    medianAchievementPct: med,
  };
}

/**
 * Drill-down for one SPOC: every deal booked in the period whose credit
 * period is above standard, who approved it, and how its invoices are being
 * collected.
 */
export function drillDown(input: DiagnosticInput, ownerId: string): DrillDeal[] {
  const { settings: s, period, asOf } = input;
  return input.deals
    .filter((d) => d.ownerId === ownerId && inWindow(d.closedOn, period.start, period.end))
    .map((d) => ({ d, t: effectiveDealTerms(d.terms, s) }))
    .filter(({ t }) => t.overStandard)
    .map(({ d, t }) => {
      const invoices = input.invoices
        .filter((i) => i.dealId === d.dealId)
        .map((i) => ({ invoiceId: i.invoiceId, piNumber: i.piNumber, totalMinor: i.totalMinor, status: invoiceStatus(i, s, asOf) }));
      let collection: DrillDeal['collection'];
      if (invoices.length === 0) collection = 'not_invoiced';
      else if (invoices.some((x) => x.status.overdue)) collection = 'overdue';
      else if (invoices.some((x) => x.status.state !== 'paid')) collection = 'outstanding';
      else if (invoices.every((x) => x.status.collectedOnTime)) collection = 'on_time';
      else collection = 'late';
      return {
        dealId: d.dealId,
        name: d.name,
        amountMinor: d.amountMinor,
        closedOn: d.closedOn,
        creditDays: t.days,
        approvedBy: t.approvedBy,
        unapproved: t.unapprovedOverride,
        collection,
        invoices,
      };
    })
    .sort((a, b) => b.creditDays - a.creditDays);
}
