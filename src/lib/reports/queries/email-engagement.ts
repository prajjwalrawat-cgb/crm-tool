import 'server-only';

import { and, eq, gte, lt, sql } from 'drizzle-orm';

import { emailMessages } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { resolveDateRange } from '../filters';
import type { ReportFilter, ReportRunner } from '../types';

/**
 * Email Engagement — outbound delivery health over a time window. One
 * row per terminal status (sent, delivered, failed, queued). Computed
 * derivatives: success rate, retry rate. Future-ready: when we wire
 * Resend webhooks for open/click tracking, those statuses already have
 * a slot in the schema and can be added to the same GROUP BY.
 *
 * Date window applies to `created_at`. Default range: last 30 days.
 *
 * Query shape: single GROUP BY on `status` with a count + retry-sum
 * aggregation. Uses the existing `(tenant_id, created_at)` index path.
 */
export type EmailEngagementRow = {
  status: 'sent' | 'delivered' | 'failed' | 'queued' | 'sending';
  count: number;
  retrySum: number;
};

export type EmailEngagementExtras = {
  windowFrom: string;
  windowTo: string;
  totalSent: number;
  successRate: number; // 0-1 ratio across sent+delivered vs total
  retryRate: number; // 0-1 ratio of retries / total attempts
  /** Attempts inside the window, whatever their status. */
  totalAttempted: number;
  /**
   * Has this workspace EVER sent outbound mail — ignoring the window?
   *
   * The difference between "nothing sent this quarter" and "email was
   * never wired up" is invisible in the windowed counts: both are
   * zero. Rendering the second as "0 sent · 0% delivered" in danger
   * red accuses a workspace of failing at something it never
   * switched on. Consumers use this to pick an empty state instead.
   *
   * Cheap: an EXISTS probe that stops at the first matching row.
   */
  hasEverSent: boolean;
};

const STATUSES: EmailEngagementRow['status'][] = [
  'sent',
  'delivered',
  'failed',
  'queued',
  'sending',
];

export const emailEngagementRunner: ReportRunner<
  ReportFilter,
  EmailEngagementRow,
  EmailEngagementExtras
> = async (tenantId, filters, _context) => {
  const startedAt = Date.now();
  const range = resolveDateRange(filters.range ?? 'last_30d', 'last_30d');

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        status: emailMessages.status,
        count: sql<number>`count(*)::int`,
        retrySum: sql<number>`coalesce(sum(${emailMessages.retryCount}), 0)::bigint`,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.tenantId, tenantId),
          eq(emailMessages.direction, 'outbound'),
          gte(emailMessages.createdAt, range.from),
          lt(emailMessages.createdAt, range.to),
        ),
      )
      .groupBy(emailMessages.status),
  );

  // Pad missing statuses with zeros so the chart axis is stable across
  // tenants — a brand-new tenant with one failed email still gets the
  // same set of bars.
  const byStatus = new Map<EmailEngagementRow['status'], EmailEngagementRow>();
  for (const r of rows) {
    byStatus.set(r.status as EmailEngagementRow['status'], {
      status: r.status as EmailEngagementRow['status'],
      count: Number(r.count),
      retrySum: Number(r.retrySum),
    });
  }
  const ordered: EmailEngagementRow[] = STATUSES.map(
    (s) =>
      byStatus.get(s) ?? {
        status: s,
        count: 0,
        retrySum: 0,
      },
  );

  const total = ordered.reduce((sum, r) => sum + r.count, 0);
  const successful =
    (byStatus.get('sent')?.count ?? 0) +
    (byStatus.get('delivered')?.count ?? 0);
  const totalRetries = ordered.reduce((sum, r) => sum + r.retrySum, 0);

  // Only ask when the window is empty — a workspace with traffic in
  // the window has self-evidently sent mail before, so the extra probe
  // would be pure overhead on the common path.
  const hasEverSent =
    total > 0 ||
    (await tenantTransaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM email_messages
          WHERE tenant_id = ${tenantId}::uuid
            AND direction = 'outbound'
          LIMIT 1
        ) AS ever
      `)) as unknown as Array<{ ever: boolean }>;
      return rows[0]?.ever === true;
    }));

  return {
    rows: ordered,
    extras: {
      windowFrom: range.from.toISOString(),
      windowTo: range.to.toISOString(),
      totalSent: successful,
      successRate: total === 0 ? 0 : successful / total,
      retryRate: total === 0 ? 0 : totalRetries / total,
      totalAttempted: total,
      hasEverSent,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount: total,
      headline: {
        label: `${total} attempted`,
        value:
          total === 0
            ? '—'
            : `${Math.round((successful / total) * 100)}% delivered`,
      },
    },
  };
};
