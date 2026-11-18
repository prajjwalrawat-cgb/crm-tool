/**
 * Pure metric math for the manager reports. Client-safe. Every derived
 * number (rates, deltas, medians, funnel steps) is computed here, from
 * counters the SQL layer returns — so the arithmetic is tested against
 * hand-computed fixtures, independent of the SQL that produces the inputs.
 */

/** The additive counters a day/owner/source bucket carries (rollup columns). */
export type FactCounters = {
  leadsCreated: number;
  leadsAssigned: number;
  firstTouchCount: number;
  firstTouchWithinSla: number;
  callsMade: number;
  callsConnected: number;
  talkTimeSec: number;
  emailsSent: number;
  whatsappSent: number;
  meetingsHeld: number;
  activities: number;
  qualified: number;
  quotesSent: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
};

export const FACT_COUNTER_KEYS: (keyof FactCounters)[] = [
  'leadsCreated',
  'leadsAssigned',
  'firstTouchCount',
  'firstTouchWithinSla',
  'callsMade',
  'callsConnected',
  'talkTimeSec',
  'emailsSent',
  'whatsappSent',
  'meetingsHeld',
  'activities',
  'qualified',
  'quotesSent',
  'wonCount',
  'wonValue',
  'lostCount',
];

export function emptyCounters(): FactCounters {
  return Object.fromEntries(FACT_COUNTER_KEYS.map((k) => [k, 0])) as FactCounters;
}

export function addCounters(a: FactCounters, b: Partial<FactCounters>): FactCounters {
  const out = { ...a };
  for (const k of FACT_COUNTER_KEYS) out[k] = round2(out[k] + Number(b[k] ?? 0));
  return out;
}

export function sumCounters(rows: Partial<FactCounters>[]): FactCounters {
  return rows.reduce<FactCounters>((acc, r) => addCounters(acc, r), emptyCounters());
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** a / b, or null when the denominator is zero (render "—", never "0%"). */
export function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

/** Percentage 0-100 to one decimal, or null. */
export function pct(a: number, b: number): number | null {
  const r = ratio(a, b);
  return r === null ? null : round1(r * 100);
}

export type Delta = {
  current: number | null;
  previous: number | null;
  absolute: number | null;
  /** Percent change vs previous, one decimal; null when previous is 0/null. */
  percent: number | null;
};

export function delta(current: number | null, previous: number | null): Delta {
  if (current === null || previous === null) {
    return { current, previous, absolute: null, percent: null };
  }
  const absolute = round2(current - previous);
  const percent = previous !== 0 ? round1(((current - previous) / Math.abs(previous)) * 100) : null;
  return { current, previous, absolute, percent };
}

/** Median of a numeric list (average of the middle two for even n); null when empty. */
export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/**
 * Linear-interpolation percentile (same as Postgres percentile_cont), p in
 * [0, 100]; null when empty.
 */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0]!;
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (rank - lo);
}

/* ------------------------------------------------------------------ funnel */

export const FUNNEL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type FunnelLead = {
  dealId: string;
  /** Every stage the lead ever entered, any order, repeats allowed. */
  stagesEntered: string[];
  /** First time it entered each stage (ISO), for median days between stages. */
  firstEnteredAt?: Partial<Record<string, string>>;
};

export type FunnelStep = {
  stage: FunnelStage;
  /** Distinct leads that reached this stage. */
  count: number;
  /** count / previous step count, percent; null for the first step. */
  stepConversionPct: number | null;
  /** count / cohort size, percent. */
  cohortPct: number | null;
  /** Median days from reaching the previous step to reaching this one. */
  medianDaysFromPrevious: number | null;
};

/**
 * Cohort funnel. The cohort is the leads passed in (created in the range).
 *
 * A lead REACHED a stage if it ever entered that stage OR any later funnel
 * stage. So a lead that jumps lead → proposal counts at qualified too (it
 * got past qualification), which keeps every step a subset of the one
 * before and stage-to-stage conversion ≤ 100%. A lead that regresses
 * (proposal → qualified) or re-enters a stage still counts once per stage.
 * Hold and lost are not funnel stages.
 */
const FUNNEL_RANK = new Map<string, number>(FUNNEL_STAGES.map((s, i) => [s, i]));

/**
 * Index of the furthest funnel stage a lead reached (0 = lead … 4 = won).
 * Every cohort lead is at least a lead, even if its history starts later.
 * The funnel counts AND its drill-down both use this, so they reconcile.
 */
export function maxFunnelRank(stagesEntered: string[]): number {
  let maxRank = 0;
  for (const s of stagesEntered) {
    const r = FUNNEL_RANK.get(s);
    if (r !== undefined && r > maxRank) maxRank = r;
  }
  return maxRank;
}

export function computeFunnel(leads: FunnelLead[]): FunnelStep[] {
  const reachedCount = FUNNEL_STAGES.map(() => 0);
  const gaps: number[][] = FUNNEL_STAGES.map(() => []);

  for (const lead of leads) {
    const maxRank = maxFunnelRank(lead.stagesEntered);
    for (let i = 0; i <= maxRank; i++) reachedCount[i]!++;

    const at = lead.firstEnteredAt ?? {};
    for (let i = 1; i <= maxRank; i++) {
      const prev = at[FUNNEL_STAGES[i - 1]!];
      const cur = at[FUNNEL_STAGES[i]!];
      if (prev && cur) {
        const days = (Date.parse(cur) - Date.parse(prev)) / 86_400_000;
        if (days >= 0) gaps[i]!.push(days);
      }
    }
  }

  const cohort = leads.length;
  return FUNNEL_STAGES.map((stage, i) => {
    const m = median(gaps[i]!);
    return {
      stage,
      count: reachedCount[i]!,
      stepConversionPct: i === 0 ? null : pct(reachedCount[i]!, reachedCount[i - 1]!),
      cohortPct: pct(reachedCount[i]!, cohort),
      medianDaysFromPrevious: i === 0 || m === null ? null : round1(m),
    };
  });
}

/* --------------------------------------------------------------- movers */

export type MoverInput = { key: string; label: string; current: number; previous: number };
export type Mover = MoverInput & { absolute: number; percent: number | null };

/** Top-N by absolute change, largest first. */
export function topMovers(rows: MoverInput[], n = 5): Mover[] {
  return rows
    .map((r) => {
      const d = delta(r.current, r.previous);
      return { ...r, absolute: d.absolute ?? 0, percent: d.percent };
    })
    .filter((r) => r.absolute !== 0)
    .sort((a, b) => Math.abs(b.absolute) - Math.abs(a.absolute))
    .slice(0, n);
}

/** Heat colour band of a cell against the team median: -2..2 (accessible, also labelled). */
export function bandVsMedian(value: number | null, teamMedian: number | null, higherIsBetter = true): -2 | -1 | 0 | 1 | 2 {
  if (value === null || teamMedian === null || teamMedian === 0) return 0;
  const r = (value - teamMedian) / Math.abs(teamMedian);
  const signed = higherIsBetter ? r : -r;
  if (signed >= 0.5) return 2;
  if (signed >= 0.15) return 1;
  if (signed <= -0.5) return -2;
  if (signed <= -0.15) return -1;
  return 0;
}
