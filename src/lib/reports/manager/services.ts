import 'server-only';

import { and, desc, eq, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { savedReports, type SavedReport } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { METRICS, costPer, metricValue, sourceRoi, type MetricKey } from '../metrics';
import { assignedWhere, callsTableExists, closedWhere, createdWhere, outboundCallWhere, type FactRow } from './facts';
import {
  FUNNEL_STAGES,
  bandVsMedian,
  computeFunnel,
  delta,
  emptyCounters,
  maxFunnelRank,
  median,
  pct,
  round1,
  round2,
  sumCounters,
  type Delta,
  type FactCounters,
  type FunnelLead,
  type FunnelStep,
} from './math';
import { getTenantTz, readFacts } from './rollup';
import { narrowToOwner, ownerIn, textArray, type ReportScope } from './scope';
import {
  addDays,
  compareRange,
  dayStartUtc,
  eachDay,
  localDay,
  monthStart,
  resolveRange,
  type CompareMode,
  type ResolvedRange,
  type Segment,
} from './time';

/**
 * Manager report services. Every function takes a `ReportScope` from
 * `scopeUsers` and returns plain JSON. Route handlers, pages, exports,
 * digests and the narrative all call these — nothing else computes a metric.
 */

type Rows<T> = T[];
const exec = async <T>(q: ReturnType<typeof sql>): Promise<Rows<T>> =>
  (await tenantTransaction((tx) => tx.execute(q))) as unknown as Rows<T>;

/* --------------------------------------------------------------- people */

export type Person = { id: string; name: string; email: string | null };

/** Display names for user ids (users is not under RLS; ids come from scoped rows). */
export async function peopleById(ids: string[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, Person>();
  if (unique.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, email, first_name, last_name FROM users WHERE id = ANY(${textArray(unique)})`)) as unknown as Array<{
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  }>;
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id;
    out.set(r.id, { id: r.id, name, email: r.email });
  }
  for (const id of unique) if (!out.has(id)) out.set(id, { id, name: id.startsWith('seed-actor-') ? id.replace('seed-actor-', '').replace(/-/g, ' ') : 'Unknown user', email: null });
  return out;
}

/** Active, non-viewer members in scope — the "reps" for per-rep averages. */
export async function repsInScope(scope: ReportScope): Promise<string[]> {
  const rows = await exec<{ user_id: string }>(sql`
    SELECT user_id FROM memberships
    WHERE tenant_id = ${scope.tenantId}::uuid AND status = 'active' AND role <> 'viewer'
      AND ${ownerIn(scope, sql`user_id`)}`);
  return rows.map((r) => r.user_id);
}

/** Lead sources for filters (id + name). */
export async function listSources(tenantId: string): Promise<Array<{ id: string; name: string }>> {
  return await exec<{ id: string; name: string }>(sql`SELECT id::text, name FROM lead_sources WHERE tenant_id = ${tenantId}::uuid ORDER BY name`);
}

/** Saved reports the user owns or receives on a schedule. */
export async function listSavedReportsFor(tenantId: string, userId: string): Promise<SavedReport[]> {
  return await tenantTransaction((tx) =>
    tx
      .select()
      .from(savedReports)
      .where(and(eq(savedReports.tenantId, tenantId), or(eq(savedReports.ownerId, userId), sql`${savedReports.schedule} -> 'recipients' ? ${userId}`)))
      .orderBy(desc(savedReports.updatedAt)),
  );
}

/* --------------------------------------------------------------- ranges */

export async function resolveForTenant(
  tenantId: string,
  q: { range?: string | null; from?: string | null; to?: string | null; compareTo?: string | null },
): Promise<{ range: ResolvedRange; compare: ResolvedRange | null; compareMode: CompareMode }> {
  const tz = await getTenantTz(tenantId);
  const range = resolveRange({ preset: q.range, from: q.from, to: q.to, tz });
  const compareMode: CompareMode = q.compareTo === 'yoy' ? 'yoy' : q.compareTo === 'none' ? 'none' : 'previous';
  return { range, compare: compareRange(range, compareMode), compareMode };
}

/* ---------------------------------------------------------- live metrics */

export type SlaStats = {
  assigned: number;
  due: number;
  met: number;
  breached: number;
  compliancePct: number | null;
  medianFirstResponseMin: number | null;
  p90FirstResponseMin: number | null;
};

/**
 * SLA + first response, live from lead_assignments. An assignment is "due"
 * once its deadline has passed or it has been answered; it "met" its SLA if
 * the first touch landed on or before the deadline.
 */
export async function slaStats(scope: ReportScope, range: ResolvedRange, groupBy: 'none' | 'owner' | 'source' = 'none') {
  const key = groupBy === 'owner' ? sql`a.assigned_to` : groupBy === 'source' ? sql`d.lead_source_id::text` : sql`''`;
  const rows = await exec<{
    k: string | null;
    assigned: number;
    due: number;
    met: number;
    med: number | null;
    p90: number | null;
  }>(sql`
    SELECT ${key} AS k,
           count(*)::int AS assigned,
           count(*) FILTER (WHERE a.first_touch_at IS NOT NULL OR a.sla_due_at < now())::int AS due,
           count(*) FILTER (WHERE a.first_touch_at IS NOT NULL AND a.first_touch_at <= a.sla_due_at)::int AS met,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.first_touch_at - a.assigned_at) / 60.0)
             FILTER (WHERE a.first_touch_at IS NOT NULL) AS med,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM a.first_touch_at - a.assigned_at) / 60.0)
             FILTER (WHERE a.first_touch_at IS NOT NULL) AS p90
    FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
    WHERE ${assignedWhere({ tenantId: scope.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz })}
      AND ${ownerIn(scope, sql`a.assigned_to`)}
    GROUP BY 1`);
  const toStats = (r: (typeof rows)[number] | undefined): SlaStats => {
    const assigned = Number(r?.assigned ?? 0);
    const due = Number(r?.due ?? 0);
    const met = Number(r?.met ?? 0);
    return {
      assigned,
      due,
      met,
      breached: due - met,
      compliancePct: pct(met, due),
      medianFirstResponseMin: r?.med == null ? null : round1(Number(r.med)),
      p90FirstResponseMin: r?.p90 == null ? null : round1(Number(r.p90)),
    };
  };
  if (groupBy === 'none') return { total: toStats(rows[0]), groups: new Map<string, SlaStats>() };
  return { total: toStats(undefined), groups: new Map(rows.map((r) => [r.k ?? '', toStats(r)])) };
}

export type PipelineSnapshot = {
  openCount: number;
  openValue: number;
  weightedValue: number;
  forecastThisMonth: number;
  byStage: Array<{ stage: string; count: number; value: number; weighted: number }>;
};

/** Open pipeline right now (snapshot), plus this month's weighted forecast. */
export async function pipelineSnapshot(scope: ReportScope, now = new Date()): Promise<PipelineSnapshot> {
  const settings = await getOrgSettings(scope.tenantId);
  const probs = resolveStageProbabilities(settings.stageProbabilities);
  const tz = await getTenantTz(scope.tenantId);
  const today = localDay(now, tz);
  const mStart = monthStart(today);
  const nextMonth = addDays(`${mStart.slice(0, 7)}-28`, 4).slice(0, 7) + '-01';
  const rows = await exec<{ stage: string; n: number; v: string; month_v: string }>(sql`
    SELECT d.stage::text AS stage, count(*)::int AS n, coalesce(sum(d.amount_minor), 0) / 100.0 AS v,
           coalesce(sum(d.amount_minor) FILTER (WHERE d.expected_close_date >= ${mStart}::date AND d.expected_close_date < ${nextMonth}::date), 0) / 100.0 AS month_v
    FROM deals d
    WHERE d.tenant_id = ${scope.tenantId}::uuid AND d.deleted_at IS NULL AND d.stage NOT IN ('won', 'lost')
      AND ${ownerIn(scope, sql`coalesce(d.owner_id, '')`)}
    GROUP BY 1`);
  const byStage = rows.map((r) => {
    const p = (probs[r.stage as keyof typeof probs] ?? 0) / 100;
    return { stage: r.stage, count: Number(r.n), value: round2(Number(r.v)), weighted: round2(Number(r.v) * p), monthWeighted: Number(r.month_v) * p };
  });
  return {
    openCount: byStage.reduce((a, r) => a + r.count, 0),
    openValue: round2(byStage.reduce((a, r) => a + r.value, 0)),
    weightedValue: round2(byStage.reduce((a, r) => a + r.weighted, 0)),
    forecastThisMonth: round2(byStage.reduce((a, r) => a + r.monthWeighted, 0)),
    byStage: byStage.map(({ stage, count, value, weighted }) => ({ stage, count, value, weighted })),
  };
}

export async function salesCycle(scope: ReportScope, range: ResolvedRange): Promise<{ median: number | null; p75: number | null; n: number }> {
  const [r] = await exec<{ med: number | null; p75: number | null; n: number }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.closed_at - d.created_at) / 86400.0) AS med,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM d.closed_at - d.created_at) / 86400.0) AS p75,
           count(*)::int AS n
    FROM deals d
    WHERE ${closedWhere({ tenantId: scope.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz }, 'won')}
      AND ${ownerIn(scope, sql`coalesce(d.owner_id, '')`)}`);
  return { median: r?.med == null ? null : round1(Number(r.med)), p75: r?.p75 == null ? null : round1(Number(r.p75)), n: Number(r?.n ?? 0) };
}

/* ------------------------------------------------------------ summary */

export type KpiTile = {
  key: MetricKey;
  label: string;
  unit: (typeof METRICS)[MetricKey]['unit'];
  higherIsBetter: boolean;
  description: string;
  value: number | null;
  delta: Delta | null;
  sparkline: Array<{ day: string; value: number | null }>;
  /** Drill-down metric key for /api/reports/drill, if the tile has one. */
  drill: string | null;
  note?: string;
};

export type Summary = {
  range: ResolvedRange;
  compare: ResolvedRange | null;
  tiles: KpiTile[];
  totals: FactCounters;
  previousTotals: FactCounters | null;
  reps: number;
  servedBy: Segment[];
  scopeFallback: boolean;
};

function seriesByDay(rows: FactRow[], range: ResolvedRange, key: MetricKey, reps: number) {
  const byDay = new Map<string, FactRow[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return eachDay(range.fromDay, range.toDay).map((day) => ({
    day,
    value: metricValue(key, sumCounters(byDay.get(day) ?? []), { reps, days: 1 }),
  }));
}

export async function summary(scope: ReportScope, range: ResolvedRange, compare: ResolvedRange | null): Promise<Summary> {
  const [cur, prev, reps, sla, prevSla, pipe] = await Promise.all([
    readFacts(scope, range),
    compare ? readFacts(scope, compare) : Promise.resolve(null),
    repsInScope(scope),
    slaStats(scope, range),
    compare ? slaStats(scope, compare) : Promise.resolve(null),
    pipelineSnapshot(scope),
  ]);
  const totals = sumCounters(cur.rows);
  const previousTotals = prev ? sumCounters(prev.rows) : null;
  const ctx = { reps: reps.length, days: range.days };
  const pctx = compare ? { reps: reps.length, days: compare.days } : ctx;

  const rollupTile = (key: MetricKey, drill: string | null): KpiTile => {
    const def = METRICS[key];
    const value = metricValue(key, totals, ctx);
    const previous = previousTotals ? metricValue(key, previousTotals, pctx) : null;
    return {
      key,
      label: def.label,
      unit: def.unit,
      higherIsBetter: def.higherIsBetter,
      description: def.description,
      value,
      delta: previousTotals ? delta(value, previous) : null,
      sparkline: seriesByDay(cur.rows, range, key, reps.length),
      drill,
    };
  };
  const liveTile = (key: MetricKey, value: number | null, previous: number | null, drill: string | null, note?: string): KpiTile => {
    const def = METRICS[key];
    return {
      key,
      label: def.label,
      unit: def.unit,
      higherIsBetter: def.higherIsBetter,
      description: def.description,
      value,
      delta: previous === undefined || compare === null ? null : delta(value, previous),
      sparkline: [],
      drill,
      note,
    };
  };

  const tiles: KpiTile[] = [
    rollupTile('lead_volume', 'lead_volume'),
    rollupTile('contact_rate', 'calls_made'),
    liveTile('sla_compliance_pct', sla.total.compliancePct, prevSla?.total.compliancePct ?? null, 'sla_compliance_pct'),
    liveTile('pipeline_value', pipe.openValue, null, 'pipeline_value', `Weighted ${round2(pipe.weightedValue)}`),
    rollupTile('won_value', 'won_value'),
    liveTile('forecast_this_month', pipe.forecastThisMonth, null, 'forecast_this_month'),
  ];
  // Pipeline + forecast are snapshots: no historical comparison exists.
  tiles[3]!.delta = null;
  tiles[5]!.delta = null;

  return {
    range,
    compare,
    tiles,
    totals,
    previousTotals,
    reps: reps.length,
    servedBy: cur.servedBy,
    scopeFallback: scope.fallback,
  };
}

/* ------------------------------------------------------------- funnel */

export type CohortLead = FunnelLead & { ownerId: string; sourceId: string | null; name: string };

/** The cohort (deals created in range, in scope) with every stage each one entered. */
export async function fetchCohort(
  scope: ReportScope,
  range: ResolvedRange,
  filters: { sourceId?: string | null } = {},
): Promise<CohortLead[]> {
  const rows = await exec<{
    id: string;
    name: string;
    owner_id: string;
    source_id: string | null;
    stages: string[] | null;
    first_at: Record<string, string> | null;
  }>(sql`
    SELECT d.id, d.name, coalesce(d.owner_id, '') AS owner_id, d.lead_source_id::text AS source_id,
           array_agg(h.stage::text) FILTER (WHERE h.stage IS NOT NULL) AS stages,
           (SELECT jsonb_object_agg(stage, first_at) FROM (
              SELECT h2.stage::text AS stage, min(h2.entered_at) AS first_at
              FROM deal_stage_history h2 WHERE h2.deal_id = d.id GROUP BY 1) x) AS first_at
    FROM deals d
    LEFT JOIN deal_stage_history h ON h.deal_id = d.id
    WHERE ${createdWhere({ tenantId: scope.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz })}
      AND ${ownerIn(scope, sql`coalesce(d.owner_id, '')`)}
      ${filters.sourceId === 'none' ? sql`AND d.lead_source_id IS NULL` : filters.sourceId ? sql`AND d.lead_source_id = ${filters.sourceId}::uuid` : sql``}
    GROUP BY d.id
    LIMIT 200000`);
  return rows.map((r) => ({
    dealId: r.id,
    name: r.name,
    ownerId: r.owner_id,
    sourceId: r.source_id,
    stagesEntered: r.stages ?? [],
    firstEnteredAt: r.first_at ?? {},
  }));
}

export async function funnel(scope: ReportScope, range: ResolvedRange, filters: { sourceId?: string | null; ownerId?: string | null } = {}) {
  const s = narrowToOwner(scope, filters.ownerId);
  const cohort = await fetchCohort(s, range, filters);
  return { range, cohortSize: cohort.length, steps: computeFunnel(cohort) satisfies FunnelStep[] };
}

/** Leads in the cohort that reached `stage` — reconciles exactly with the funnel bar. */
export async function funnelDrill(scope: ReportScope, range: ResolvedRange, stage: string, filters: { sourceId?: string | null; ownerId?: string | null } = {}) {
  const idx = (FUNNEL_STAGES as readonly string[]).indexOf(stage);
  if (idx < 0) return [];
  const cohort = await fetchCohort(narrowToOwner(scope, filters.ownerId), range, filters);
  return cohort.filter((l) => maxFunnelRank(l.stagesEntered) >= idx).map((l) => ({ dealId: l.dealId, name: l.name, ownerId: l.ownerId, sourceId: l.sourceId }));
}

/* ----------------------------------------------------------- sources */

export type SourceRoiRow = {
  sourceId: string | null;
  name: string;
  leads: number;
  qualifiedPct: number | null;
  won: number;
  wonValue: number;
  spend: number | null;
  costPerLead: number | null;
  costPerWon: number | null;
  roi: number | null;
};

/**
 * Per lead source: leads, qualified % (cohort), won and won value (closed in
 * range), spend for every month the range touches, and the cost ratios.
 * Spend is workspace-level, so a scope narrower than the tenant gets no
 * spend/ROI (it can't be split by rep).
 */
export async function sourceRoiReport(scope: ReportScope, range: ResolvedRange) {
  const [facts, cohort, sources, spendRows] = await Promise.all([
    readFacts(scope, range),
    fetchCohort(scope, range),
    exec<{ id: string; name: string }>(sql`SELECT id::text, name FROM lead_sources WHERE tenant_id = ${scope.tenantId}::uuid`),
    exec<{ source_id: string; month: string; spend: string }>(sql`
      SELECT source_id::text, month::text, spend FROM lead_source_cost
      WHERE tenant_id = ${scope.tenantId}::uuid AND month >= ${monthStart(range.fromDay)}::date AND month <= ${range.toDay}::date`),
  ]);
  const showSpend = scope.userIds === null;
  const names = new Map(sources.map((s) => [s.id, s.name]));
  const keys = new Set<string>([...sources.map((s) => s.id), '']);
  const bySource = new Map<string, FactRow[]>();
  for (const r of facts.rows) {
    // Activities/emails carry no source and aren't part of ROI.
    const k = r.sourceId ?? '';
    keys.add(k);
    bySource.set(k, [...(bySource.get(k) ?? []), r]);
  }
  const cohortBy = new Map<string, CohortLead[]>();
  for (const l of cohort) cohortBy.set(l.sourceId ?? '', [...(cohortBy.get(l.sourceId ?? '') ?? []), l]);
  const spendBy = new Map<string, number>();
  for (const s of spendRows) spendBy.set(s.source_id, round2((spendBy.get(s.source_id) ?? 0) + Number(s.spend)));
  const months = [...new Set(spendRows.map((s) => s.month))].sort();

  const rows: SourceRoiRow[] = [...keys].map((k) => {
    const c = sumCounters(bySource.get(k) ?? []);
    const coh = cohortBy.get(k) ?? [];
    const qualified = coh.filter((l) => maxFunnelRank(l.stagesEntered) >= 1).length;
    const spend = showSpend && k ? (spendBy.get(k) ?? 0) : null;
    return {
      sourceId: k || null,
      name: k ? (names.get(k) ?? 'Deleted source') : 'No source',
      leads: c.leadsCreated,
      qualifiedPct: pct(qualified, coh.length),
      won: c.wonCount,
      wonValue: round2(c.wonValue),
      spend,
      costPerLead: spend === null ? null : costPer(spend, c.leadsCreated),
      costPerWon: spend === null ? null : costPer(spend, c.wonCount),
      roi: spend === null ? null : sourceRoi(c.wonValue, spend),
    };
  });
  rows.sort((a, b) => b.leads - a.leads || b.wonValue - a.wonValue);
  return { range, rows: rows.filter((r) => r.leads || r.won || (r.spend ?? 0) > 0 || r.sourceId), spendMonths: months, showSpend };
}

/* ------------------------------------------------------ rep productivity */

export type RepRow = {
  userId: string;
  name: string;
  calls: number;
  contactRatePct: number | null;
  talkTimeMin: number;
  activitiesPerDay: number | null;
  emails: number;
  meetings: number;
  qualified: number;
  won: number;
  wonValue: number;
  slaPct: number | null;
  firstResponseMin: number | null;
  bands: Record<string, -2 | -1 | 0 | 1 | 2>;
};

export async function repProductivity(scope: ReportScope, range: ResolvedRange) {
  const [facts, reps, sla] = await Promise.all([readFacts(scope, range), repsInScope(scope), slaStats(scope, range, 'owner')]);
  const byOwner = new Map<string, FactRow[]>();
  for (const r of facts.rows) if (r.ownerId) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r]);
  const ids = [...new Set([...reps, ...byOwner.keys()])];
  const people = await peopleById(ids);
  const rows: RepRow[] = ids.map((id) => {
    const c = sumCounters(byOwner.get(id) ?? []);
    const s = sla.groups.get(id);
    return {
      userId: id,
      name: people.get(id)?.name ?? id,
      calls: c.callsMade,
      contactRatePct: metricValue('contact_rate', c, { reps: 1, days: range.days }),
      talkTimeMin: metricValue('talk_time', c, { reps: 1, days: range.days }) ?? 0,
      activitiesPerDay: metricValue('activities_per_rep_per_day', c, { reps: 1, days: range.days }),
      emails: c.emailsSent,
      meetings: c.meetingsHeld,
      qualified: c.qualified,
      won: c.wonCount,
      wonValue: round2(c.wonValue),
      slaPct: s?.compliancePct ?? null,
      firstResponseMin: s?.medianFirstResponseMin ?? null,
      bands: {},
    };
  });
  const cols: Array<[keyof RepRow, boolean]> = [
    ['calls', true],
    ['contactRatePct', true],
    ['talkTimeMin', true],
    ['activitiesPerDay', true],
    ['qualified', true],
    ['won', true],
    ['wonValue', true],
    ['slaPct', true],
    ['firstResponseMin', false],
  ];
  const medians: Record<string, number | null> = {};
  for (const [col, higher] of cols) {
    const m = median(rows.map((r) => r[col] as number | null).filter((v): v is number => v !== null));
    medians[col] = m;
    for (const r of rows) r.bands[col] = bandVsMedian(r[col] as number | null, m, higher);
  }
  rows.sort((a, b) => b.wonValue - a.wonValue || b.calls - a.calls);
  return { range, rows, medians, servedBy: facts.servedBy };
}

/** One rep's drill page: daily activity series, recent calls, open pipeline. */
export async function repDetail(scope: ReportScope, range: ResolvedRange, userId: string) {
  const s = narrowToOwner(scope, userId);
  if (s.userIds && s.userIds.length === 0) return null;
  const [facts, pipe, people, calls] = await Promise.all([
    readFacts(s, range),
    pipelineSnapshot(s),
    peopleById([userId]),
    callsTableExists().then((ok) =>
      ok
        ? exec<{ id: string; started_at: string | null; status: string; talk_time_sec: number | null; disposition: string | null; lead_id: string | null; deal_name: string | null }>(sql`
            SELECT c.id, c.started_at, c.status, c.talk_time_sec, c.disposition, c.lead_id, d.name AS deal_name
            FROM calls c LEFT JOIN deals d ON d.id = c.lead_id
            WHERE ${outboundCallWhere({ tenantId: s.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz })}
              AND c.user_id = ${userId}
            ORDER BY c.started_at DESC NULLS LAST LIMIT 50`)
        : Promise.resolve([]),
    ),
  ]);
  const byDay = new Map<string, FactRow[]>();
  for (const r of facts.rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const daily = eachDay(range.fromDay, range.toDay).map((day) => {
    const c = sumCounters(byDay.get(day) ?? []);
    return { day, activities: c.activities, calls: c.callsMade, emails: c.emailsSent, won: c.wonCount };
  });
  return { range, person: people.get(userId)!, daily, totals: sumCounters(facts.rows), pipeline: pipe, calls };
}

/* ---------------------------------------------------------------- SLA */

export async function slaReport(scope: ReportScope, range: ResolvedRange) {
  const w = { tenantId: scope.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz };
  const [overall, byRep, bySource, heat, trend, breaches, sources] = await Promise.all([
    slaStats(scope, range),
    slaStats(scope, range, 'owner'),
    slaStats(scope, range, 'source'),
    exec<{ dow: number; hr: number; due: number; breached: number }>(sql`
      SELECT extract(dow FROM a.assigned_at AT TIME ZONE ${range.tz})::int AS dow,
             extract(hour FROM a.assigned_at AT TIME ZONE ${range.tz})::int AS hr,
             count(*) FILTER (WHERE a.first_touch_at IS NOT NULL OR a.sla_due_at < now())::int AS due,
             count(*) FILTER (WHERE (a.first_touch_at IS NULL AND a.sla_due_at < now()) OR a.first_touch_at > a.sla_due_at)::int AS breached
      FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
      WHERE ${assignedWhere(w)} AND ${ownerIn(scope, sql`a.assigned_to`)}
      GROUP BY 1, 2`),
    exec<{ day: string; due: number; met: number }>(sql`
      SELECT (a.assigned_at AT TIME ZONE ${range.tz})::date::text AS day,
             count(*) FILTER (WHERE a.first_touch_at IS NOT NULL OR a.sla_due_at < now())::int AS due,
             count(*) FILTER (WHERE a.first_touch_at IS NOT NULL AND a.first_touch_at <= a.sla_due_at)::int AS met
      FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
      WHERE ${assignedWhere(w)} AND ${ownerIn(scope, sql`a.assigned_to`)}
      GROUP BY 1`),
    exec<{ id: string; deal_id: string; deal_name: string; assigned_to: string; assigned_at: string; sla_due_at: string; first_touch_at: string | null; released_at: string | null }>(sql`
      SELECT a.id, a.deal_id, d.name AS deal_name, a.assigned_to, a.assigned_at, a.sla_due_at, a.first_touch_at, a.released_at
      FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
      WHERE ${assignedWhere(w)} AND ${ownerIn(scope, sql`a.assigned_to`)}
        AND ((a.first_touch_at IS NULL AND a.sla_due_at < now()) OR a.first_touch_at > a.sla_due_at)
      ORDER BY a.sla_due_at DESC LIMIT 200`),
    exec<{ id: string; name: string }>(sql`SELECT id::text, name FROM lead_sources WHERE tenant_id = ${scope.tenantId}::uuid`),
  ]);
  const people = await peopleById([...byRep.groups.keys(), ...breaches.map((b) => b.assigned_to)]);
  const srcNames = new Map(sources.map((s) => [s.id, s.name]));
  const trendBy = new Map(trend.map((t) => [t.day, t]));
  return {
    range,
    overall: overall.total,
    byRep: [...byRep.groups.entries()].map(([id, s]) => ({ userId: id, name: people.get(id)?.name ?? id, ...s })).sort((a, b) => b.breached - a.breached),
    bySource: [...bySource.groups.entries()].map(([id, s]) => ({ sourceId: id || null, name: id ? (srcNames.get(id) ?? 'Deleted source') : 'No source', ...s })).sort((a, b) => b.breached - a.breached),
    heatmap: heat.map((h) => ({ weekday: Number(h.dow), hour: Number(h.hr), due: Number(h.due), breached: Number(h.breached) })),
    trend: eachDay(range.fromDay, range.toDay).map((day) => {
      const t = trendBy.get(day);
      return { day, compliancePct: t ? pct(Number(t.met), Number(t.due)) : null, due: Number(t?.due ?? 0) };
    }),
    breaches: breaches.map((b) => ({
      assignmentId: b.id,
      dealId: b.deal_id,
      dealName: b.deal_name,
      ownerId: b.assigned_to,
      ownerName: people.get(b.assigned_to)?.name ?? b.assigned_to,
      assignedAt: new Date(b.assigned_at).toISOString(),
      slaDueAt: new Date(b.sla_due_at).toISOString(),
      firstTouchAt: b.first_touch_at ? new Date(b.first_touch_at).toISOString() : null,
      open: b.released_at === null && b.first_touch_at === null,
    })),
  };
}

/* ---------------------------------------------------------- leaderboard */

export const LEADERBOARD_METRICS = ['won_value', 'calls', 'qualified'] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];
export const LEADERBOARD_PERIODS = ['today', 'week', 'month'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

const lbCache = new Map<string, { at: number; value: unknown }>();
const LB_TTL_MS = 30_000;

export async function leaderboard(scope: ReportScope, metric: LeaderboardMetric, period: LeaderboardPeriod, now = new Date()) {
  const key = `${scope.tenantId}|${scope.userIds?.join(',') ?? '*'}|${metric}|${period}`;
  const hit = lbCache.get(key);
  if (hit && Date.now() - hit.at < LB_TTL_MS) return hit.value as Awaited<ReturnType<typeof computeLeaderboard>>;
  const value = await computeLeaderboard(scope, metric, period, now);
  lbCache.set(key, { at: Date.now(), value });
  if (lbCache.size > 500) lbCache.delete(lbCache.keys().next().value!);
  return value;
}

async function computeLeaderboard(scope: ReportScope, metric: LeaderboardMetric, period: LeaderboardPeriod, now: Date) {
  const tz = await getTenantTz(scope.tenantId);
  const today = localDay(now, tz);
  const from = period === 'today' ? today : period === 'week' ? addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)) : monthStart(today);
  const range = resolveRange({ preset: 'custom', from, to: today, tz, now });
  const [facts, reps] = await Promise.all([readFacts(scope, range, now), repsInScope(scope)]);
  const byOwner = new Map<string, FactCounters>();
  for (const r of facts.rows) if (r.ownerId) byOwner.set(r.ownerId, sumCounters([byOwner.get(r.ownerId) ?? emptyCounters(), r]));
  const ids = [...new Set([...reps, ...byOwner.keys()])];
  const people = await peopleById(ids);
  const pick = (c: FactCounters) => (metric === 'won_value' ? round2(c.wonValue) : metric === 'calls' ? c.callsMade : c.qualified);
  const rows = ids
    .map((id) => ({ userId: id, name: people.get(id)?.name ?? id, value: pick(byOwner.get(id) ?? emptyCounters()) }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return { metric, period, range, rows, generatedAt: new Date().toISOString() };
}

/* --------------------------------------------------------- team pipeline */

export async function teamPipeline(scope: ReportScope, staleDays = 7) {
  const rows = await exec<{ stage: string; owner_id: string; n: number; v: string; stale: number }>(sql`
    SELECT d.stage::text AS stage, coalesce(d.owner_id, '') AS owner_id, count(*)::int AS n,
           coalesce(sum(d.amount_minor), 0) / 100.0 AS v,
           count(*) FILTER (WHERE coalesce(last.at, d.created_at) < now() - make_interval(days => ${staleDays}))::int AS stale
    FROM deals d
    LEFT JOIN LATERAL (
      SELECT max(l.created_at) AS at FROM activity_logs l
      WHERE l.tenant_id = d.tenant_id AND l.entity_type = 'deal' AND l.entity_id = d.id::text
    ) last ON TRUE
    WHERE d.tenant_id = ${scope.tenantId}::uuid AND d.deleted_at IS NULL AND d.stage NOT IN ('won', 'lost')
      AND ${ownerIn(scope, sql`coalesce(d.owner_id, '')`)}
    GROUP BY 1, 2`);
  const people = await peopleById(rows.map((r) => r.owner_id));
  const stages = ['lead', 'qualified', 'proposal', 'negotiation', 'hold'];
  return {
    staleDays,
    columns: stages.map((stage) => {
      const cells = rows.filter((r) => r.stage === stage);
      return {
        stage,
        count: cells.reduce((a, r) => a + Number(r.n), 0),
        value: round2(cells.reduce((a, r) => a + Number(r.v), 0)),
        stale: cells.reduce((a, r) => a + Number(r.stale), 0),
        reps: cells
          .map((r) => ({ userId: r.owner_id || null, name: r.owner_id ? (people.get(r.owner_id)?.name ?? r.owner_id) : 'Unassigned', count: Number(r.n), value: round2(Number(r.v)), stale: Number(r.stale) }))
          .sort((a, b) => b.count - a.count),
      };
    }),
  };
}

/** Open deals in one stage (optionally one owner; '' = unassigned) — the team-pipeline click-through. */
export async function pipelineDeals(scope: ReportScope, stage: string, ownerId: string | null, staleDays = 7) {
  if (!['lead', 'qualified', 'proposal', 'negotiation', 'hold'].includes(stage)) return [];
  const s = ownerId ? narrowToOwner(scope, ownerId) : scope;
  const rows = await exec<{ id: string; name: string; owner_id: string | null; amount: string; last_at: string | null; created_at: string }>(sql`
    SELECT d.id, d.name, d.owner_id, d.amount_minor / 100.0 AS amount, last.at AS last_at, d.created_at
    FROM deals d
    LEFT JOIN LATERAL (
      SELECT max(l.created_at) AS at FROM activity_logs l
      WHERE l.tenant_id = d.tenant_id AND l.entity_type = 'deal' AND l.entity_id = d.id::text
    ) last ON TRUE
    WHERE d.tenant_id = ${s.tenantId}::uuid AND d.deleted_at IS NULL AND d.stage = ${stage}
      AND ${ownerIn(s, sql`coalesce(d.owner_id, '')`)}
      ${ownerId === '' ? sql`AND d.owner_id IS NULL` : sql``}
    ORDER BY d.amount_minor DESC LIMIT 500`);
  const people = await peopleById(rows.map((r) => r.owner_id ?? ''));
  return rows.map((r) => {
    const last = new Date(r.last_at ?? r.created_at);
    return {
      dealId: r.id,
      name: r.name,
      ownerName: r.owner_id ? (people.get(r.owner_id)?.name ?? r.owner_id) : 'Unassigned',
      value: round2(Number(r.amount)),
      stale: Date.now() - last.getTime() > staleDays * 86_400_000,
      idleDays: Math.floor((Date.now() - last.getTime()) / 86_400_000),
    };
  });
}

/* ----------------------------------------------------------- stale leads */

export async function staleLeads(scope: ReportScope, days = 7, ownerId?: string | null, limit = 500) {
  const s = narrowToOwner(scope, ownerId);
  const rows = await exec<{ id: string; name: string; stage: string; owner_id: string | null; amount: string; last_at: string | null; created_at: string }>(sql`
    SELECT d.id, d.name, d.stage::text AS stage, d.owner_id, d.amount_minor / 100.0 AS amount, last.at AS last_at, d.created_at
    FROM deals d
    LEFT JOIN LATERAL (
      SELECT max(l.created_at) AS at FROM activity_logs l
      WHERE l.tenant_id = d.tenant_id AND l.entity_type = 'deal' AND l.entity_id = d.id::text
    ) last ON TRUE
    WHERE d.tenant_id = ${s.tenantId}::uuid AND d.deleted_at IS NULL AND d.stage NOT IN ('won', 'lost')
      AND ${ownerIn(s, sql`coalesce(d.owner_id, '')`)}
      AND coalesce(last.at, d.created_at) < now() - make_interval(days => ${Math.max(1, Math.min(365, days))})
    ORDER BY coalesce(last.at, d.created_at) ASC
    LIMIT ${Math.min(limit, 2000)}`);
  const people = await peopleById(rows.map((r) => r.owner_id ?? ''));
  return {
    days,
    rows: rows.map((r) => {
      const last = new Date(r.last_at ?? r.created_at);
      return {
        dealId: r.id,
        name: r.name,
        stage: r.stage,
        ownerId: r.owner_id,
        ownerName: r.owner_id ? (people.get(r.owner_id)?.name ?? r.owner_id) : 'Unassigned',
        value: round2(Number(r.amount)),
        lastActivityAt: last.toISOString(),
        idleDays: Math.floor((Date.now() - last.getTime()) / 86_400_000),
      };
    }),
  };
}

/* ------------------------------------------------------------ drill-down */

export const DRILL_METRICS = ['lead_volume', 'won_value', 'won_count', 'calls_made', 'sla_compliance_pct', 'pipeline_value', 'forecast_this_month'] as const;
export type DrillMetric = (typeof DRILL_METRICS)[number];

export type DrillResult = {
  metric: DrillMetric;
  rows: Array<Record<string, string | number | null>>;
  /** What the tile shows, recomputed from exactly these rows. */
  count: number;
  sum: number | null;
  truncated: boolean;
};

/**
 * The rows behind a KPI tile, using the same predicates as the facts SQL
 * (`createdWhere`, `closedWhere`, `outboundCallWhere`, `assignedWhere`).
 */
export async function drill(scope: ReportScope, metric: DrillMetric, range: ResolvedRange, limit = 1000): Promise<DrillResult> {
  const w = { tenantId: scope.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz };
  const cap = Math.min(limit, 5000);
  const own = (col: ReturnType<typeof sql>) => ownerIn(scope, col);
  let rows: Array<Record<string, string | number | null>> = [];
  let count = 0;
  let sum: number | null = null;

  if (metric === 'lead_volume') {
    const [agg] = await exec<{ n: number }>(sql`SELECT count(*)::int AS n FROM deals d WHERE ${createdWhere(w)} AND ${own(sql`coalesce(d.owner_id, '')`)}`);
    count = Number(agg?.n ?? 0);
    rows = await exec(sql`SELECT d.id, d.name, d.stage::text AS stage, d.owner_id, d.created_at FROM deals d
      WHERE ${createdWhere(w)} AND ${own(sql`coalesce(d.owner_id, '')`)} ORDER BY d.created_at DESC LIMIT ${cap}`);
  } else if (metric === 'won_value' || metric === 'won_count') {
    const [agg] = await exec<{ n: number; v: string }>(sql`SELECT count(*)::int AS n, coalesce(sum(d.amount_minor), 0) / 100.0 AS v
      FROM deals d WHERE ${closedWhere(w, 'won')} AND ${own(sql`coalesce(d.owner_id, '')`)}`);
    count = Number(agg?.n ?? 0);
    sum = round2(Number(agg?.v ?? 0));
    rows = await exec(sql`SELECT d.id, d.name, d.owner_id, d.amount_minor / 100.0 AS value, d.closed_at FROM deals d
      WHERE ${closedWhere(w, 'won')} AND ${own(sql`coalesce(d.owner_id, '')`)} ORDER BY d.closed_at DESC LIMIT ${cap}`);
  } else if (metric === 'calls_made') {
    if (await callsTableExists()) {
      const [agg] = await exec<{ n: number; c: number }>(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS c
        FROM calls c WHERE ${outboundCallWhere(w)} AND ${own(sql`coalesce(c.user_id, '')`)}`);
      count = Number(agg?.n ?? 0);
      sum = Number(agg?.c ?? 0);
      rows = await exec(sql`SELECT c.id, c.lead_id, c.user_id, c.status, c.started_at, c.answered_at, c.talk_time_sec FROM calls c
        WHERE ${outboundCallWhere(w)} AND ${own(sql`coalesce(c.user_id, '')`)} ORDER BY c.started_at DESC NULLS LAST LIMIT ${cap}`);
    }
  } else if (metric === 'sla_compliance_pct') {
    const [agg] = await exec<{ n: number; met: number }>(sql`
      SELECT count(*) FILTER (WHERE a.first_touch_at IS NOT NULL OR a.sla_due_at < now())::int AS n,
             count(*) FILTER (WHERE a.first_touch_at IS NOT NULL AND a.first_touch_at <= a.sla_due_at)::int AS met
      FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
      WHERE ${assignedWhere(w)} AND ${own(sql`a.assigned_to`)}`);
    count = Number(agg?.n ?? 0);
    sum = Number(agg?.met ?? 0);
    rows = await exec(sql`SELECT a.id, a.deal_id, d.name, a.assigned_to, a.assigned_at, a.sla_due_at, a.first_touch_at,
        (a.first_touch_at IS NOT NULL AND a.first_touch_at <= a.sla_due_at) AS met
      FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
      WHERE ${assignedWhere(w)} AND ${own(sql`a.assigned_to`)} AND (a.first_touch_at IS NOT NULL OR a.sla_due_at < now())
      ORDER BY a.assigned_at DESC LIMIT ${cap}`);
  } else {
    const snap = await pipelineSnapshot(scope);
    const tz = range.tz;
    const today = localDay(new Date(), tz);
    const mStart = monthStart(today);
    const nextMonth = addDays(`${mStart.slice(0, 7)}-28`, 4).slice(0, 7) + '-01';
    const monthOnly = metric === 'forecast_this_month';
    const where = sql`d.tenant_id = ${scope.tenantId}::uuid AND d.deleted_at IS NULL AND d.stage NOT IN ('won', 'lost')
      AND ${own(sql`coalesce(d.owner_id, '')`)}
      ${monthOnly ? sql`AND d.expected_close_date >= ${mStart}::date AND d.expected_close_date < ${nextMonth}::date` : sql``}`;
    const [agg] = await exec<{ n: number; v: string }>(sql`SELECT count(*)::int AS n, coalesce(sum(d.amount_minor), 0) / 100.0 AS v FROM deals d WHERE ${where}`);
    count = Number(agg?.n ?? 0);
    sum = monthOnly ? snap.forecastThisMonth : round2(Number(agg?.v ?? 0));
    rows = await exec(sql`SELECT d.id, d.name, d.stage::text AS stage, d.owner_id, d.amount_minor / 100.0 AS value, d.expected_close_date
      FROM deals d WHERE ${where} ORDER BY d.amount_minor DESC LIMIT ${cap}`);
  }
  const serial = rows.map((r) =>
    Object.fromEntries(
      Object.entries(r as Record<string, unknown>).map(([k, v]) => [
        k,
        v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null),
      ]),
    ),
  );
  return { metric, rows: serial, count, sum, truncated: count > serial.length };
}

/** "Today" window start in tenant tz — for live tiles. */
export async function todayStart(tenantId: string): Promise<Date> {
  const tz = await getTenantTz(tenantId);
  return dayStartUtc(localDay(new Date(), tz), tz);
}
