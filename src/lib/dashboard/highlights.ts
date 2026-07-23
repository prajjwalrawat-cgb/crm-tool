import 'server-only';

import { sql } from 'drizzle-orm';

import type { DealStage } from '@/lib/deals/schema';
import { timeQuery } from '@/lib/pagination/timing';
import { tenantTransaction } from '@/lib/db-context';

import type { DashboardRange } from './range';

/**
 * "Key deal highlights" read model — the deal-level movement an exec
 * would otherwise have to open the Pipeline page to find.
 *
 * Five sections, all scoped to the dashboard's shared window (except
 * At risk / Closing soon, which are forward-looking by nature and use
 * their own day thresholds — noted per section below).
 *
 * Each query fetches `limit + 1` rows so the UI knows whether the
 * "View all →" link leads to more than what's shown, without a second
 * COUNT pass.
 */

const DEFAULT_LIMIT = 5;

export type HighlightDeal = {
  id: string;
  name: string;
  stage: DealStage;
  amountMinor: number;
  currency: string;
  ownerId: string | null;
  companyName: string | null;
};

export type BigWin = HighlightDeal & { closedAt: Date };
export type ProgressedDeal = HighlightDeal & {
  fromStage: DealStage;
  toStage: DealStage;
  changedAt: Date;
};
export type NewDeal = HighlightDeal & { createdAt: Date };
export type AtRiskDeal = HighlightDeal & { daysSinceActivity: number };
export type ClosingSoonDeal = HighlightDeal & {
  expectedCloseDate: string;
  daysUntilClose: number;
};

export type DealHighlights = {
  bigWins: { rows: BigWin[]; hasMore: boolean };
  progressed: { rows: ProgressedDeal[]; hasMore: boolean };
  newDeals: { rows: NewDeal[]; hasMore: boolean };
  atRisk: { rows: AtRiskDeal[]; hasMore: boolean; idleDays: number };
  closingSoon: { rows: ClosingSoonDeal[]; hasMore: boolean; lookAheadDays: number };
};

/** Trim the +1 probe row and report whether it was there. */
function take<T>(rows: T[], limit: number): { rows: T[]; hasMore: boolean } {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

type RawDealRow = {
  id: string;
  name: string;
  stage: DealStage;
  amount_minor: string | number;
  currency: string;
  owner_id: string | null;
  company_name: string | null;
};

function mapDeal(r: RawDealRow): HighlightDeal {
  return {
    id: r.id,
    name: r.name,
    stage: r.stage,
    amountMinor: Number(r.amount_minor) || 0,
    currency: r.currency,
    ownerId: r.owner_id,
    companyName: r.company_name,
  };
}

export async function getDealHighlights(
  tenantId: string,
  options: {
    range: DashboardRange;
    ownerId?: string | null;
    limit?: number;
    /** Open deals with no activity for this many days are "at risk". */
    idleDays?: number;
    /** Expected-close window for "closing soon". */
    lookAheadDays?: number;
  },
): Promise<DealHighlights> {
  const { range } = options;
  const ownerId = options.ownerId ?? null;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const idleDays = options.idleDays ?? 14;
  const lookAheadDays = options.lookAheadDays ?? 14;
  const probe = limit + 1;
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  return await timeQuery('dashboard.highlights', async () =>
    tenantTransaction(async (tx) => {
      const [winRows, progressRows, newRows, riskRows, closingRows] =
        await Promise.all([
          tx.execute(sql`
            SELECT d.id, d.name, d.stage::text AS stage,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency, d.owner_id,
                   COALESCE(d.company_name, c.name) AS company_name,
                   d.closed_at
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND d.stage = 'won'
              AND d.closed_at IS NOT NULL
              AND d.closed_at >= ${fromIso}::timestamptz
              AND d.closed_at <  ${toIso}::timestamptz
              AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
            ORDER BY d.amount_minor DESC, d.closed_at DESC
            LIMIT ${probe}
          `) as unknown as Promise<
            Array<RawDealRow & { closed_at: Date | string }>
          >,

          // Stage moves inside the window. `deal_stage_history` is
          // trigger-maintained, one row per occupancy; the row a deal
          // ENTERED is joined back to the one it left (the immediately
          // preceding interval). The deal's very first row is its
          // creation, not a progression, so LAG being NULL drops it.
          tx.execute(sql`
            WITH moves AS (
              SELECT
                sh.deal_id,
                sh.stage::text AS to_stage,
                sh.entered_at,
                LAG(sh.stage::text) OVER (
                  PARTITION BY sh.deal_id ORDER BY sh.entered_at
                ) AS from_stage
              FROM deal_stage_history sh
              WHERE sh.tenant_id = ${tenantId}::uuid
            )
            SELECT d.id, d.name, m.to_stage AS stage,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency, d.owner_id,
                   COALESCE(d.company_name, c.name) AS company_name,
                   m.from_stage, m.to_stage, m.entered_at
            FROM moves m
            INNER JOIN deals d ON d.id = m.deal_id
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE m.from_stage IS NOT NULL
              AND m.entered_at >= ${fromIso}::timestamptz
              AND m.entered_at <  ${toIso}::timestamptz
              AND d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
            ORDER BY m.entered_at DESC
            LIMIT ${probe}
          `) as unknown as Promise<
            Array<
              RawDealRow & {
                from_stage: DealStage;
                to_stage: DealStage;
                entered_at: Date | string;
              }
            >
          >,

          tx.execute(sql`
            SELECT d.id, d.name, d.stage::text AS stage,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency, d.owner_id,
                   COALESCE(d.company_name, c.name) AS company_name,
                   d.created_at
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND d.created_at >= ${fromIso}::timestamptz
              AND d.created_at <  ${toIso}::timestamptz
              AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
            ORDER BY d.created_at DESC
            LIMIT ${probe}
          `) as unknown as Promise<
            Array<RawDealRow & { created_at: Date | string }>
          >,

          // At risk: open deals with nothing logged for `idleDays`.
          // "Activity" = the deal record itself moving (updated_at,
          // which the stage trigger and every edit bump), any
          // activity_logs entry (call/meeting/email sent+synced/stage
          // change), or a note. Deliberately NOT windowed by `range` —
          // silence is measured from today, not from the report period.
          tx.execute(sql`
            WITH open_deals AS (
              SELECT d.id, d.name, d.stage, d.amount_minor, d.currency,
                     d.owner_id, d.company_id, d.company_name, d.updated_at
              FROM deals d
              WHERE d.tenant_id = ${tenantId}::uuid
                AND d.deleted_at IS NULL
                AND d.stage NOT IN ('won', 'lost')
                AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
            ),
            last_touch AS (
              SELECT
                o.id,
                GREATEST(
                  o.updated_at,
                  COALESCE(al.last_at, o.updated_at),
                  COALESCE(n.last_at, o.updated_at)
                ) AS touched_at
              FROM open_deals o
              LEFT JOIN LATERAL (
                SELECT MAX(a.created_at) AS last_at
                FROM activity_logs a
                WHERE a.tenant_id = ${tenantId}::uuid
                  AND a.entity_type = 'deal'
                  AND a.entity_id = o.id::text
              ) al ON TRUE
              LEFT JOIN LATERAL (
                SELECT MAX(nt.created_at) AS last_at
                FROM notes nt
                WHERE nt.tenant_id = ${tenantId}::uuid
                  AND nt.entity_type = 'deal'
                  AND nt.entity_id = o.id
                  AND nt.deleted_at IS NULL
              ) n ON TRUE
            )
            SELECT o.id, o.name, o.stage::text AS stage,
                   o.amount_minor::bigint AS amount_minor,
                   o.currency, o.owner_id,
                   COALESCE(o.company_name, c.name) AS company_name,
                   GREATEST(0, EXTRACT(EPOCH FROM (NOW() - t.touched_at)) / 86400)::int
                     AS days_since_activity
            FROM open_deals o
            INNER JOIN last_touch t ON t.id = o.id
            LEFT JOIN companies c ON c.id = o.company_id
            WHERE t.touched_at < NOW() - (${idleDays}::int * INTERVAL '1 day')
            ORDER BY t.touched_at ASC
            LIMIT ${probe}
          `) as unknown as Promise<
            Array<RawDealRow & { days_since_activity: number }>
          >,

          // Closing soon: strictly forward-looking (today → +N days).
          // Overdue deals are the "At risk" story, not this one.
          tx.execute(sql`
            SELECT d.id, d.name, d.stage::text AS stage,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency, d.owner_id,
                   COALESCE(d.company_name, c.name) AS company_name,
                   d.expected_close_date,
                   (d.expected_close_date - CURRENT_DATE)::int AS days_until_close
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND d.stage NOT IN ('won', 'lost')
              AND d.expected_close_date IS NOT NULL
              AND d.expected_close_date >= CURRENT_DATE
              AND d.expected_close_date <= CURRENT_DATE + (${lookAheadDays}::int * INTERVAL '1 day')
              AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
            ORDER BY d.expected_close_date ASC, d.amount_minor DESC
            LIMIT ${probe}
          `) as unknown as Promise<
            Array<
              RawDealRow & {
                expected_close_date: string;
                days_until_close: number;
              }
            >
          >,
        ]);

      return {
        bigWins: take(
          winRows.map((r) => ({ ...mapDeal(r), closedAt: new Date(r.closed_at) })),
          limit,
        ),
        progressed: take(
          progressRows.map((r) => ({
            ...mapDeal(r),
            fromStage: r.from_stage,
            toStage: r.to_stage,
            changedAt: new Date(r.entered_at),
          })),
          limit,
        ),
        newDeals: take(
          newRows.map((r) => ({
            ...mapDeal(r),
            createdAt: new Date(r.created_at),
          })),
          limit,
        ),
        atRisk: {
          ...take(
            riskRows.map((r) => ({
              ...mapDeal(r),
              daysSinceActivity: Number(r.days_since_activity) || 0,
            })),
            limit,
          ),
          idleDays,
        },
        closingSoon: {
          ...take(
            closingRows.map((r) => ({
              ...mapDeal(r),
              expectedCloseDate: r.expected_close_date,
              daysUntilClose: Number(r.days_until_close) || 0,
            })),
            limit,
          ),
          lookAheadDays,
        },
      };
    }),
  );
}
