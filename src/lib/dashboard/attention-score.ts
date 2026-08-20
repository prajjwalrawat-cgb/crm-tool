/**
 * Composite risk scoring for the Attention Queue.
 *
 * Pure — no React, no DB. Unit-tested from `scripts/selftest-dashboard.ts`.
 *
 * ---------------------------------------------------------------
 * WHY NOT JUST SORT BY DAYS SINCE ACTIVITY
 * ---------------------------------------------------------------
 * Because age is not risk. Sorting on staleness alone puts a ₹0 lead
 * nobody has touched in six months above a ₹2 crore negotiation that
 * slid backwards last week. The first is housekeeping; the second is
 * the deal the exec needed to hear about. An attention queue that
 * cannot tell those apart is a list, not a triage.
 *
 * Four independent factors, each scored 0–1 and then weighted. Keeping
 * them separate (rather than fusing them into one number in SQL) is
 * what lets the UI name the top contributor — "High value, no activity
 * 91d" is actionable in a way that "risk score 0.72" never is.
 *
 *   STALLED   0.35  How long since anything happened. The original
 *                   signal, still the heaviest single one, but no
 *                   longer the only one.
 *   VALUE     0.30  What is at stake. Scored on a LOG scale against
 *                   the largest deal in the queue: linear scaling
 *                   makes one outlier flatten everything beneath it
 *                   to nearly zero, which is the same mistake the
 *                   revenue chart's axis capping exists to fix.
 *   REGRESSED 0.20  Did it move BACKWARDS through the pipeline. A
 *                   rare, deliberate, human act — someone looked at
 *                   this deal and concluded it was less advanced than
 *                   they thought. Decays over ~90 days, because a
 *                   regression from last year is history, not news.
 *   UNSET     0.15  Missing next step and/or close date. Not risk in
 *                   itself; risk that nobody can see. A large stalled
 *                   deal with neither is one no one is actually
 *                   running.
 *
 * Weights sum to 1.0, so the composite is always 0–1 and comparable
 * across tenants of any size.
 *
 * DELIBERATELY NOT INCLUDED: `severity` from `staleDealsRunner`. It is
 * derived from the same staleness signals this already reads, so
 * folding it in would double-count age against the other three
 * factors. It remains the right thing to drive the row's colour.
 */

/** Weights, as documented above. Exported so a test can assert they sum to 1. */
export const ATTENTION_WEIGHTS = {
  stalled: 0.35,
  value: 0.3,
  regressed: 0.2,
  unset: 0.15,
} as const;

/** Staleness saturates here — beyond it, older is not meaningfully worse. */
export const STALL_SATURATION_DAYS = 120;
/** A regression stops counting once it is this old. */
export const REGRESSION_DECAY_DAYS = 90;

export type AttentionFactor = 'stalled' | 'value' | 'regressed' | 'unset';

export type AttentionInput = {
  /**
   * Days since the last activity of any kind. `null` means nothing has
   * EVER been logged, which is treated as maximally stale — an
   * untouched deal is not a fresh one.
   */
  daysSinceActivity: number | null;
  amountMinor: number;
  /** Days since the last backwards stage move; null if it never went back. */
  daysSinceRegression: number | null;
  hasNextStep: boolean;
  hasCloseDate: boolean;
};

export type AttentionScore = {
  /** Composite, 0–1. Higher = needs attention sooner. */
  score: number;
  /** Each factor's own 0–1 contribution, before weighting. */
  factors: Record<AttentionFactor, number>;
  /** The factor contributing most AFTER weighting — drives the reason line. */
  topFactor: AttentionFactor;
  /** One-line human reason, e.g. "High value, no activity 91d". */
  reason: string;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Log-scaled value score against the largest deal in the same queue.
 *
 * Linear would be wrong for the same reason a shared linear axis was
 * wrong on the revenue chart: one ₹20 crore deal drives every ₹50 lakh
 * deal to ~0.02, and the factor stops discriminating between any of
 * them. log1p keeps the ordering while preserving spread across
 * several orders of magnitude.
 */
function valueScore(amountMinor: number, maxAmountMinor: number): number {
  if (amountMinor <= 0 || maxAmountMinor <= 0) return 0;
  return clamp01(Math.log1p(amountMinor) / Math.log1p(maxAmountMinor));
}

export function scoreAttention(
  input: AttentionInput,
  /** Largest amount across the queue being ranked — the value yardstick. */
  maxAmountMinor: number,
): AttentionScore {
  // Never logged reads as fully stalled, not as brand new.
  const days = input.daysSinceActivity ?? STALL_SATURATION_DAYS;
  const stalled = clamp01(days / STALL_SATURATION_DAYS);

  const value = valueScore(input.amountMinor, maxAmountMinor);

  const regressed =
    input.daysSinceRegression === null
      ? 0
      : clamp01(1 - input.daysSinceRegression / REGRESSION_DECAY_DAYS);

  // Half a point each — a deal missing both is fully unmanaged.
  const unset =
    (input.hasNextStep ? 0 : 0.5) + (input.hasCloseDate ? 0 : 0.5);

  const factors: Record<AttentionFactor, number> = {
    stalled,
    value,
    regressed,
    unset,
  };

  const score =
    stalled * ATTENTION_WEIGHTS.stalled +
    value * ATTENTION_WEIGHTS.value +
    regressed * ATTENTION_WEIGHTS.regressed +
    unset * ATTENTION_WEIGHTS.unset;

  // Rank by WEIGHTED contribution: a factor scoring 1.0 on the lightest
  // weight should not outrank one scoring 0.9 on the heaviest.
  // Tie-break in a fixed order so the reason line is deterministic —
  // an attention queue that reshuffles its own explanations between
  // identical renders is not one anybody will trust.
  const order: AttentionFactor[] = ['regressed', 'value', 'stalled', 'unset'];
  let topFactor: AttentionFactor = 'stalled';
  let best = -1;
  for (const f of order) {
    const weighted = factors[f] * ATTENTION_WEIGHTS[f];
    if (weighted > best) {
      best = weighted;
      topFactor = f;
    }
  }

  return {
    score,
    factors,
    topFactor,
    reason: buildReason(topFactor, input, factors),
  };
}

/**
 * A regression this strong gets named even when it is not the top
 * factor. Value carries more weight than regression by design, so a
 * large deal that slid backwards yesterday reports `value` as its top
 * factor — and a reason line that then said only "High value, no
 * activity 12d" would have buried the single most alarming thing about
 * it. Leading with the top factor is right; dropping the backwards
 * move to do so is not.
 */
const REGRESSION_WORTH_MENTIONING = 0.5;

/**
 * The one-line "why is this here". Leads with the top factor, then
 * adds the single most useful corroborating detail — enough to act on
 * without opening the deal, short enough for one line in a list.
 *
 * Only ONE detail follows the lead clause. Three-clause reasons stop
 * being scannable, which defeats the purpose of a triage queue.
 */
function buildReason(
  top: AttentionFactor,
  input: AttentionInput,
  factors: Record<AttentionFactor, number>,
): string {
  const idle =
    input.daysSinceActivity === null
      ? 'no activity ever'
      : `no activity ${input.daysSinceActivity}d`;

  const d = input.daysSinceRegression;
  const slipped = `moved backwards ${d === null ? 'recently' : d === 0 ? 'today' : `${d}d ago`}`;
  // A fresh regression outranks idleness as the corroborating detail:
  // "it went backwards" tells you more than "nobody touched it".
  const detail =
    top !== 'regressed' && factors.regressed >= REGRESSION_WORTH_MENTIONING
      ? slipped
      : null;

  switch (top) {
    case 'regressed':
      return `${slipped.charAt(0).toUpperCase()}${slipped.slice(1)}, ${idle}`;
    case 'value': {
      const size = factors.value >= 0.9 ? 'Largest deals' : 'High value';
      return `${size} in the queue, ${detail ?? idle}`;
    }
    case 'stalled': {
      const missing = detail ?? describeMissing(input);
      return missing ? `Stalled — ${idle}, ${missing}` : `Stalled — ${idle}`;
    }
    case 'unset': {
      const missing = describeMissing(input) ?? 'unmanaged';
      // Capitalise: this one leads the sentence.
      return `${missing.charAt(0).toUpperCase()}${missing.slice(1)}, ${detail ?? idle}`;
    }
  }
}

function describeMissing(input: AttentionInput): string | null {
  if (!input.hasNextStep && !input.hasCloseDate) {
    return 'no next step or close date';
  }
  if (!input.hasNextStep) return 'no next step';
  if (!input.hasCloseDate) return 'no close date';
  return null;
}

/**
 * Rank a queue. Computes the value yardstick from the rows themselves,
 * so a small workspace's biggest deal is scored as "big" without any
 * per-tenant configuration.
 *
 * Ties break on raw amount, then deal id, so the order is stable across
 * renders rather than depending on however the rows arrived.
 */
export function rankAttentionQueue<T extends AttentionInput & { dealId: string }>(
  rows: T[],
): Array<T & { attention: AttentionScore }> {
  const maxAmountMinor = rows.reduce((m, r) => Math.max(m, r.amountMinor), 0);
  return rows
    .map((r) => ({ ...r, attention: scoreAttention(r, maxAmountMinor) }))
    .sort(
      (a, b) =>
        b.attention.score - a.attention.score ||
        b.amountMinor - a.amountMinor ||
        a.dealId.localeCompare(b.dealId),
    );
}
