import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { reportBackfillJobs } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { dailyFactsSql, liveFacts, rollupFacts, type FactRow } from './facts';
import type { ReportScope } from './scope';
import {
  addDays,
  dayStartUtc,
  daysBetweenInclusive,
  isValidTz,
  localDay,
  planSegments,
  type ResolvedRange,
  type Segment,
  type Ymd,
} from './time';

/**
 * report_daily_rollup maintenance + the facts reader.
 *
 * Refresh is delete-then-insert for the day range inside one transaction,
 * under a per-tenant advisory lock, with ON CONFLICT DO UPDATE as the belt
 * for any concurrent writer. Re-running a refresh produces identical rows.
 *
 * Coverage: a day is read from the rollup only if a finished backfill job
 * covers it (or it is inside the 7 days the nightly job rebuilds) and it is
 * before today. Today, and anything not covered, is computed live from the
 * same SQL — so a missing rollup makes reports slower, never wrong.
 */

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getTenantTz(tenantId: string): Promise<string> {
  try {
    const s = await getOrgSettings(tenantId);
    return isValidTz(s.timezone) ? s.timezone : 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

/** Rebuild [fromDay, toDay] for one tenant inside `tx`. */
export async function refreshRollupTx(tx: DrizzleTx, tenantId: string, fromDay: Ymd, toDay: Ymd, tz: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`rollup:${tenantId}`}, 0))`);
  await tx.execute(sql`DELETE FROM report_daily_rollup WHERE tenant_id = ${tenantId}::uuid AND day >= ${fromDay}::date AND day <= ${toDay}::date`);
  const facts = await dailyFactsSql({
    tenantId,
    fromTs: dayStartUtc(fromDay, tz),
    toTs: dayStartUtc(addDays(toDay, 1), tz),
    tz,
  });
  const res = (await tx.execute(sql`
    INSERT INTO report_daily_rollup
      (tenant_id, day, owner_id, source_id, leads_created, leads_assigned, first_touch_count, first_touch_within_sla,
       median_first_response_sec, calls_made, calls_connected, talk_time_sec, emails_sent, whatsapp_sent, meetings_held,
       activities, qualified, quotes_sent, won_count, won_value, lost_count, refreshed_at)
    SELECT ${tenantId}::uuid, f.day, f.owner_id, f.source_id, f.leads_created, f.leads_assigned, f.first_touch_count,
           f.first_touch_within_sla, f.median_first_response_sec, f.calls_made, f.calls_connected, f.talk_time_sec,
           f.emails_sent, 0, f.meetings_held, f.activities, f.qualified, f.quotes_sent, f.won_count, f.won_value,
           f.lost_count, now()
    FROM (${facts}) f
    ON CONFLICT (tenant_id, day, owner_id, (COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    DO UPDATE SET
      leads_created = EXCLUDED.leads_created, leads_assigned = EXCLUDED.leads_assigned,
      first_touch_count = EXCLUDED.first_touch_count, first_touch_within_sla = EXCLUDED.first_touch_within_sla,
      median_first_response_sec = EXCLUDED.median_first_response_sec, calls_made = EXCLUDED.calls_made,
      calls_connected = EXCLUDED.calls_connected, talk_time_sec = EXCLUDED.talk_time_sec,
      emails_sent = EXCLUDED.emails_sent, meetings_held = EXCLUDED.meetings_held, activities = EXCLUDED.activities,
      qualified = EXCLUDED.qualified, quotes_sent = EXCLUDED.quotes_sent, won_count = EXCLUDED.won_count,
      won_value = EXCLUDED.won_value, lost_count = EXCLUDED.lost_count, refreshed_at = now()
    RETURNING 1`)) as unknown as unknown[];
  return res.length;
}

/** Must run inside a tenant/system context. */
export async function refreshRollup(tenantId: string, fromDay: Ymd, toDay: Ymd): Promise<number> {
  const tz = await getTenantTz(tenantId);
  return await tenantTransaction((tx) => refreshRollupTx(tx, tenantId, fromDay, toDay, tz));
}

/** The 15-minute job: today and yesterday (late-arriving data). */
export async function refreshRecent(tenantId: string, now = new Date()): Promise<number> {
  const tz = await getTenantTz(tenantId);
  const today = localDay(now, tz);
  return await tenantTransaction((tx) => refreshRollupTx(tx, tenantId, addDays(today, -1), today, tz));
}

/** The nightly job: the last 7 days. */
export async function refreshLastWeek(tenantId: string, now = new Date()): Promise<number> {
  const tz = await getTenantTz(tenantId);
  const today = localDay(now, tz);
  return await tenantTransaction((tx) => refreshRollupTx(tx, tenantId, addDays(today, -7), today, tz));
}

/** Earliest day a finished backfill covers, or null. */
export async function rollupCoveredFrom(tenantId: string): Promise<Ymd | null> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`SELECT min(from_day)::text AS d FROM report_backfill_jobs WHERE tenant_id = ${tenantId}::uuid AND status = 'done'`),
  )) as unknown as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}

/**
 * Facts for a resolved range in scope: rollup where covered, live elsewhere.
 * Returns the rows plus which source served each part (shown in the UI as
 * "live" / "as of hh:mm").
 */
export async function readFacts(
  scope: ReportScope,
  range: ResolvedRange,
  now = new Date(),
): Promise<{ rows: FactRow[]; servedBy: Segment[] }> {
  const tz = range.tz;
  const covered = await rollupCoveredFrom(scope.tenantId);
  const segments = planSegments(range.fromDay, range.toDay, covered, localDay(now, tz));

  const parts = await Promise.all(
    segments.map((s) =>
      s.source === 'rollup'
        ? rollupFacts(scope, s.from, s.to)
        : liveFacts(scope, { fromTs: dayStartUtc(s.from, tz), toTs: dayStartUtc(addDays(s.to, 1), tz), tz }),
    ),
  );
  return { rows: parts.flat(), servedBy: segments };
}

/* --------------------------------------------------------------- backfill */

export async function startBackfill(args: { tenantId: string; fromDay: Ymd; toDay: Ymd; startedBy: string | null }): Promise<string> {
  const [from, to] = args.fromDay <= args.toDay ? [args.fromDay, args.toDay] : [args.toDay, args.fromDay];
  const [row] = await tenantTransaction((tx) =>
    tx
      .insert(reportBackfillJobs)
      .values({
        tenantId: args.tenantId,
        fromDay: from,
        toDay: to,
        cursorDay: from,
        daysTotal: daysBetweenInclusive(from, to),
        startedBy: args.startedBy,
      })
      .returning({ id: reportBackfillJobs.id }),
  );
  return row!.id;
}

/**
 * Process up to `maxDays` days of a job. Each day's rollup rows and the
 * cursor advance commit in ONE transaction, so killing the job at any point
 * leaves it resumable at the first unfinished day with no partial day.
 * Returns true when the job is finished.
 */
export async function runBackfillChunk(tenantId: string, jobId: string, maxDays = 31): Promise<{ done: boolean; daysDone: number; daysTotal: number }> {
  const tz = await getTenantTz(tenantId);
  for (let i = 0; i < maxDays; i++) {
    const step = await tenantTransaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(reportBackfillJobs)
        .where(and(eq(reportBackfillJobs.id, jobId), eq(reportBackfillJobs.tenantId, tenantId)))
        .for('update');
      if (!job) return { done: true, daysDone: 0, daysTotal: 0 };
      if (job.status === 'done' || job.cursorDay > job.toDay) {
        if (job.status !== 'done') {
          await tx.update(reportBackfillJobs).set({ status: 'done', finishedAt: new Date(), updatedAt: new Date() }).where(eq(reportBackfillJobs.id, jobId));
        }
        return { done: true, daysDone: job.daysDone, daysTotal: job.daysTotal };
      }
      await refreshRollupTx(tx, tenantId, job.cursorDay, job.cursorDay, tz);
      const next = addDays(job.cursorDay, 1);
      const finished = next > job.toDay;
      await tx
        .update(reportBackfillJobs)
        .set({
          cursorDay: next,
          daysDone: job.daysDone + 1,
          status: finished ? 'done' : 'running',
          finishedAt: finished ? new Date() : null,
          updatedAt: new Date(),
          error: null,
        })
        .where(eq(reportBackfillJobs.id, jobId));
      return { done: finished, daysDone: job.daysDone + 1, daysTotal: job.daysTotal };
    });
    if (step.done) return step;
    if (i === maxDays - 1) return step;
  }
  return { done: false, daysDone: 0, daysTotal: 0 };
}

export async function markBackfillFailed(tenantId: string, jobId: string, error: string): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .update(reportBackfillJobs)
      .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(reportBackfillJobs.id, jobId), eq(reportBackfillJobs.tenantId, tenantId))),
  );
}

export async function listBackfillJobs(tenantId: string) {
  return await tenantTransaction((tx) =>
    tx
      .select()
      .from(reportBackfillJobs)
      .where(eq(reportBackfillJobs.tenantId, tenantId))
      .orderBy(asc(reportBackfillJobs.createdAt)),
  );
}
