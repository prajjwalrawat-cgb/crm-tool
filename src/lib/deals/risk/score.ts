import type { DealStage } from '@/db/schema';

/**
 * DEAL RISK SCORE (Phase 1) — a deterministic, rules-based 0–100 estimate of
 * how likely an open deal is to slip or die, assembled from signals this
 * product already computes elsewhere.
 *
 * NOT A MODEL. Identical inputs always produce an identical score, every
 * point is attributed to a named factor, and nothing here is learned from
 * data. The UI says "rules-based" out loud for that reason: a number that
 * looks like a prediction but is really a weighted checklist should not be
 * allowed to borrow the authority of one that was trained and backtested.
 * Phase 2 (a trained win-probability / close-date model) is gated behind
 * stated data-volume and accuracy thresholds — see `docs/deal-risk.md`.
 *
 * ---------------------------------------------------------------
 * HIGHER IS WORSE, WHICH IS THE OPPOSITE OF THE HEALTH SCORE
 * ---------------------------------------------------------------
 * `@/lib/deals/scoring/compute` already produces a 0–100 HEALTH score where
 * high is good. This is a RISK score where high is bad, over a different
 * (overlapping) signal set. Two inverted scores on one deal is a real
 * usability hazard, so:
 *
 *   · they share their inputs rather than each deriving their own — the
 *     time-in-stage median comes from `getWorkspaceStageMedians`, the one
 *     the health score uses, so the two can never disagree about it;
 *   · every surface that renders risk labels it "Risk" and states the
 *     direction, and the deal card shows health beside it rather than
 *     letting a reader guess which way each points.
 *
 * ---------------------------------------------------------------
 * THE WEIGHTS SUM TO 100, ON PURPOSE
 * ---------------------------------------------------------------
 * Each of the five factor groups has a documented maximum, and those maxima
 * total exactly 100. The score is therefore readable as "what share of the
 * things that can go wrong on a deal are going wrong here", not as an
 * arbitrary index that happens to land in 0–100. A deal at 100 has every
 * signal at its worst; a deal at 0 has none of them.
 */

export type RiskBand = 'low' | 'elevated' | 'high';

/** Every input the rubric reads. Resolved by the caller; nothing is fetched here. */
export type DealRiskSignals = {
  stage: DealStage;
  /** Forward close-date moves on this deal (deals.push_count, 0058). */
  pushCount: number;
  /** Days added since the original commitment (deals.total_slip_days). */
  totalSlipDays: number;
  /**
   * Days since any write to the deal row — the same signal behind the
   * Quiet / Silent labels on Team Performance. Null when unknown.
   */
  daysSinceLastTouch: number | null;
  /** Completeness at the CURRENT stage (see `@/lib/deals/completeness`). */
  completenessFilled: number;
  completenessApplicable: number;
  /** Days in the current stage, and the workspace median for that stage. */
  timeInStageDays: number;
  stageMedianDays: number;
  /** Deal age, and the workspace average won-deal cycle length. */
  dealAgeDays: number;
  avgCycleDays: number;
};

export type RiskFactor = {
  /** Stable id for grouping and for the explanation prompt. */
  key: string;
  /** Short human label, e.g. "Pushed 3x". */
  label: string;
  /** Risk points contributed. Always > 0 — a factor at 0 is not a factor. */
  points: number;
  /** One clause of plain English naming the actual numbers. */
  detail: string;
};

export type RiskResult = {
  /** 0–100, higher = more risk. */
  score: number;
  band: RiskBand;
  /** Contributing factors, heaviest first. Sums to `score` before clamping. */
  factors: RiskFactor[];
};

/* ---------------------------------------------------------------
 * Group maxima — these five numbers are the whole formula.
 * --------------------------------------------------------------- */

export const RISK_WEIGHTS = {
  /** Chronic rescheduling: the single strongest slip signal we have. */
  pushback: 30,
  /** Nobody has touched it. Second strongest, and the most actionable. */
  silence: 25,
  /** The deal is missing the fields its own stage requires. */
  completeness: 20,
  /** Sitting in one stage far longer than this workspace normally does. */
  timeInStage: 15,
  /** Older than a typical won deal takes, end to end. */
  age: 10,
} as const;

/** 30 + 25 + 20 + 15 + 10. Asserted by the self-test. */
export const RISK_MAX =
  RISK_WEIGHTS.pushback +
  RISK_WEIGHTS.silence +
  RISK_WEIGHTS.completeness +
  RISK_WEIGHTS.timeInStage +
  RISK_WEIGHTS.age;

/** At or above this, a deal is High risk. */
export const RISK_HIGH_FROM = 60;
/** At or above this, Elevated. Below it, Low. */
export const RISK_ELEVATED_FROM = 30;

export function bandForRisk(score: number): RiskBand {
  if (score >= RISK_HIGH_FROM) return 'high';
  if (score >= RISK_ELEVATED_FROM) return 'elevated';
  return 'low';
}

export const RISK_BAND_LABELS: Record<RiskBand, string> = {
  low: 'Low risk',
  elevated: 'Elevated risk',
  high: 'High risk',
};

/**
 * Used when a workspace has too few won deals to have a meaningful average
 * cycle. Deliberately generous — a made-up short cycle would mark every deal
 * in a young workspace as overdue on day one.
 */
export const FALLBACK_AVG_CYCLE_DAYS = 90;
/** Won deals required before a workspace's own average is trusted. */
export const MIN_WON_DEALS_FOR_CYCLE = 10;

/**
 * Below this median, the time-in-stage factor ABSTAINS rather than scoring.
 *
 * Found on live data: one workspace's median time in Qualified came back as
 * 2 days, so every genuinely-worked deal was "more than twice the median" and
 * collected the full 15 points. The median was not wrong — it was measured
 * over bulk-imported deals that passed through Qualified in minutes — but a
 * benchmark of two days cannot distinguish a stalled deal from a normal one,
 * and a factor that fires on everything carries no information while inflating
 * every score in the workspace.
 *
 * Abstaining is the honest response to a benchmark that is too compressed to
 * measure against, and it matches how `getWorkspaceStageMedians` already
 * refuses to trust a stage with fewer than ten completed transitions.
 */
export const MIN_MEANINGFUL_STAGE_MEDIAN_DAYS = 5;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function computeDealRisk(signals: DealRiskSignals): RiskResult {
  const factors: RiskFactor[] = [];
  const add = (key: string, label: string, points: number, detail: string) => {
    if (points > 0) factors.push({ key, label, points, detail });
  };

  /* -------- 1. Pushback (max 30) --------
   * Counted twice on purpose, capped at the group maximum: HOW OFTEN a date
   * moved and HOW FAR it moved are different failures. Four one-day slips is
   * a rep managing a date; one 90-day slip is a deal that left the quarter. */
  {
    const p = Math.max(0, signals.pushCount);
    let points =
      p >= 4 ? 26 : p === 3 ? 20 : p === 2 ? 12 : p === 1 ? 6 : 0;
    let detail =
      p > 0
        ? `Close date pushed ${p} ${plural(p, 'time', 'times')}`
        : '';
    const slip = Math.max(0, signals.totalSlipDays);
    if (slip >= 60) {
      points += 8;
      detail = `${detail}, ${slip} days later than first committed`;
    } else if (slip >= 30) {
      points += 4;
      detail = `${detail}, ${slip} days later than first committed`;
    }
    add(
      'pushback',
      p > 0 ? `Pushed ${p}x` : 'Pushed',
      Math.min(points, RISK_WEIGHTS.pushback),
      detail,
    );
  }

  /* -------- 2. Silence (max 25) --------
   * `daysSinceLastTouch` moves on any write to the deal, which overstates
   * attention slightly and understates it never — the same caveat the
   * engagement table carries. Null (unknowable) scores zero rather than
   * worst-case: an unknown is not evidence of neglect. */
  if (signals.daysSinceLastTouch != null) {
    const d = signals.daysSinceLastTouch;
    const points = d >= 60 ? 25 : d >= 30 ? 20 : d >= 14 ? 15 : d >= 8 ? 6 : 0;
    add(
      'silence',
      `Untouched ${d}d`,
      points,
      `No change to the deal in ${d} ${plural(d, 'day', 'days')}`,
    );
  }

  /* -------- 3. Completeness at stage (max 20) --------
   * Stage-aware by construction: the caller passes filled/applicable from
   * the completeness spec, which already excludes fields a deal at this
   * stage does not owe. A Lead is not penalised for a missing margin. */
  if (signals.completenessApplicable > 0) {
    const ratio = signals.completenessFilled / signals.completenessApplicable;
    const missing = signals.completenessApplicable - signals.completenessFilled;
    const points =
      ratio < 0.25 ? 20 : ratio < 0.5 ? 15 : ratio < 0.75 ? 10 : ratio < 0.9 ? 5 : 0;
    add(
      'completeness',
      `${Math.round(ratio * 100)}% complete`,
      points,
      `${missing} of ${signals.completenessApplicable} required ${plural(
        missing,
        'field is',
        'fields are',
      )} empty at ${signals.stage}`,
    );
  }

  /* -------- 4. Time in stage vs the workspace median (max 15) --------
   * Relative, never absolute: 40 days in Negotiation is normal in one
   * workspace and a stall in another. The median comes from
   * `getWorkspaceStageMedians`, the same one the health score reads.
   *
   * Abstains when that median is too small to mean anything — see
   * MIN_MEANINGFUL_STAGE_MEDIAN_DAYS. */
  if (
    signals.stageMedianDays >= MIN_MEANINGFUL_STAGE_MEDIAN_DAYS &&
    signals.timeInStageDays > 0
  ) {
    const ratio = signals.timeInStageDays / signals.stageMedianDays;
    const points = ratio > 2 ? 15 : ratio > 1.5 ? 10 : ratio > 1 ? 5 : 0;
    add(
      'time_in_stage',
      `${ratio.toFixed(1)}x median`,
      points,
      `${signals.timeInStageDays} days in ${signals.stage} against a workspace median of ${Math.round(
        signals.stageMedianDays,
      )}`,
    );
  }

  /* -------- 5. Deal age vs the average won cycle (max 10) --------
   * The weakest weight of the five, because a long deal is not automatically
   * a bad one — enterprise cycles are long by nature. It earns its place as
   * a tiebreaker, not as an accusation. */
  if (signals.avgCycleDays > 0 && signals.dealAgeDays > 0) {
    const ratio = signals.dealAgeDays / signals.avgCycleDays;
    const points = ratio > 2 ? 10 : ratio > 1.5 ? 7 : ratio > 1 ? 4 : 0;
    add(
      'age',
      `${ratio.toFixed(1)}x avg cycle`,
      points,
      `Open ${signals.dealAgeDays} days against an average won-deal cycle of ${Math.round(
        signals.avgCycleDays,
      )}`,
    );
  }

  factors.sort((a, b) => b.points - a.points || a.key.localeCompare(b.key));
  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, band: bandForRisk(score), factors };
}

/**
 * The deterministic explanation — the top factors joined into one sentence.
 *
 * This is what renders when the LLM explanation is absent: no API key, the
 * call failed, or the deal has not been through the explainer yet. It is
 * never a placeholder like "generating…", because a scorecard that says
 * "generating" for a week is indistinguishable from one that is broken, and
 * the factor details are already plain English.
 */
export function deterministicExplanation(result: RiskResult): string {
  if (result.factors.length === 0) {
    return 'No risk signals on this deal.';
  }
  const top = result.factors.slice(0, 3).map((f) => f.detail);
  return `${top.join('; ')}.`;
}
