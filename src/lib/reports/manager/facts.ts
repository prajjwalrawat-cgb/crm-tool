import 'server-only';

import { sql, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import { tenantTransaction } from '@/lib/db-context';

import type { FactCounters } from './math';
import { ownerIn, type ReportScope } from './scope';

/**
 * The ONE SQL definition of the daily counters behind every rollup metric.
 *
 * `dailyFactsSql` returns rows of (day, owner_id, source_id, …counters) for
 * a UTC window, bucketed by tenant-timezone day. It is used:
 *   - by the rollup job, which INSERT … SELECTs it into report_daily_rollup;
 *   - live, for "today" and for any day the rollup does not cover yet.
 * So a rollup-backed number and a live number cannot disagree by definition.
 *
 * The row-level predicates (which deals count as "created", "won", …) are
 * also exported as `*Where` fragments, and the drill-down lists use the same
 * fragments — that is what makes a tile reconcile with its drill-down.
 *
 * Attribution: owner = deal owner (assignee for assignments, actor for
 * activities/emails, agent for calls); '' when nobody. Source = the deal's
 * lead source; NULL for activities/emails, which aren't per-source.
 */

export type FactRow = FactCounters & {
  day: string;
  ownerId: string;
  sourceId: string | null;
  medianFirstResponseSec: number | null;
};

type Window = { tenantId: string; fromTs: Date; toTs: Date; tz: string };

/* ----------------------------------------------- shared row predicates */

export const createdWhere = (w: Window, alias = 'd'): SQL =>
  sql`${sql.raw(alias)}.tenant_id = ${w.tenantId}::uuid AND ${sql.raw(alias)}.deleted_at IS NULL
      AND ${sql.raw(alias)}.created_at >= ${w.fromTs.toISOString()}::timestamptz
      AND ${sql.raw(alias)}.created_at < ${w.toTs.toISOString()}::timestamptz`;

export const closedWhere = (w: Window, stage: 'won' | 'lost' | 'any', alias = 'd'): SQL =>
  sql`${sql.raw(alias)}.tenant_id = ${w.tenantId}::uuid AND ${sql.raw(alias)}.deleted_at IS NULL
      AND ${sql.raw(alias)}.stage ${stage === 'any' ? sql`IN ('won', 'lost')` : sql`= ${stage}`}
      AND ${sql.raw(alias)}.closed_at >= ${w.fromTs.toISOString()}::timestamptz
      AND ${sql.raw(alias)}.closed_at < ${w.toTs.toISOString()}::timestamptz`;

export const assignedWhere = (w: Window, alias = 'a'): SQL =>
  sql`${sql.raw(alias)}.tenant_id = ${w.tenantId}::uuid
      AND ${sql.raw(alias)}.assigned_at >= ${w.fromTs.toISOString()}::timestamptz
      AND ${sql.raw(alias)}.assigned_at < ${w.toTs.toISOString()}::timestamptz`;

export const activityWhere = (w: Window, alias = 'l'): SQL =>
  sql`${sql.raw(alias)}.tenant_id = ${w.tenantId}::uuid
      AND ${sql.raw(alias)}.actor_user_id IS NOT NULL AND ${sql.raw(alias)}.actor_user_id <> 'system'
      AND ${sql.raw(alias)}.created_at >= ${w.fromTs.toISOString()}::timestamptz
      AND ${sql.raw(alias)}.created_at < ${w.toTs.toISOString()}::timestamptz`;

export const outboundCallWhere = (w: Window, alias = 'c'): SQL =>
  sql`${sql.raw(alias)}.tenant_id = ${w.tenantId}::uuid AND ${sql.raw(alias)}.direction = 'outbound'
      AND coalesce(${sql.raw(alias)}.started_at, ${sql.raw(alias)}.created_at) >= ${w.fromTs.toISOString()}::timestamptz
      AND coalesce(${sql.raw(alias)}.started_at, ${sql.raw(alias)}.created_at) < ${w.toTs.toISOString()}::timestamptz`;

const dayOf = (col: string, tz: string): SQL => sql`(${sql.raw(col)} AT TIME ZONE ${tz})::date`;

/* ------------------------------------------- does `calls` exist yet? */

let callsKnown: { exists: boolean; checkedAt: number } | null = null;

/**
 * The `calls` table arrives with telephony (0073). Until it exists every
 * call metric is 0. Positive answers are cached for the process; a negative
 * one is re-checked every 5 minutes so a fresh migration is picked up.
 */
export async function callsTableExists(): Promise<boolean> {
  if (callsKnown && (callsKnown.exists || Date.now() - callsKnown.checkedAt < 300_000)) return callsKnown.exists;
  try {
    const rows = (await db.execute(sql`select to_regclass('public.calls') is not null as ok`)) as unknown as Array<{ ok: boolean }>;
    callsKnown = { exists: rows[0]?.ok === true, checkedAt: Date.now() };
  } catch {
    callsKnown = { exists: false, checkedAt: Date.now() };
  }
  return callsKnown.exists;
}

/* ---------------------------------------------------------- facts SQL */

const ZERO_COLS = {
  leads_created: '0',
  leads_assigned: '0',
  first_touch_count: '0',
  first_touch_within_sla: '0',
  median_first_response_sec: 'NULL::numeric',
  calls_made: '0',
  calls_connected: '0',
  talk_time_sec: '0',
  emails_sent: '0',
  meetings_held: '0',
  activities: '0',
  qualified: '0',
  quotes_sent: '0',
  won_count: '0',
  won_value: '0::numeric',
  lost_count: '0',
} as const;
type ColName = keyof typeof ZERO_COLS;
const COLS = Object.keys(ZERO_COLS) as ColName[];

/** One UNION branch: the given columns as expressions, every other column zero. */
function branch(cols: Partial<Record<ColName, string>>, from: SQL, groupBy: string): SQL {
  const select = COLS.map((c) => `${cols[c] ?? ZERO_COLS[c]} AS ${c}`).join(', ');
  return sql`SELECT day, owner_id, source_id, ${sql.raw(select)} FROM (${from}) src GROUP BY ${sql.raw(groupBy)}`;
}

export async function dailyFactsSql(w: Window): Promise<SQL> {
  const withCalls = await callsTableExists();
  const parts: SQL[] = [
    branch(
      { leads_created: 'count(*)' },
      sql`SELECT ${dayOf('d.created_at', w.tz)} AS day, coalesce(d.owner_id, '') AS owner_id, d.lead_source_id AS source_id
          FROM deals d WHERE ${createdWhere(w)}`,
      'day, owner_id, source_id',
    ),
    branch(
      {
        leads_assigned: 'count(*)',
        first_touch_count: 'count(*) FILTER (WHERE first_touch_at IS NOT NULL)',
        first_touch_within_sla: 'count(*) FILTER (WHERE first_touch_at IS NOT NULL AND first_touch_at <= sla_due_at)',
        median_first_response_sec:
          'percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_touch_at - assigned_at)) FILTER (WHERE first_touch_at IS NOT NULL)',
      },
      sql`SELECT ${dayOf('a.assigned_at', w.tz)} AS day, a.assigned_to AS owner_id, d.lead_source_id AS source_id,
                 a.first_touch_at, a.sla_due_at, a.assigned_at
          FROM lead_assignments a JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
          WHERE ${assignedWhere(w)}`,
      'day, owner_id, source_id',
    ),
    // Distinct per (deal, day, stage): re-entering a stage the same day counts once.
    branch(
      { qualified: "count(*) FILTER (WHERE stage = 'qualified')", quotes_sent: "count(*) FILTER (WHERE stage = 'proposal')" },
      sql`SELECT DISTINCT ${dayOf('h.entered_at', w.tz)} AS day,
                 coalesce(h.owner_id_at_change, d.owner_id, '') AS owner_id,
                 coalesce(h.source_id_at_change, d.lead_source_id) AS source_id,
                 h.deal_id, h.stage::text AS stage
          FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id AND d.deleted_at IS NULL
          WHERE h.tenant_id = ${w.tenantId}::uuid AND h.stage IN ('qualified', 'proposal')
            AND h.entered_at >= ${w.fromTs.toISOString()}::timestamptz AND h.entered_at < ${w.toTs.toISOString()}::timestamptz`,
      'day, owner_id, source_id',
    ),
    branch(
      {
        won_count: "count(*) FILTER (WHERE stage = 'won')",
        won_value: "coalesce(sum(amount_minor) FILTER (WHERE stage = 'won'), 0) / 100.0",
        lost_count: "count(*) FILTER (WHERE stage = 'lost')",
      },
      sql`SELECT ${dayOf('d.closed_at', w.tz)} AS day, coalesce(d.owner_id, '') AS owner_id, d.lead_source_id AS source_id,
                 d.stage::text AS stage, d.amount_minor
          FROM deals d WHERE ${closedWhere(w, 'any')}`,
      'day, owner_id, source_id',
    ),
    branch(
      { activities: 'count(*)', meetings_held: "count(*) FILTER (WHERE action = 'meeting_logged')" },
      sql`SELECT ${dayOf('l.created_at', w.tz)} AS day, l.actor_user_id AS owner_id, NULL::uuid AS source_id, l.action
          FROM activity_logs l WHERE ${activityWhere(w)}`,
      'day, owner_id, source_id',
    ),
    branch(
      { emails_sent: 'count(*)' },
      sql`SELECT ${dayOf('e.created_at', w.tz)} AS day, e.actor_user_id AS owner_id, NULL::uuid AS source_id
          FROM email_messages e
          WHERE e.tenant_id = ${w.tenantId}::uuid AND e.direction = 'outbound' AND e.status IN ('sent', 'delivered')
            AND e.actor_user_id <> 'system'
            AND e.created_at >= ${w.fromTs.toISOString()}::timestamptz AND e.created_at < ${w.toTs.toISOString()}::timestamptz`,
      'day, owner_id, source_id',
    ),
  ];
  if (withCalls) {
    parts.push(
      branch(
        {
          calls_made: 'count(*)',
          calls_connected: 'count(*) FILTER (WHERE answered_at IS NOT NULL)',
          talk_time_sec: 'coalesce(sum(talk_time_sec), 0)',
        },
        sql`SELECT ${dayOf('coalesce(c.started_at, c.created_at)', w.tz)} AS day, coalesce(c.user_id, '') AS owner_id,
                   d.lead_source_id AS source_id, c.answered_at, c.talk_time_sec
            FROM calls c LEFT JOIN deals d ON d.id = c.lead_id
            WHERE ${outboundCallWhere(w)}`,
        'day, owner_id, source_id',
      ),
    );
  }
  const union = sql.join(parts, sql` UNION ALL `);
  const sums = COLS.filter((c) => c !== 'median_first_response_sec')
    .map((c) => `sum(${c})${c === 'won_value' ? '' : '::int'} AS ${c}`)
    .join(', ');
  return sql`SELECT day, owner_id, source_id, ${sql.raw(sums)},
                    round(max(median_first_response_sec))::int AS median_first_response_sec
             FROM (${union}) u GROUP BY day, owner_id, source_id`;
}

type RawFact = Record<ColName, string | number | null> & { day: string | Date; owner_id: string; source_id: string | null };

export function mapFactRow(r: RawFact): FactRow {
  const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
  return {
    day,
    ownerId: r.owner_id,
    sourceId: r.source_id,
    leadsCreated: Number(r.leads_created ?? 0),
    leadsAssigned: Number(r.leads_assigned ?? 0),
    firstTouchCount: Number(r.first_touch_count ?? 0),
    firstTouchWithinSla: Number(r.first_touch_within_sla ?? 0),
    medianFirstResponseSec: r.median_first_response_sec === null ? null : Number(r.median_first_response_sec),
    callsMade: Number(r.calls_made ?? 0),
    callsConnected: Number(r.calls_connected ?? 0),
    talkTimeSec: Number(r.talk_time_sec ?? 0),
    emailsSent: Number(r.emails_sent ?? 0),
    whatsappSent: 0,
    meetingsHeld: Number(r.meetings_held ?? 0),
    activities: Number(r.activities ?? 0),
    qualified: Number(r.qualified ?? 0),
    quotesSent: Number(r.quotes_sent ?? 0),
    wonCount: Number(r.won_count ?? 0),
    wonValue: Number(r.won_value ?? 0),
    lostCount: Number(r.lost_count ?? 0),
  };
}

/** Live facts for a window, filtered to the scope's owners. */
export async function liveFacts(scope: ReportScope, w: Omit<Window, 'tenantId'>): Promise<FactRow[]> {
  const inner = await dailyFactsSql({ ...w, tenantId: scope.tenantId });
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`SELECT * FROM (${inner}) f WHERE ${ownerIn(scope, sql`f.owner_id`)}`),
  )) as unknown as RawFact[];
  return rows.map(mapFactRow);
}

/** Rollup rows for a day range, filtered to the scope's owners. */
export async function rollupFacts(scope: ReportScope, fromDay: string, toDay: string): Promise<FactRow[]> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT day, owner_id, source_id, leads_created, leads_assigned, first_touch_count, first_touch_within_sla,
             median_first_response_sec, calls_made, calls_connected, talk_time_sec, emails_sent, meetings_held,
             activities, qualified, quotes_sent, won_count, won_value, lost_count
      FROM report_daily_rollup r
      WHERE r.tenant_id = ${scope.tenantId}::uuid AND r.day >= ${fromDay}::date AND r.day <= ${toDay}::date
        AND ${ownerIn(scope, sql`r.owner_id`)}`),
  )) as unknown as RawFact[];
  return rows.map(mapFactRow);
}

