import 'server-only';

import { sql, type SQL } from 'drizzle-orm';

import { PROSPECT_STAGES, type ProspectStage } from '@/db/schema/prospects';
import type { MembershipRole } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { getProspectSettings } from '@/lib/prospects/settings';
import { listTeammates } from '@/lib/teammates/queries';

import { resolveDateRange } from '../filters';
import { scopeUsers, textArray, type ReportScope } from '../manager/scope';
import type { ReportFilter, ReportRunner } from '../types';

/**
 * Prospect Board report. Definitions are fixed in the stage 4 plan
 * ("Global Constraints"):
 *
 *   cohort     prospects created in the range, not deleted
 *   rep        COALESCE(promoted_by, claimed_by, created_by)
 *   conversion promoted_deal_id IS NOT NULL / cohort, at any time up to now
 *   days       time in `to_stage` until the next history row, else promoted_at,
 *              else now (never negative)
 *   stale      a current snapshot (not range-bound): idle past half the
 *              tenant's auto-park window
 *
 * Manager scope: `filters.scope.userIds` (from `scopeUsers`; null = everyone).
 * Added/conversion/days follow the same attribution as their definition; stale
 * and auto-parked follow COALESCE(claimed_by, created_by).
 */

export type ProspectBoardReport = {
  range: { from: string; to: string };
  addedByRep: { userId: string; name: string; count: number }[];
  addedBySource: { sourceTag: string; count: number }[];
  conversionBySource: { key: string; cohort: number; promoted: number; rate: number | null }[];
  conversionByTag: { key: string; cohort: number; promoted: number; rate: number | null }[];
  conversionByRep: { userId: string; name: string; cohort: number; promoted: number; rate: number | null }[];
  daysInStage: { stage: ProspectStage; avgDays: number | null; intervals: number }[];
  stale: { count: number; thresholdDays: number; autoParkedInRange: number };
};

export type ProspectBoardFilter = ReportFilter & {
  /**
   * Optional override (tests, pre-resolved callers); `userIds: null` means the
   * whole tenant. When absent the runner derives the scope from the viewer's
   * membership and fails closed (empty) if there is none.
   */
  scope?: Pick<ReportScope, 'userIds'>;
};

export type ProspectBoardCsvRow = {
  section:
    | 'added_by_rep'
    | 'added_by_source'
    | 'conversion_by_source'
    | 'conversion_by_tag'
    | 'conversion_by_rep'
    | 'days_in_stage'
    | 'stale';
  key: string;
  name: string;
  count: number | null;
  cohort: number | null;
  promoted: number | null;
  /** Percentage with one decimal; null when the cohort is empty. */
  ratePct: number | null;
  avgDays: number | null;
  intervals: number | null;
};

export const PROSPECT_BOARD_CSV_COLUMNS: { key: keyof ProspectBoardCsvRow; label: string }[] = [
  { key: 'section', label: 'Section' },
  { key: 'key', label: 'Key' },
  { key: 'name', label: 'Name' },
  { key: 'count', label: 'Count' },
  { key: 'cohort', label: 'Cohort' },
  { key: 'promoted', label: 'Promoted' },
  { key: 'ratePct', label: 'Conversion %' },
  { key: 'avgDays', label: 'Avg days' },
  { key: 'intervals', label: 'Intervals' },
];

const NO_TAG = '(no tag)';
const FORMER = 'Former member';

const rate = (promoted: number, cohort: number): number | null => (cohort > 0 ? promoted / cohort : null);

export const prospectBoardRunner: ReportRunner<
  ProspectBoardFilter,
  ProspectBoardCsvRow,
  ProspectBoardReport
> = async (tenantId, filters, context) => {
  const startedAt = Date.now();
  const range = resolveDateRange(filters.range ?? 'last_30d', 'last_30d');
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  // Effective user set: the viewer's scope, narrowed by an owner filter. Someone
  // outside the scope gets an empty set, never a wider one.
  let userIds: string[] | null;
  if (filters.scope) {
    userIds = filters.scope.userIds;
  } else {
    const [m] = (await tenantTransaction((tx) =>
      tx.execute(sql`
        SELECT role FROM memberships
        WHERE tenant_id = ${tenantId}::uuid AND user_id = ${context.currentUserId} AND status = 'active'
        LIMIT 1`),
    )) as unknown as Array<{ role: MembershipRole }>;
    userIds = m
      ? (await scopeUsers({ tenantId, userId: context.currentUserId, role: m.role })).userIds
      : [];
  }
  const owner = filters.owner;
  const target =
    !owner || owner.type === 'all' ? null : owner.type === 'mine' ? context.currentUserId : owner.userId;
  if (target) userIds = userIds === null || userIds.includes(target) ? [target] : [];

  const inScope = (column: SQL): SQL => (userIds === null ? sql`TRUE` : sql`${column} = ANY(${textArray(userIds)})`);
  const repExpr = sql`COALESCE(p.promoted_by, p.claimed_by, p.created_by)`;
  const holderExpr = sql`COALESCE(p.claimed_by, p.created_by)`;
  const cohortWhere = sql`p.tenant_id = ${tenantId}::uuid AND p.deleted_at IS NULL
    AND p.created_at >= ${fromIso}::timestamptz AND p.created_at < ${toIso}::timestamptz`;

  const settings = await getProspectSettings(tenantId);
  const thresholdDays = Math.floor(settings.autoParkDays / 2);

  type Grouped = { k: string | null; cohort: string; promoted: string };
  type Result = {
    added: { k: string | null; n: string }[];
    sources: { k: string; n: string }[];
    bySource: Grouped[];
    byTag: Grouped[];
    byRep: Grouped[];
    days: { stage: ProspectStage; avg: string | null; n: string }[];
    stale: { n: string }[];
    parked: { n: string }[];
  };

  const r = await tenantTransaction(async (tx): Promise<Result> => {
    const q = async <T,>(query: SQL) => (await tx.execute(query)) as unknown as T[];
    return {
      added: await q(sql`
        SELECT COALESCE(p.created_by, '') AS k, count(*)::int AS n
        FROM prospects p WHERE ${cohortWhere} AND ${inScope(sql`p.created_by`)}
        GROUP BY 1`),
      sources: await q(sql`
        SELECT p.source_tag AS k, count(*)::int AS n
        FROM prospects p WHERE ${cohortWhere} AND ${inScope(sql`p.created_by`)}
        GROUP BY 1`),
      bySource: await q(sql`
        SELECT p.source_tag AS k, count(*)::int AS cohort, count(p.promoted_deal_id)::int AS promoted
        FROM prospects p WHERE ${cohortWhere} AND ${inScope(repExpr)}
        GROUP BY 1`),
      byTag: await q(sql`
        SELECT tg.t AS k, count(*)::int AS cohort, count(p.promoted_deal_id)::int AS promoted
        FROM prospects p
        CROSS JOIN LATERAL (
          SELECT DISTINCT t FROM unnest(
            CASE WHEN cardinality(p.cluster_tags) = 0 THEN ARRAY[${NO_TAG}]::text[] ELSE p.cluster_tags END
          ) AS t
        ) tg
        WHERE ${cohortWhere} AND ${inScope(repExpr)}
        GROUP BY 1`),
      byRep: await q(sql`
        SELECT COALESCE(${repExpr}, '') AS k, count(*)::int AS cohort, count(p.promoted_deal_id)::int AS promoted
        FROM prospects p WHERE ${cohortWhere} AND ${inScope(repExpr)}
        GROUP BY 1`),
      days: await q(sql`
        WITH iv AS (
          SELECT h.to_stage AS stage,
                 EXTRACT(EPOCH FROM (
                   COALESCE(lead(h.changed_at) OVER (PARTITION BY h.prospect_id ORDER BY h.changed_at, h.id),
                            p.promoted_at, now()) - h.changed_at
                 )) AS secs
          FROM prospect_stage_history h
          JOIN prospects p ON p.id = h.prospect_id AND p.tenant_id = h.tenant_id
          WHERE h.tenant_id = ${tenantId}::uuid AND ${cohortWhere} AND ${inScope(repExpr)}
        )
        SELECT stage::text AS stage, (avg(GREATEST(secs, 0)) / 86400.0)::float8 AS avg, count(*)::int AS n
        FROM iv GROUP BY stage`),
      stale: await q(sql`
        SELECT count(*)::int AS n FROM prospects p
        WHERE p.tenant_id = ${tenantId}::uuid AND p.deleted_at IS NULL
          AND p.promoted_deal_id IS NULL AND p.stage <> 'parked'
          AND p.last_activity_at < now() - make_interval(days => ${thresholdDays}::int)
          AND ${inScope(holderExpr)}`),
      parked: await q(sql`
        SELECT count(*)::int AS n
        FROM prospect_stage_history h
        JOIN prospects p ON p.id = h.prospect_id AND p.tenant_id = h.tenant_id
        WHERE h.tenant_id = ${tenantId}::uuid AND p.deleted_at IS NULL
          AND h.to_stage = 'parked' AND h.changed_by = 'system:auto-park'
          AND h.changed_at >= ${fromIso}::timestamptz AND h.changed_at < ${toIso}::timestamptz
          AND ${inScope(holderExpr)}`),
    };
  });

  const ids = new Set<string>();
  for (const x of [...r.added, ...r.byRep]) if (x.k) ids.add(x.k);
  const names = new Map<string, string>();
  if (ids.size > 0) {
    try {
      for (const t of await listTeammates(tenantId, '')) names.set(t.id, t.displayName);
    } catch {
      /* a Clerk hiccup must not break the report; names fall back */
    }
  }
  const nameOf = (id: string) => (id && names.get(id)) || FORMER;

  const num = (v: string | number | null | undefined) => Number(v ?? 0);
  const conv = <T extends object>(rows: Grouped[], extra: (k: string) => T) =>
    rows
      .map((g) => {
        const cohort = num(g.cohort);
        const promoted = num(g.promoted);
        return { key: g.k ?? '', cohort, promoted, rate: rate(promoted, cohort), ...extra(g.k ?? '') };
      })
      .sort((a, b) => b.cohort - a.cohort || a.key.localeCompare(b.key));

  const report: ProspectBoardReport = {
    range: { from: fromIso, to: toIso },
    addedByRep: r.added
      .map((x) => ({ userId: x.k ?? '', name: nameOf(x.k ?? ''), count: num(x.n) }))
      .sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId)),
    addedBySource: r.sources
      .map((x) => ({ sourceTag: x.k, count: num(x.n) }))
      .sort((a, b) => b.count - a.count || a.sourceTag.localeCompare(b.sourceTag)),
    conversionBySource: conv(r.bySource, () => ({})),
    conversionByTag: conv(r.byTag, () => ({})),
    conversionByRep: conv(r.byRep, (k) => ({ name: nameOf(k) })).map(({ key, ...rest }) => ({ userId: key, ...rest })),
    daysInStage: PROSPECT_STAGES.map((stage) => {
      const d = r.days.find((x) => x.stage === stage);
      const n = num(d?.n);
      return { stage, avgDays: n > 0 && d?.avg != null ? Number(d.avg) : null, intervals: n };
    }),
    stale: { count: num(r.stale[0]?.n), thresholdDays, autoParkedInRange: num(r.parked[0]?.n) },
  };

  const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);
  const blank = { count: null, cohort: null, promoted: null, ratePct: null, avgDays: null, intervals: null };
  const rows: ProspectBoardCsvRow[] = [
    ...report.addedByRep.map((x) => ({ ...blank, section: 'added_by_rep' as const, key: x.userId, name: x.name, count: x.count })),
    ...report.addedBySource.map((x) => ({ ...blank, section: 'added_by_source' as const, key: x.sourceTag, name: x.sourceTag, count: x.count })),
    ...report.conversionBySource.map((x) => ({ ...blank, section: 'conversion_by_source' as const, key: x.key, name: x.key, cohort: x.cohort, promoted: x.promoted, ratePct: pct(x.rate) })),
    ...report.conversionByTag.map((x) => ({ ...blank, section: 'conversion_by_tag' as const, key: x.key, name: x.key, cohort: x.cohort, promoted: x.promoted, ratePct: pct(x.rate) })),
    ...report.conversionByRep.map((x) => ({ ...blank, section: 'conversion_by_rep' as const, key: x.userId, name: x.name, cohort: x.cohort, promoted: x.promoted, ratePct: pct(x.rate) })),
    ...report.daysInStage.map((x) => ({
      ...blank,
      section: 'days_in_stage' as const,
      key: x.stage,
      name: x.stage,
      avgDays: x.avgDays === null ? null : Math.round(x.avgDays * 10) / 10,
      intervals: x.intervals,
    })),
    { ...blank, section: 'stale', key: 'idle', name: `Idle more than ${thresholdDays} days`, count: report.stale.count },
    { ...blank, section: 'stale', key: 'auto_parked_in_range', name: 'Auto-parked in range', count: report.stale.autoParkedInRange },
  ];

  const added = report.addedByRep.reduce((s, x) => s + x.count, 0);
  return {
    rows,
    extras: report,
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount: rows.length,
      headline: { label: 'Prospects added', value: String(added) },
    },
  };
};
