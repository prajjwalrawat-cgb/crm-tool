import 'server-only';

import { and, eq, sql, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import { customFieldDefinitions } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import {
  DEAL_FIELD_SPECS,
  fieldAppliesSql,
  type CustomFieldSpec,
} from '@/lib/deals/completeness';
import { timeQuery } from '@/lib/pagination/timing';
import { fiscalYearRange } from '@/lib/targets/fiscal';
import {
  splitPortionInWindowSql,
  toISODate,
} from '@/lib/targets/fy-attribution';
import { fiscalQuarters } from '@/lib/targets/quarters';
import { QUOTA_CREDIT_SQL } from '@/lib/targets/quota-credit';

import { STALE_DEAL_DAYS } from './engagement';

/**
 * TEAM SCORECARD QUERIES — the read side of "how is each rep actually
 * working, not just what did they close".
 *
 * Four independent aggregates, each answering one question a sales leader
 * asks about a rep, and each keyed by `deals.owner_id` so they can be
 * merged into one row per teammate:
 *
 *   quarterlyAchievement — where the year's revenue actually landed
 *   pushbackLeaderboard  — who is moving close dates, and by how much
 *   engagementByOwner    — cadence, pipeline hygiene, silence
 *   completenessByOwner  — which data points the deals are missing
 *
 * ---------------------------------------------------------------
 * ATTRIBUTION IS BY OWNER, AND THAT IS A CHOICE
 * ---------------------------------------------------------------
 * Every figure is grouped by the deal's CURRENT owner, not by whoever
 * performed the action. A manager asking "who is pushing deals" wants to
 * know whose pipeline is slipping — and a push performed by an admin on a
 * rep's deal is still that rep's slipping deal. But owner attribution is
 * not the whole truth (a deal reassigned last week brings its whole
 * history with it), so `pushedByOthers` reports how many of the pushes on
 * a rep's deals were made by somebody else, rather than leaving the row
 * to imply the rep made them all.
 *
 * ---------------------------------------------------------------
 * NO NEW TABLES, AND NOTHING BACKFILLED
 * ---------------------------------------------------------------
 * Everything here is derived from what is already recorded:
 * `deal_date_changes` (0058) for pushes, `deals` for cadence and hygiene,
 * `deal_value_splits` (0055/0057) for fiscal attribution. Pushes that
 * happened before 0058 shipped were never recorded, so
 * `pushbackRecordedSince` comes back with every leaderboard and the UI
 * states it — a rep who looks clean may simply pre-date the log.
 */

/* ================================================================
 * 1. Quarterly achievement
 * ================================================================ */

export type QuarterlyAchievementRow = {
  userId: string;
  /** Index 0–3 = Q1–Q4 of the fiscal year. */
  quarterRevenueMinor: [number, number, number, number];
  quarterWonCount: [number, number, number, number];
};

/**
 * Per-owner revenue attributed to each fiscal QUARTER, using the same
 * overlap rule `targetAchievement` uses for the year — see
 * `@/lib/targets/fy-attribution`.
 *
 * Because the four quarter windows partition the fiscal year exactly
 * (half-open, no gaps), the four figures sum back to the annual
 * `fyRevenueMinor` rather than approximately agreeing with it. The one
 * permitted difference is sub-unit: rounding happens per deal per quarter
 * here and per deal per year there, so four roundings can differ from one
 * by a minor unit or two. `selftest-team-analytics` asserts that bound.
 *
 * A deal with no breakdown is credited whole to the quarter it CLOSED in
 * — the same single-year assumption the annual query makes, pushed down
 * one level so the two stay consistent.
 */
export async function quarterlyAchievement(
  tenantId: string,
  fiscalYear: number,
  startMonth: number,
): Promise<QuarterlyAchievementRow[]> {
  const { start, end } = fiscalYearRange(startMonth, fiscalYear);
  const quarters = fiscalQuarters(startMonth, fiscalYear);
  const credited = sql.raw(QUOTA_CREDIT_SQL);

  // One LATERAL over the splits, four columns out of it — one call per
  // quarter to the SAME builder the annual query uses, so the overlap rule
  // is written once for Postgres and read four times here.
  const lateralCols = sql.join(
    quarters.map(
      (q, i) =>
        sql`${splitPortionInWindowSql(toISODate(q.start), toISODate(q.end))} AS in_q${sql.raw(String(i))}`,
    ),
    sql`, `,
  );

  const selectCols = sql.join(
    quarters.map((q, i) => {
      const idx = sql.raw(String(i));
      const qStart = q.start.toISOString();
      const qEnd = q.end.toISOString();
      // Closed-in-quarter is the fallback for a deal with no breakdown,
      // and the count column's definition in both cases.
      const closedInQuarter = sql`closed_at >= ${qStart}::timestamptz AND closed_at < ${qEnd}::timestamptz`;
      return sql`
        COALESCE(SUM(ROUND(
          CASE
            WHEN has_split THEN in_q${idx}
            WHEN ${closedInQuarter} THEN amount_minor::numeric
            ELSE 0::numeric
          END * quota_weight
        )), 0)::bigint AS q${idx}_revenue,
        COUNT(*) FILTER (WHERE ${closedInQuarter})::int AS q${idx}_won`;
    }),
    sql`, `,
  );

  type Row = Record<string, string | number | null> & { user_id: string | null };

  const rows = (await timeQuery('teamAnalytics.quarterlyAchievement', async () =>
    tenantTransaction(async (tx) =>
      tx.execute(sql`
        WITH won AS (
          SELECT id, owner_id, amount_minor, quota_weight, closed_at
          FROM deals
          WHERE tenant_id = ${tenantId}::uuid
            AND stage = 'won'
            AND owner_id IS NOT NULL
            AND deleted_at IS NULL
            AND ${credited}
            AND closed_at >= ${start.toISOString()}::timestamptz
            AND closed_at <  ${end.toISOString()}::timestamptz
        ),
        attributed AS (
          SELECT w.*, sp.has_split, ${sql.join(
            quarters.map((_, i) => sql`sp.in_q${sql.raw(String(i))}`),
            sql`, `,
          )}
          FROM won w
          LEFT JOIN LATERAL (
            SELECT COUNT(*) > 0 AS has_split, ${lateralCols}
            FROM deal_value_splits s
            WHERE s.deal_id = w.id
          ) sp ON TRUE
        )
        SELECT owner_id AS user_id, ${selectCols}
        FROM attributed
        GROUP BY owner_id
      `),
    ),
  )) as unknown as Row[];

  return rows
    .filter((r): r is Row & { user_id: string } => r.user_id != null)
    .map((r) => ({
      userId: r.user_id,
      quarterRevenueMinor: [0, 1, 2, 3].map((i) =>
        Number(r[`q${i}_revenue`] ?? 0),
      ) as [number, number, number, number],
      quarterWonCount: [0, 1, 2, 3].map((i) => Number(r[`q${i}_won`] ?? 0)) as [
        number,
        number,
        number,
        number,
      ],
    }));
}

/* ================================================================
 * 2. Pushback leaderboard
 * ================================================================ */

export type PushbackRow = {
  userId: string;
  /** Individual forward close-date moves in the window. */
  pushEvents: number;
  /** Distinct deals those moves landed on. */
  dealsPushed: number;
  /** Calendar days added across every push. The real cost of the habit. */
  daysPushed: number;
  /** Pushes on this rep's deals made by somebody else (a manager, an import). */
  pushedByOthers: number;
  /** Value of the still-open deals that were pushed. */
  openPushedValueMinor: number;
  /** Deals currently carrying the R6 half-weight haircut (push_count > 3). */
  deweightedCount: number;
  /** The deal that moved most, for the "start here" link. */
  worstDeal: {
    id: string;
    name: string;
    pushes: number;
    days: number;
  } | null;
};

/**
 * Close-date pushes per owner over a window, from `deal_date_changes` —
 * the append-only log, not `deals.push_count`. The cached counter is a
 * lifetime total with no dates on it, so it cannot answer "this year" and
 * cannot be split by rep-then-window. The log can.
 *
 * `is_push` is the flag 0058's trigger persisted at write time, so this
 * counts exactly what the board's "Pushed x3" chip counts. Pull-ins,
 * corrections and the date-clearing on a revert to Lead are all in that
 * table and all excluded here, because the trigger already decided they
 * were not pushes.
 */
export async function pushbackLeaderboard(
  tenantId: string,
  window: { from: Date; to: Date },
): Promise<PushbackRow[]> {
  type Row = {
    user_id: string;
    push_events: string | number;
    deals_pushed: string | number;
    days_pushed: string | number;
    pushed_by_others: string | number;
    open_pushed_value: string | number;
    deweighted_count: string | number;
    worst_deal_id: string | null;
    worst_deal_name: string | null;
    worst_deal_pushes: string | number | null;
    worst_deal_days: string | number | null;
  };

  const rows = (await timeQuery('teamAnalytics.pushbackLeaderboard', async () =>
    tenantTransaction(async (tx) =>
      tx.execute(sql`
        WITH per_deal AS (
          SELECT
            d.owner_id,
            d.id           AS deal_id,
            d.name         AS deal_name,
            d.amount_minor AS amount_minor,
            d.stage        AS stage,
            COUNT(*)::int  AS pushes,
            -- Both dates are non-null on a push (0058 only flags moves
            -- between two real dates), so the subtraction is always defined.
            COALESCE(SUM(c.new_close_date - c.old_close_date), 0)::int AS days,
            COUNT(*) FILTER (
              WHERE c.changed_by IS DISTINCT FROM d.owner_id
            )::int AS by_others
          FROM deal_date_changes c
          JOIN deals d ON d.id = c.deal_id
          WHERE c.tenant_id = ${tenantId}::uuid
            AND c.is_push
            AND c.changed_at >= ${window.from.toISOString()}::timestamptz
            AND c.changed_at <  ${window.to.toISOString()}::timestamptz
            AND d.deleted_at IS NULL
            AND d.owner_id IS NOT NULL
          GROUP BY d.owner_id, d.id, d.name, d.amount_minor, d.stage
        ),
        totals AS (
          SELECT
            owner_id,
            SUM(pushes)::int    AS push_events,
            COUNT(*)::int       AS deals_pushed,
            SUM(days)::int      AS days_pushed,
            SUM(by_others)::int AS pushed_by_others,
            COALESCE(SUM(amount_minor) FILTER (
              WHERE stage NOT IN ('won','lost')
            ), 0)::bigint AS open_pushed_value
          FROM per_deal
          GROUP BY owner_id
        ),
        worst AS (
          SELECT DISTINCT ON (owner_id)
            owner_id, deal_id, deal_name, pushes, days
          FROM per_deal
          ORDER BY owner_id, pushes DESC, days DESC, deal_name ASC
        ),
        -- Current state, not windowed: a haircut applies to the deal now,
        -- whenever the fourth push happened to land.
        deweighted AS (
          SELECT owner_id, COUNT(*)::int AS deweighted_count
          FROM deals
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
            AND owner_id IS NOT NULL
            AND quota_weight < 1.00
          GROUP BY owner_id
        ),
        all_owners AS (
          SELECT owner_id FROM totals
          UNION SELECT owner_id FROM deweighted
        )
        SELECT
          o.owner_id                            AS user_id,
          COALESCE(t.push_events, 0)            AS push_events,
          COALESCE(t.deals_pushed, 0)           AS deals_pushed,
          COALESCE(t.days_pushed, 0)            AS days_pushed,
          COALESCE(t.pushed_by_others, 0)       AS pushed_by_others,
          COALESCE(t.open_pushed_value, 0)      AS open_pushed_value,
          COALESCE(w2.deweighted_count, 0)      AS deweighted_count,
          w.deal_id                             AS worst_deal_id,
          w.deal_name                           AS worst_deal_name,
          w.pushes                              AS worst_deal_pushes,
          w.days                                AS worst_deal_days
        FROM all_owners o
        LEFT JOIN totals     t  ON t.owner_id  = o.owner_id
        LEFT JOIN worst      w  ON w.owner_id  = o.owner_id
        LEFT JOIN deweighted w2 ON w2.owner_id = o.owner_id
      `),
    ),
  )) as unknown as Row[];

  return rows.map((r) => ({
    userId: r.user_id,
    pushEvents: Number(r.push_events) || 0,
    dealsPushed: Number(r.deals_pushed) || 0,
    daysPushed: Number(r.days_pushed) || 0,
    pushedByOthers: Number(r.pushed_by_others) || 0,
    openPushedValueMinor: Number(r.open_pushed_value) || 0,
    deweightedCount: Number(r.deweighted_count) || 0,
    worstDeal:
      r.worst_deal_id && r.worst_deal_name
        ? {
            id: r.worst_deal_id,
            name: r.worst_deal_name,
            pushes: Number(r.worst_deal_pushes) || 0,
            days: Number(r.worst_deal_days) || 0,
          }
        : null,
  }));
}

/**
 * When close-date logging actually started for this tenant. Everything
 * before it is invisible, so a leaderboard covering an earlier window has
 * to say so rather than let a silent zero read as good behaviour.
 */
export async function pushbackRecordedSince(
  tenantId: string,
): Promise<Date | null> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT MIN(changed_at) AS since
      FROM deal_date_changes
      WHERE tenant_id = ${tenantId}::uuid
    `),
  )) as unknown as Array<{ since: string | Date | null }>;
  const raw = rows[0]?.since ?? null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ================================================================
 * 3. Engagement
 * ================================================================ */

export type EngagementRow = {
  userId: string;
  /** Deals created in the window (attributed to the owner). */
  dealsCreated: number;
  createdValueMinor: number;
  /** The rep's busiest week, Monday-anchored. Null when they created none. */
  bestWeekStart: string | null;
  bestWeekCount: number;
  /** Weeks in which they created at least one deal. */
  activeWeeks: number;
  /** Open (not won/lost) deals they own right now. */
  openDeals: number;
  openPipelineMinor: number;
  /** Open deals with no write for `STALE_DEAL_DAYS`. */
  staleOpenDeals: number;
  /** Days since the least-recently-touched open deal was written. */
  oldestUntouchedDays: number | null;
  /** Days since ANY open deal of theirs was written. */
  daysSinceLastTouch: number | null;
  /** Days since their last logged activity of any kind. */
  daysSinceLastActivity: number | null;
  /** Activity-log entries they generated inside the window. */
  activityCount: number;
};

/**
 * Cadence + hygiene per owner. Two different clocks on purpose, and the
 * row keeps them apart:
 *
 *   * WINDOWED — deals created, activity logged. "What did they do this
 *     year?"
 *   * AS OF NOW — open deals, staleness, silence. A deal untouched for 40
 *     days is untouched today regardless of which fiscal year is selected,
 *     and averaging that into a window would hide it.
 */
export async function engagementByOwner(
  tenantId: string,
  window: { from: Date; to: Date },
  opts: { staleDays?: number } = {},
): Promise<EngagementRow[]> {
  const staleDays = opts.staleDays ?? STALE_DEAL_DAYS;

  type Row = {
    user_id: string;
    deals_created: string | number;
    created_value: string | number;
    best_week_start: string | Date | null;
    best_week_count: string | number | null;
    active_weeks: string | number;
    open_deals: string | number;
    open_pipeline: string | number;
    stale_open_deals: string | number;
    oldest_untouched_days: string | number | null;
    days_since_last_touch: string | number | null;
    days_since_last_activity: string | number | null;
    activity_count: string | number;
  };

  const rows = (await timeQuery('teamAnalytics.engagement', async () =>
    tenantTransaction(async (tx) =>
      tx.execute(sql`
        WITH created AS (
          SELECT
            owner_id,
            date_trunc('week', created_at) AS wk,
            COUNT(*)::int AS n,
            COALESCE(SUM(amount_minor), 0)::bigint AS v
          FROM deals
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
            AND owner_id IS NOT NULL
            AND created_at >= ${window.from.toISOString()}::timestamptz
            AND created_at <  ${window.to.toISOString()}::timestamptz
          GROUP BY 1, 2
        ),
        created_totals AS (
          SELECT
            owner_id,
            SUM(n)::int      AS deals_created,
            SUM(v)::bigint   AS created_value,
            COUNT(*)::int    AS active_weeks
          FROM created
          GROUP BY owner_id
        ),
        -- The busiest single week. Ties break to the most recent one:
        -- "they did it again last week" is the more useful reading.
        best_week AS (
          SELECT DISTINCT ON (owner_id) owner_id, wk, n
          FROM created
          ORDER BY owner_id, n DESC, wk DESC
        ),
        open_now AS (
          SELECT
            owner_id,
            COUNT(*)::int AS open_deals,
            COALESCE(SUM(amount_minor), 0)::bigint AS open_pipeline,
            COUNT(*) FILTER (
              WHERE updated_at < NOW() - (${staleDays}::int * INTERVAL '1 day')
            )::int AS stale_open_deals,
            MAX(updated_at) AS last_touch,
            MIN(updated_at) AS oldest_touch
          FROM deals
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
            AND owner_id IS NOT NULL
            AND stage NOT IN ('won','lost')
          GROUP BY owner_id
        ),
        acts AS (
          SELECT
            actor_user_id AS owner_id,
            COUNT(*)::int AS activity_count,
            MAX(created_at) AS last_activity
          FROM activity_logs
          WHERE tenant_id = ${tenantId}::uuid
            AND actor_user_id IS NOT NULL
            AND created_at >= ${window.from.toISOString()}::timestamptz
            AND created_at <  ${window.to.toISOString()}::timestamptz
          GROUP BY actor_user_id
        ),
        all_owners AS (
          SELECT owner_id FROM created_totals
          UNION SELECT owner_id FROM open_now
          UNION SELECT owner_id FROM acts
        )
        SELECT
          o.owner_id                          AS user_id,
          COALESCE(c.deals_created, 0)        AS deals_created,
          COALESCE(c.created_value, 0)        AS created_value,
          b.wk                                AS best_week_start,
          b.n                                 AS best_week_count,
          COALESCE(c.active_weeks, 0)         AS active_weeks,
          COALESCE(n.open_deals, 0)           AS open_deals,
          COALESCE(n.open_pipeline, 0)        AS open_pipeline,
          COALESCE(n.stale_open_deals, 0)     AS stale_open_deals,
          CASE WHEN n.oldest_touch IS NULL THEN NULL ELSE
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - n.oldest_touch)) / 86400)::int
          END                                 AS oldest_untouched_days,
          CASE WHEN n.last_touch IS NULL THEN NULL ELSE
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - n.last_touch)) / 86400)::int
          END                                 AS days_since_last_touch,
          CASE WHEN a.last_activity IS NULL THEN NULL ELSE
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - a.last_activity)) / 86400)::int
          END                                 AS days_since_last_activity,
          COALESCE(a.activity_count, 0)       AS activity_count
        FROM all_owners o
        LEFT JOIN created_totals c ON c.owner_id = o.owner_id
        LEFT JOIN best_week      b ON b.owner_id = o.owner_id
        LEFT JOIN open_now       n ON n.owner_id = o.owner_id
        LEFT JOIN acts           a ON a.owner_id = o.owner_id
      `),
    ),
  )) as unknown as Row[];

  return rows.map((r) => ({
    userId: r.user_id,
    dealsCreated: Number(r.deals_created) || 0,
    createdValueMinor: Number(r.created_value) || 0,
    bestWeekStart: toISOStringOrNull(r.best_week_start),
    bestWeekCount: Number(r.best_week_count ?? 0) || 0,
    activeWeeks: Number(r.active_weeks) || 0,
    openDeals: Number(r.open_deals) || 0,
    openPipelineMinor: Number(r.open_pipeline) || 0,
    staleOpenDeals: Number(r.stale_open_deals) || 0,
    oldestUntouchedDays:
      r.oldest_untouched_days == null ? null : Number(r.oldest_untouched_days),
    daysSinceLastTouch:
      r.days_since_last_touch == null ? null : Number(r.days_since_last_touch),
    daysSinceLastActivity:
      r.days_since_last_activity == null
        ? null
        : Number(r.days_since_last_activity),
    activityCount: Number(r.activity_count) || 0,
  }));
}

/**
 * `timestamptz` reaches here as a driver-dependent shape — a Date on one
 * connection, `2026-06-22 00:00:00+00` on another. Normalising once means
 * the renderer only ever handles ISO, and an unparseable value degrades to
 * "no week" instead of "Invalid Date" on a card.
 */
function toISOStringOrNull(value: string | Date | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ================================================================
 * 4. Field completeness
 * ================================================================ */

export type FieldTally = { applicable: number; filled: number };

export type CompletenessRow = {
  userId: string;
  dealsScored: number;
  /** Tally per field key, including required custom fields. */
  byField: Record<string, FieldTally>;
  /** Every field summed — the row's headline. */
  total: FieldTally;
};

/**
 * Required custom field definitions for deals, promoted to scored data
 * points. Read from the config table (no RLS on it — same access pattern
 * as the rest of `custom_field_definitions`), with an explicit tenant
 * filter.
 */
export async function requiredDealCustomFields(
  tenantId: string,
): Promise<CustomFieldSpec[]> {
  const rows = await db
    .select({
      key: customFieldDefinitions.key,
      label: customFieldDefinitions.label,
    })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.tenantId, tenantId),
        eq(customFieldDefinitions.entityType, 'deal'),
        eq(customFieldDefinitions.required, true),
        eq(customFieldDefinitions.archived, false),
      ),
    );
  return rows.map((r) => ({ key: r.key, label: r.label }));
}

/**
 * Per-owner field completeness over OPEN deals.
 *
 * Won and lost deals are excluded on purpose: their data is history, a rep
 * cannot usefully be asked to go and fix a deal that closed in March, and
 * including them would make the score drift with close volume rather than
 * with the habit it is trying to show. That scope is stated on the card
 * rather than left for someone to infer from a number that looks low.
 *
 * The per-field predicates come from `@/lib/deals/completeness` — one spec
 * list, rendered into SQL here and evaluated in JS by the self-test.
 */
export async function completenessByOwner(
  tenantId: string,
  customFields: readonly CustomFieldSpec[] = [],
): Promise<CompletenessRow[]> {
  // Column aliases are index-based (`app_0`, `fil_0`), never derived from a
  // custom field key — the key is a tenant-controlled string and has no
  // business being an identifier in generated SQL. It rides in as a bound
  // parameter below.
  const projections: SQL[] = [];
  const aggregates: SQL[] = [];
  const keys: string[] = [];

  DEAL_FIELD_SPECS.forEach((spec, i) => {
    const idx = sql.raw(String(i));
    keys.push(spec.key);
    projections.push(
      sql`(${sql.raw(fieldAppliesSql(spec, 'd'))}) AS app_${idx},
          ((${sql.raw(fieldAppliesSql(spec, 'd'))}) AND (${sql.raw(spec.filledSql('d'))})) AS fil_${idx}`,
    );
    aggregates.push(
      sql`COUNT(*) FILTER (WHERE app_${idx})::int AS app_${idx},
          COUNT(*) FILTER (WHERE fil_${idx})::int AS fil_${idx}`,
    );
  });

  customFields.forEach((cf, j) => {
    const i = DEAL_FIELD_SPECS.length + j;
    const idx = sql.raw(String(i));
    keys.push(cf.key);
    // A required custom field applies to every deal — an admin marking it
    // required is the workspace saying so, with no stage nuance available.
    projections.push(
      sql`TRUE AS app_${idx},
          (NULLIF(BTRIM(COALESCE(d.custom_fields ->> (${cf.key})::text, '')), '') IS NOT NULL) AS fil_${idx}`,
    );
    aggregates.push(
      sql`COUNT(*) FILTER (WHERE app_${idx})::int AS app_${idx},
          COUNT(*) FILTER (WHERE fil_${idx})::int AS fil_${idx}`,
    );
  });

  type Row = Record<string, string | number | null> & { user_id: string };

  const rows = (await timeQuery('teamAnalytics.completeness', async () =>
    tenantTransaction(async (tx) =>
      tx.execute(sql`
        WITH scoped AS (
          SELECT d.owner_id, ${sql.join(projections, sql`, `)}
          FROM deals d
          WHERE d.tenant_id = ${tenantId}::uuid
            AND d.deleted_at IS NULL
            AND d.owner_id IS NOT NULL
            AND d.stage NOT IN ('won','lost')
        )
        SELECT owner_id AS user_id,
               COUNT(*)::int AS deals_scored,
               ${sql.join(aggregates, sql`, `)}
        FROM scoped
        GROUP BY owner_id
      `),
    ),
  )) as unknown as Row[];

  return rows.map((r) => {
    const byField: Record<string, FieldTally> = {};
    let applicable = 0;
    let filled = 0;
    keys.forEach((key, i) => {
      const a = Number(r[`app_${i}`] ?? 0);
      const f = Number(r[`fil_${i}`] ?? 0);
      byField[key] = { applicable: a, filled: f };
      applicable += a;
      filled += f;
    });
    return {
      userId: r.user_id,
      dealsScored: Number(r.deals_scored) || 0,
      byField,
      total: { applicable, filled },
    };
  });
}
