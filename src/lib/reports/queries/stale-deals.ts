import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import type { DealStage } from '@/lib/deals/schema';

import type { OwnerScope, ReportFilter, ReportRunner } from '../types';

/**
 * Stale Deals — the attention queue. Surfaces active deals (lead /
 * qualified / proposal / negotiation) that have stopped showing
 * progress on three independent signals:
 *
 *   1. Activity:    no activity_log row in N days (default 30)
 *   2. Email:       no successful outbound send in N days (default 14)
 *   3. Stage move:  no stage_changed activity in N days (default 21)
 *
 * Each signal independently fires when that signal's age exceeds the
 * threshold. Severity is computed in app code from the count of fired
 * signals, so thresholds can be tuned without DB migrations.
 *
 *   ok        — 0 signals fired
 *   watch     — 1 signal fired
 *   stale     — 2 signals fired
 *   critical  — all 3 fired
 *
 * Won/lost deals are excluded entirely — they're done, not stale.
 *
 * Returns up to 200 rows ordered by oldest-signal-first so the most
 * neglected deals surface first. The UI shows them in a table grouped
 * by severity.
 *
 * Query shape: 3 CTEs that aggregate the latest timestamp per deal
 * across the activity/email/stage-change sources, then a single LEFT
 * JOIN onto the deal row. Indexes `activity_logs_tenant_entity_created_desc_idx`
 * and `email_messages_tenant_entity_sent_desc_idx` (CP#14 migration
 * `0014_report_indexes.sql`) make each CTE an index-only max-by-group
 * scan.
 */

export type StaleSeverity = 'ok' | 'watch' | 'stale' | 'critical';

export type StaleDealsRow = {
  dealId: string;
  name: string;
  stage: DealStage;
  amountMinor: number;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastEmailAt: string | null;
  lastStageChangeAt: string | null;
  /** Whole days since each signal. Null when no signal has ever fired. */
  daysSinceActivity: number | null;
  daysSinceEmail: number | null;
  daysSinceStageChange: number | null;
  /** Which signals fired given the configured thresholds. */
  triggers: {
    activityStale: boolean;
    emailStale: boolean;
    stageStale: boolean;
  };
  severity: StaleSeverity;
};

export type StaleDealsFilter = ReportFilter & {
  /** Days of inactivity that count as stale for each signal. */
  activityDays?: number;
  emailDays?: number;
  stageDays?: number;
};

export type StaleDealsExtras = {
  thresholdsUsed: {
    activityDays: number;
    emailDays: number;
    stageDays: number;
  };
  severityCounts: Record<StaleSeverity, number>;
};

const DEFAULT_THRESHOLDS = {
  activityDays: 30,
  emailDays: 14,
  stageDays: 21,
};

const ACTIVE_STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation'];

export const staleDealsRunner: ReportRunner<
  StaleDealsFilter,
  StaleDealsRow,
  StaleDealsExtras
> = async (tenantId, filters, context) => {
  const startedAt = Date.now();
  const thresholds = {
    activityDays: filters.activityDays ?? DEFAULT_THRESHOLDS.activityDays,
    emailDays: filters.emailDays ?? DEFAULT_THRESHOLDS.emailDays,
    stageDays: filters.stageDays ?? DEFAULT_THRESHOLDS.stageDays,
  };

  // Owner scope resolves to either NULL (no filter), or a single user id.
  const ownerScope = filters.owner;
  const ownerFilterValue: string | null =
    !ownerScope || ownerScope.type === 'all'
      ? null
      : ownerScope.type === 'mine'
        ? context.currentUserId
        : ownerScope.userId;

  type RawRow = {
    dealId: string;
    name: string;
    stage: string;
    amountMinor: string;
    ownerId: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastActivityAt: Date | null;
    lastEmailAt: Date | null;
    lastStageChangeAt: Date | null;
  };

  const raw = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH last_activity AS (
        SELECT entity_id::uuid AS deal_id, max(created_at) AS at
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid AND entity_type = 'deal'
        GROUP BY entity_id
      ),
      last_email AS (
        SELECT entity_id AS deal_id, max(created_at) AS at
        FROM email_messages
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND direction = 'outbound'
          AND status IN ('sent','delivered')
        GROUP BY entity_id
      ),
      last_stage AS (
        SELECT entity_id::uuid AS deal_id, max(created_at) AS at
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND action = 'stage_changed'
        GROUP BY entity_id
      )
      SELECT
        d.id                AS "dealId",
        d.name              AS "name",
        d.stage             AS "stage",
        d.amount_minor      AS "amountMinor",
        d.owner_id          AS "ownerId",
        d.created_at        AS "createdAt",
        d.updated_at        AS "updatedAt",
        la.at               AS "lastActivityAt",
        le.at               AS "lastEmailAt",
        ls.at               AS "lastStageChangeAt"
      FROM deals d
      LEFT JOIN last_activity la ON la.deal_id = d.id
      LEFT JOIN last_email    le ON le.deal_id = d.id
      LEFT JOIN last_stage    ls ON ls.deal_id = d.id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.deleted_at IS NULL
        AND d.stage IN ('lead','qualified','proposal','negotiation')
        AND (${ownerFilterValue}::text IS NULL OR d.owner_id = ${ownerFilterValue}::text)
      ORDER BY least(
        coalesce(la.at, d.created_at),
        coalesce(le.at, d.created_at)
      ) ASC
      LIMIT 200
    `),
  )) as unknown as RawRow[];

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const severityCounts: Record<StaleSeverity, number> = {
    ok: 0,
    watch: 0,
    stale: 0,
    critical: 0,
  };

  const rows: StaleDealsRow[] = raw.map((r) => {
    const daysSinceActivity = r.lastActivityAt
      ? Math.floor((now - new Date(r.lastActivityAt).getTime()) / dayMs)
      : null;
    const daysSinceEmail = r.lastEmailAt
      ? Math.floor((now - new Date(r.lastEmailAt).getTime()) / dayMs)
      : null;
    const daysSinceStageChange = r.lastStageChangeAt
      ? Math.floor((now - new Date(r.lastStageChangeAt).getTime()) / dayMs)
      : null;

    // A "never happened" signal counts as stale ONLY if the deal is
    // older than the threshold — newly-created deals don't trigger.
    const dealAgeDays = Math.floor(
      (now - new Date(r.createdAt).getTime()) / dayMs,
    );

    const activityStale =
      daysSinceActivity === null
        ? dealAgeDays > thresholds.activityDays
        : daysSinceActivity > thresholds.activityDays;
    const emailStale =
      daysSinceEmail === null
        ? dealAgeDays > thresholds.emailDays
        : daysSinceEmail > thresholds.emailDays;
    const stageStale =
      daysSinceStageChange === null
        ? dealAgeDays > thresholds.stageDays
        : daysSinceStageChange > thresholds.stageDays;

    const triggered = [activityStale, emailStale, stageStale].filter(
      Boolean,
    ).length;
    const severity: StaleSeverity =
      triggered === 0
        ? 'ok'
        : triggered === 1
          ? 'watch'
          : triggered === 2
            ? 'stale'
            : 'critical';
    severityCounts[severity]++;

    return {
      dealId: r.dealId,
      name: r.name,
      stage: r.stage as DealStage,
      amountMinor: Number(r.amountMinor),
      ownerId: r.ownerId,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
      lastActivityAt: r.lastActivityAt
        ? new Date(r.lastActivityAt).toISOString()
        : null,
      lastEmailAt: r.lastEmailAt ? new Date(r.lastEmailAt).toISOString() : null,
      lastStageChangeAt: r.lastStageChangeAt
        ? new Date(r.lastStageChangeAt).toISOString()
        : null,
      daysSinceActivity,
      daysSinceEmail,
      daysSinceStageChange,
      triggers: { activityStale, emailStale, stageStale },
      severity,
    };
  });

  // Re-order: critical first, then by oldest signal. The SQL ORDER BY
  // already does the "oldest first" — we just bubble criticals up.
  rows.sort((a, b) => {
    const sevRank = (s: StaleSeverity) =>
      ({ critical: 0, stale: 1, watch: 2, ok: 3 })[s];
    if (sevRank(a.severity) !== sevRank(b.severity)) {
      return sevRank(a.severity) - sevRank(b.severity);
    }
    return 0;
  });

  const queryMs = Date.now() - startedAt;
  const flagged =
    severityCounts.critical + severityCounts.stale + severityCounts.watch;

  return {
    rows,
    extras: {
      thresholdsUsed: thresholds,
      severityCounts,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs,
      totalCount: rows.length,
      headline: {
        label: `${flagged} flagged`,
        value:
          severityCounts.critical > 0
            ? `${severityCounts.critical} critical`
            : flagged === 0
              ? 'All clear'
              : `${flagged} need attention`,
      },
    },
  };
};
// Silence unused-import linting when ACTIVE_STAGES is purely for docs.
void ACTIVE_STAGES;
// OwnerScope import kept for documentation symmetry with other runners.
void (null as unknown as OwnerScope | undefined);
