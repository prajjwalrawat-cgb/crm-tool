import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';

/**
 * Unified intelligence timeline. Single read that union-ALLs four
 * source streams into a chronological feed:
 *
 *   - activity_logs (deal/contact/company/task mutations)
 *   - ai_summaries (newly-generated or refreshed insights)
 *   - communication_events (email sent/failed/replied)
 *   - relationship_signals (status transitions, when we cache them)
 *
 * The Command Center renders the result as a single timeline with
 * severity-tinted dots. Every row carries an entity reference so the
 * UI can deep-link.
 *
 * Why a SQL UNION instead of in-memory merge: each individual source
 * already hits its own (tenant_id, created_at) index. UNION over a
 * shared LIMIT pushes the ordering into Postgres — three orders-of-
 * -magnitude faster than fetching all rows and merging client-side.
 */

export type IntelligenceTimelineKind =
  | 'activity'
  | 'ai_summary'
  | 'comm_event'
  | 'relationship';

export type IntelligenceTimelineRow = {
  kind: IntelligenceTimelineKind;
  occurredAt: string;
  /** The action / event / status verb. */
  label: string;
  /** Short headline. */
  title: string;
  /** Polymorphic entity reference for deep-linking. */
  entityType: string | null;
  entityId: string | null;
  /** Discrete signal so the UI can pick an icon + tint. */
  severity: 'info' | 'success' | 'warning' | 'danger';
};

/**
 * Read the latest N timeline rows across all four streams. v1 hard-
 * codes a 24-hour window; the Command Center re-fetches the page.
 */
export async function readIntelligenceTimeline(
  tenantId: string,
  options: { hours?: number; limit?: number } = {},
): Promise<IntelligenceTimelineRow[]> {
  const hours = options.hours ?? 24;
  const limit = options.limit ?? 40;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  type Row = {
    kind: IntelligenceTimelineKind;
    occurred_at: string;
    label: string;
    title: string;
    entity_type: string | null;
    entity_id: string | null;
    severity: 'info' | 'success' | 'warning' | 'danger';
  };

  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      (
        SELECT
          'activity'::text                                   AS kind,
          created_at::text                                   AS occurred_at,
          action                                             AS label,
          coalesce(metadata->>'name', '') || ' '
            || coalesce(action, '')                          AS title,
          entity_type                                        AS entity_type,
          entity_id                                          AS entity_id,
          CASE action
            WHEN 'deleted'      THEN 'warning'::text
            WHEN 'email_failed' THEN 'danger'
            WHEN 'task_completed' THEN 'success'
            WHEN 'stage_changed' THEN 'info'
            ELSE 'info'
          END                                                AS severity
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= ${cutoff}::timestamptz
      )
      UNION ALL
      (
        SELECT
          'ai_summary'::text                                 AS kind,
          generated_at::text                                 AS occurred_at,
          'generated'                                        AS label,
          entity_type || ' summary refreshed'                AS title,
          entity_type                                        AS entity_type,
          entity_id                                          AS entity_id,
          'info'::text                                       AS severity
        FROM ai_summaries
        WHERE tenant_id = ${tenantId}::uuid
          AND generated_at >= ${cutoff}::timestamptz
      )
      UNION ALL
      (
        SELECT
          'comm_event'::text                                 AS kind,
          ce.created_at::text                                AS occurred_at,
          ce.event_kind                                      AS label,
          coalesce(t.subject_raw, '(no subject)')            AS title,
          'thread'::text                                     AS entity_type,
          t.id::text                                         AS entity_id,
          CASE ce.event_kind
            WHEN 'failed'   THEN 'danger'::text
            WHEN 'bounced'  THEN 'danger'
            WHEN 'replied'  THEN 'success'
            WHEN 'opened'   THEN 'success'
            WHEN 'clicked'  THEN 'success'
            WHEN 'delivered' THEN 'success'
            ELSE 'info'
          END                                                AS severity
        FROM communication_events ce
        LEFT JOIN communication_threads t ON t.id = ce.thread_id
        WHERE ce.tenant_id = ${tenantId}::uuid
          AND ce.created_at >= ${cutoff}::timestamptz
      )
      UNION ALL
      (
        SELECT
          'relationship'::text                               AS kind,
          rs.updated_at::text                                AS occurred_at,
          rs.status                                          AS label,
          'relationship now ' || rs.status                   AS title,
          rs.entity_type                                     AS entity_type,
          rs.entity_id::text                                 AS entity_id,
          CASE rs.status
            WHEN 'at_risk' THEN 'danger'::text
            WHEN 'stale'   THEN 'warning'
            WHEN 'healthy' THEN 'success'
            ELSE 'info'
          END                                                AS severity
        FROM relationship_signals rs
        WHERE rs.tenant_id = ${tenantId}::uuid
          AND rs.updated_at >= ${cutoff}::timestamptz
      )
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `),
  )) as unknown as Row[];

  return rows.map((r) => ({
    kind: r.kind,
    occurredAt: r.occurred_at,
    label: r.label,
    title: r.title,
    entityType: r.entity_type,
    entityId: r.entity_id,
    severity: r.severity,
  }));
}
