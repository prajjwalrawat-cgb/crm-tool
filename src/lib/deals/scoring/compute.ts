import type { DealStage } from '@/db/schema';

/**
 * Module 2 — Deal Health Score. A deterministic, weighted, rule-based
 * Opportunity Score (0–100). NOT an ML model and NOT an LLM call: identical
 * input always yields the identical score, and every point of deviation from
 * the baseline 50 is explained in `reasons`.
 *
 * This file is intentionally dependency-free (types only) so it can be unit
 * tested in isolation and, if ever needed, run on either side of the wire. All
 * DB gathering + median resolution happens in the service layer, which hands a
 * fully-resolved context to this pure function.
 */

export type ScoreBand = 'strong' | 'moderate' | 'at_risk';

export type ScoreReason = {
  /** Stable signal id (for grouping / analytics), e.g. 'activity_recent'. */
  signal: string;
  /** Points applied (can be negative). */
  delta: number;
  /** Plain-language explanation shown in the UI, e.g. "No activity in 26 days". */
  detail: string;
};

export type ScoreResult = {
  score: number;
  band: ScoreBand;
  reasons: ScoreReason[];
};

/**
 * Everything the rubric needs, fully resolved by the caller. `now` is passed in
 * (never read from the clock here) so the function stays pure and testable.
 */
export type DealScoreContext = {
  now: Date;
  stage: DealStage;
  /** Most recent genuine (call/meeting/email) activity, or null if none ever. */
  lastGenuineActivityAt: Date | null;
  /** Days the deal has occupied its current stage. */
  timeInStageDays: number;
  /** Workspace median days-in-stage for this stage (fallback-resolved). */
  stageMedianDays: number;
  /** ISO date string 'YYYY-MM-DD', or null. */
  expectedCloseDate: string | null;
  stakeholderCount: number;
  nextStep: string | null;
  openTaskCount: number;
  overdueTaskCount: number;
  amountMinor: number;
};

const BASELINE = 50;
const MS_PER_DAY = 86_400_000;

function daysSince(now: Date, then: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY);
}

/** Whole days from `now` (00:00 UTC) to an ISO date; negative = in the past. */
function daysUntilDate(now: Date, iso: string): number | null {
  const target = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return Math.round((target.getTime() - today.getTime()) / MS_PER_DAY);
}

function isProposalOrLater(stage: DealStage): boolean {
  return stage === 'proposal' || stage === 'negotiation' || stage === 'won';
}

export function bandForScore(score: number): ScoreBand {
  if (score >= 70) return 'strong';
  if (score >= 40) return 'moderate';
  return 'at_risk';
}

/**
 * Compute the 0–100 health score. Deltas are applied from a baseline of 50 and
 * every non-zero delta is recorded in `reasons`, so `50 + Σ reasons.delta`
 * equals the pre-clamp score exactly.
 */
export function computeDealScore(ctx: DealScoreContext): ScoreResult {
  const reasons: ScoreReason[] = [];
  const add = (signal: string, delta: number, detail: string) => {
    if (delta !== 0) reasons.push({ signal, delta, detail });
  };

  /* -------- genuine activity recency -------- */
  if (ctx.lastGenuineActivityAt == null) {
    add('activity_none', -25, 'No genuine activity ever logged');
  } else {
    const d = daysSince(ctx.now, ctx.lastGenuineActivityAt);
    if (d <= 7) {
      add('activity_recent', +15, `Active in the last ${Math.max(d, 0)} day${d === 1 ? '' : 's'}`);
    } else if (d <= 14) {
      add('activity_ok', +5, `Last activity ${d} days ago`);
    } else if (d > 21) {
      add('activity_stale', -20, `No activity in ${d} days`);
    }
    // 15–21 days: neutral, no reason emitted.
  }

  /* -------- time in stage vs workspace median -------- */
  if (ctx.stageMedianDays > 0) {
    if (ctx.timeInStageDays <= ctx.stageMedianDays) {
      add(
        'stage_on_pace',
        +10,
        `Moving on pace (${ctx.timeInStageDays}d ≤ ${ctx.stageMedianDays}d median)`,
      );
    } else if (ctx.timeInStageDays > ctx.stageMedianDays * 2) {
      add(
        'stage_stalled',
        -15,
        `Stuck in stage (${ctx.timeInStageDays}d > 2× ${ctx.stageMedianDays}d median)`,
      );
    }
  }

  /* -------- expected close date -------- */
  if (ctx.expectedCloseDate) {
    const until = daysUntilDate(ctx.now, ctx.expectedCloseDate);
    if (until != null) {
      if (until < 0) {
        add('close_overdue', -20, `Expected close was ${-until} day${until === -1 ? '' : 's'} ago`);
      } else if (until <= 30 && isProposalOrLater(ctx.stage)) {
        add('close_imminent', +10, `Closing within 30 days at ${ctx.stage}`);
      }
    }
  }

  /* -------- stakeholders -------- */
  if (ctx.stakeholderCount >= 1) {
    add('has_stakeholders', +10, `${ctx.stakeholderCount} stakeholder(s) linked`);
  }

  /* -------- next step -------- */
  if (typeof ctx.nextStep === 'string' && ctx.nextStep.trim().length > 0) {
    add('has_next_step', +5, 'Next step defined');
  }

  /* -------- tasks -------- */
  if (ctx.overdueTaskCount > 0) {
    add('tasks_overdue', -10, `${ctx.overdueTaskCount} overdue task(s)`);
  } else if (ctx.openTaskCount > 0) {
    add('tasks_on_track', +5, `${ctx.openTaskCount} open task(s), none overdue`);
  }

  /* -------- amount -------- */
  if (ctx.amountMinor === 0) {
    add('no_amount', -15, 'Deal amount is ₹0');
  }

  const raw = BASELINE + reasons.reduce((sum, r) => sum + r.delta, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { score, band: bandForScore(score), reasons };
}
