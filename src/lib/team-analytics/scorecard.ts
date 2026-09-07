import 'server-only';

import { computeCoverage, type Coverage } from '@/lib/dashboard/coverage';
import {
  DEAL_FIELD_SPECS,
  type FieldGroupKey,
} from '@/lib/deals/completeness';
import { fiscalYearRange } from '@/lib/targets/fiscal';
import {
  fiscalQuarters,
  pace,
  splitAnnualTarget,
  type FiscalQuarter,
  type Pace,
} from '@/lib/targets/quarters';
import { listTargets, targetAchievement } from '@/lib/targets/queries';
import { listTeammates } from '@/lib/teammates/queries';

import {
  completenessByOwner,
  engagementByOwner,
  pushbackLeaderboard,
  pushbackRecordedSince,
  quarterlyAchievement,
  requiredDealCustomFields,
  type CompletenessRow,
  type EngagementRow,
  type PushbackRow,
} from './queries';

/**
 * THE TEAM SCORECARD — one row per rep, assembled from the four
 * aggregates in `./queries` plus the annual target machinery that already
 * exists.
 *
 * This module is composition and nothing else: no arithmetic that isn't
 * already defined somewhere with its reasoning next to it. Attainment
 * comes from `targetAchievement`, coverage from `@/lib/dashboard/coverage`,
 * pace from `@/lib/targets/quarters`. The scorecard's job is to put them
 * on one screen, not to invent a fifth number that blends them.
 *
 * ---------------------------------------------------------------
 * ONE FISCAL YEAR, TWO CLOCKS
 * ---------------------------------------------------------------
 * The page has a single control (the fiscal-year select), so everything
 * windowed is FISCAL-YEAR-TO-DATE: from the year's start to now, or to the
 * year's end when looking at a year that has finished.
 *
 * Three figures deliberately ignore that window because they are states,
 * not histories — open pipeline, untouched deals, and field completeness
 * are all "as of right now". Selecting FY2025 does not resurrect the
 * pipeline as it stood then, and pretending otherwise would be worse than
 * labelling it. Every renderer of those three says "today" out loud.
 */

export type ScorecardQuarter = {
  index: 1 | 2 | 3 | 4;
  label: string;
  /** Revenue attributed to this quarter (same rule as the annual figure). */
  revenueMinor: number;
  wonCount: number;
  /** Annual target ÷ 4 — DERIVED, not set by an admin. See `./quarters`. */
  targetMinor: number;
  /** True for the quarter `now` falls in. */
  isCurrent: boolean;
  /** True once the quarter has finished. */
  isComplete: boolean;
};

export type ScorecardRow = {
  userId: string;
  displayName: string;
  role: string | null;

  /* --- targets & attainment (from the targets module, unchanged) --- */
  revenueTargetMinor: number;
  fyRevenueMinor: number;
  tcvWonMinor: number;
  wonCount: number;
  pendingApprovalMinor: number;
  pendingApprovalCount: number;
  deweightedLossMinor: number;
  splitlessCount: number;

  /* --- derived views of the above --- */
  quarters: ScorecardQuarter[];
  pace: Pace;
  coverage: Coverage;

  /* --- the three engagement aggregates --- */
  pushback: PushbackRow;
  engagement: EngagementRow;
  completeness: CompletenessRow;
};

export type ScorecardField = {
  key: string;
  label: string;
  hint: string;
  /** Header group the scorecard renders this column under. */
  group: FieldGroupKey;
};

export type TeamScorecard = {
  rows: ScorecardRow[];
  /** Team totals, computed from the same rows the table renders. */
  team: {
    revenueTargetMinor: number;
    fyRevenueMinor: number;
    quarters: ScorecardQuarter[];
    pace: Pace;
    coverage: Coverage;
    pushEvents: number;
    daysPushed: number;
    dealsCreated: number;
    staleOpenDeals: number;
    openDeals: number;
    completeness: { applicable: number; filled: number };
    /** The single busiest rep-week in the window, for the headline stat. */
    bestWeek: { userId: string; displayName: string; count: number; weekStart: string } | null;
  };
  /** Scored data points, in render order — static fields then custom ones. */
  fields: ScorecardField[];
  quarterWindows: FiscalQuarter[];
  window: { from: Date; to: Date };
  fyStart: Date;
  fyEnd: Date;
  /**
   * When close-date logging began for this tenant, or null if nothing has
   * ever been logged. Rendered whenever it falls inside the window being
   * shown, because a zero before that date means "not recorded", not
   * "never happened".
   */
  pushbackRecordedSince: Date | null;
};

const EMPTY_PUSHBACK = (userId: string): PushbackRow => ({
  userId,
  pushEvents: 0,
  dealsPushed: 0,
  daysPushed: 0,
  pushedByOthers: 0,
  openPushedValueMinor: 0,
  deweightedCount: 0,
  worstDeal: null,
});

const EMPTY_ENGAGEMENT = (userId: string): EngagementRow => ({
  userId,
  dealsCreated: 0,
  createdValueMinor: 0,
  bestWeekStart: null,
  bestWeekCount: 0,
  activeWeeks: 0,
  openDeals: 0,
  openPipelineMinor: 0,
  staleOpenDeals: 0,
  oldestUntouchedDays: null,
  daysSinceLastTouch: null,
  daysSinceLastActivity: null,
  activityCount: 0,
});

const EMPTY_COMPLETENESS = (userId: string): CompletenessRow => ({
  userId,
  dealsScored: 0,
  byField: {},
  total: { applicable: 0, filled: 0 },
});

export async function getTeamScorecard(
  tenantId: string,
  tenantName: string,
  fiscalYear: number,
  startMonth: number,
  now: Date,
  opts: { onlyUserId?: string } = {},
): Promise<TeamScorecard> {
  const { start: fyStart, end: fyEnd } = fiscalYearRange(startMonth, fiscalYear);
  // Fiscal-year-to-date. A finished year uses its own end; a future year
  // collapses to an empty window rather than reaching backwards.
  const windowTo = new Date(
    Math.min(fyEnd.getTime(), Math.max(fyStart.getTime(), now.getTime())),
  );
  const window = { from: fyStart, to: windowTo };

  const customFields = await requiredDealCustomFields(tenantId);

  const [
    targets,
    achievement,
    quarterly,
    pushbacks,
    engagements,
    completeness,
    teammates,
    recordedSince,
  ] = await Promise.all([
    listTargets(tenantId, fiscalYear),
    targetAchievement(tenantId, fiscalYear, startMonth),
    quarterlyAchievement(tenantId, fiscalYear, startMonth),
    pushbackLeaderboard(tenantId, window),
    engagementByOwner(tenantId, window),
    completenessByOwner(tenantId, customFields),
    listTeammates(tenantId, tenantName),
    pushbackRecordedSince(tenantId),
  ]);

  const targetByUser = new Map(targets.map((t) => [t.userId, t]));
  const achByUser = new Map(achievement.map((a) => [a.userId, a]));
  const qByUser = new Map(quarterly.map((q) => [q.userId, q]));
  const pushByUser = new Map(pushbacks.map((p) => [p.userId, p]));
  const engByUser = new Map(engagements.map((e) => [e.userId, e]));
  const compByUser = new Map(completeness.map((c) => [c.userId, c]));

  const quarterWindows = fiscalQuarters(startMonth, fiscalYear);

  const rows: ScorecardRow[] = teammates
    .filter((t) => (opts.onlyUserId ? t.id === opts.onlyUserId : true))
    // Same cohort as the targets page — sales-facing roles, plus anyone
    // who has a target or has actually shown up in the data. Owners and
    // admins set targets rather than carry them, so they only appear if
    // they own deals.
    .filter(
      (t) =>
        t.role === 'manager' ||
        t.role === 'member' ||
        t.role === 'viewer' ||
        targetByUser.has(t.id) ||
        achByUser.has(t.id) ||
        pushByUser.has(t.id) ||
        engByUser.has(t.id) ||
        compByUser.has(t.id),
    )
    .map((t) => {
      const target = targetByUser.get(t.id);
      const ach = achByUser.get(t.id);
      const q = qByUser.get(t.id);
      const eng = engByUser.get(t.id) ?? EMPTY_ENGAGEMENT(t.id);
      const revenueTargetMinor = target?.revenueTargetMinor ?? 0;
      const fyRevenueMinor = ach?.fyRevenueMinor ?? 0;
      const quarterTargets = splitAnnualTarget(revenueTargetMinor);

      return {
        userId: t.id,
        displayName: t.displayName,
        role: t.role,
        revenueTargetMinor,
        fyRevenueMinor,
        tcvWonMinor: ach?.tcvWonMinor ?? 0,
        wonCount: ach?.wonCount ?? 0,
        pendingApprovalMinor: ach?.pendingApprovalMinor ?? 0,
        pendingApprovalCount: ach?.pendingApprovalCount ?? 0,
        deweightedLossMinor: ach?.deweightedLossMinor ?? 0,
        splitlessCount: ach?.splitlessCount ?? 0,
        quarters: quarterWindows.map((qw, i) =>
          buildQuarter(
            qw,
            q?.quarterRevenueMinor[i] ?? 0,
            q?.quarterWonCount[i] ?? 0,
            quarterTargets[i],
            now,
          ),
        ),
        pace: pace({
          achievedMinor: fyRevenueMinor,
          targetMinor: revenueTargetMinor,
          fyStart,
          fyEnd,
          now,
        }),
        coverage: computeCoverage({
          openPipelineMinor: eng.openPipelineMinor,
          targetMinor: revenueTargetMinor,
          achievedMinor: fyRevenueMinor,
        }),
        pushback: pushByUser.get(t.id) ?? EMPTY_PUSHBACK(t.id),
        engagement: eng,
        completeness: compByUser.get(t.id) ?? EMPTY_COMPLETENESS(t.id),
      };
    });

  // Most pushed first — the question the page was built to answer. Ties
  // fall back to attainment so the table has a stable order on a quiet
  // team (every rep at zero pushes).
  rows.sort(
    (a, b) =>
      b.pushback.pushEvents - a.pushback.pushEvents ||
      b.fyRevenueMinor - a.fyRevenueMinor ||
      a.displayName.localeCompare(b.displayName),
  );

  const team = buildTeamTotals(rows, quarterWindows, fyStart, fyEnd, now);

  const fields: ScorecardField[] = [
    ...DEAL_FIELD_SPECS.map((s) => ({
      key: s.key,
      label: s.label,
      hint: s.hint,
      group: s.group,
    })),
    ...customFields.map((c) => ({
      key: c.key,
      label: c.label,
      hint: 'Required custom field for this workspace',
      group: 'custom' as const,
    })),
  ];

  return {
    rows,
    team,
    fields,
    quarterWindows,
    window,
    fyStart,
    fyEnd,
    pushbackRecordedSince: recordedSince,
  };
}

function buildQuarter(
  qw: FiscalQuarter,
  revenueMinor: number,
  wonCount: number,
  targetMinor: number,
  now: Date,
): ScorecardQuarter {
  return {
    index: qw.index,
    label: qw.label,
    revenueMinor,
    wonCount,
    targetMinor,
    isCurrent: now >= qw.start && now < qw.end,
    isComplete: now >= qw.end,
  };
}

function buildTeamTotals(
  rows: ScorecardRow[],
  quarterWindows: FiscalQuarter[],
  fyStart: Date,
  fyEnd: Date,
  now: Date,
): TeamScorecard['team'] {
  const sum = (pick: (r: ScorecardRow) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);

  const revenueTargetMinor = sum((r) => r.revenueTargetMinor);
  const fyRevenueMinor = sum((r) => r.fyRevenueMinor);
  const quarterTargets = splitAnnualTarget(revenueTargetMinor);

  const quarters = quarterWindows.map((qw, i) =>
    buildQuarter(
      qw,
      sum((r) => r.quarters[i]?.revenueMinor ?? 0),
      sum((r) => r.quarters[i]?.wonCount ?? 0),
      quarterTargets[i],
      now,
    ),
  );

  let bestWeek: TeamScorecard['team']['bestWeek'] = null;
  for (const r of rows) {
    const { bestWeekCount, bestWeekStart } = r.engagement;
    if (!bestWeekStart || bestWeekCount <= 0) continue;
    if (!bestWeek || bestWeekCount > bestWeek.count) {
      bestWeek = {
        userId: r.userId,
        displayName: r.displayName,
        count: bestWeekCount,
        weekStart: bestWeekStart,
      };
    }
  }

  return {
    revenueTargetMinor,
    fyRevenueMinor,
    quarters,
    pace: pace({
      achievedMinor: fyRevenueMinor,
      targetMinor: revenueTargetMinor,
      fyStart,
      fyEnd,
      now,
    }),
    coverage: computeCoverage({
      openPipelineMinor: sum((r) => r.engagement.openPipelineMinor),
      targetMinor: revenueTargetMinor,
      achievedMinor: fyRevenueMinor,
    }),
    pushEvents: sum((r) => r.pushback.pushEvents),
    daysPushed: sum((r) => r.pushback.daysPushed),
    dealsCreated: sum((r) => r.engagement.dealsCreated),
    staleOpenDeals: sum((r) => r.engagement.staleOpenDeals),
    openDeals: sum((r) => r.engagement.openDeals),
    completeness: {
      applicable: sum((r) => r.completeness.total.applicable),
      filled: sum((r) => r.completeness.total.filled),
    },
    bestWeek,
  };
}
