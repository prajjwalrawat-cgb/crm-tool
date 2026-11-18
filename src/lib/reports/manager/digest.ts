import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import type { MembershipRole, SavedReportSchedule } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { getEmailProvider, getSenderIdentity } from '@/lib/email/providers/factory';
import { captureError, logger } from '@/lib/observability';

import { METRICS, formatMetric, isMetricKey, metricValue } from '../metrics';
import { renderDigestHtml, renderDigestShort, renderDigestText, type DigestData, type DigestTile } from './digest-render';
import { delta, sumCounters } from './math';
import { generateNarrative } from './narrative';
import { getTenantTz, readFacts } from './rollup';
import { scopeUsers, type ReportScope } from './scope';
import { funnel, repProductivity, slaStats, sourceRoiReport, staleLeads, summary } from './services';
import { addDays, compareRange, localDay, localWeekdayHour, resolveRange, weekStart, type ResolvedRange } from './time';

/**
 * Scheduled digests. An hourly cron calls `runDigestsForTenant`, which
 * decides in the tenant's timezone what is due:
 *   - 09:00 every day  → daily manager digest (yesterday vs the day before)
 *   - 09:00 on Monday  → weekly digest (last week vs the week before)
 *   - saved reports whose schedule hour (and weekday) matches
 *
 * Idempotent: before sending, a row is inserted into report_digest_runs
 * keyed (tenant, digest, recipient, period). If it already exists, nothing
 * is sent — so re-running the same hour (or a retried Inngest step) sends
 * each digest once. A failed send is recorded as status 'failed' and is not
 * retried automatically.
 *
 * WhatsApp: `renderDigestShort` produces the 5-line version, but no
 * WhatsApp provider exists yet, so nothing is sent there (see BUILD_NOTES).
 */

const DIGEST_HOUR = 9;
const MANAGER_ROLES: MembershipRole[] = ['owner', 'admin', 'manager'];

function appUrl(path: string): string {
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}`;
}

async function recipientsWithRoles(tenantId: string, roles: MembershipRole[]) {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT m.user_id, m.role::text AS role FROM memberships m
      WHERE m.tenant_id = ${tenantId}::uuid AND m.status = 'active'
        AND m.role::text = ANY(${`{${roles.join(',')}}`}::text[])`),
  )) as unknown as Array<{ user_id: string; role: MembershipRole }>;
  return rows;
}

async function mutedUsers(tenantId: string, digest: 'daily' | 'weekly'): Promise<Set<string>> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`SELECT user_id FROM report_digest_mutes WHERE tenant_id = ${tenantId}::uuid AND digest IN (${digest}, 'all')`),
  )) as unknown as Array<{ user_id: string }>;
  return new Set(rows.map((r) => r.user_id));
}

async function emailOf(userId: string): Promise<string | null> {
  const rows = (await db.execute(sql`SELECT email FROM users WHERE id = ${userId}`)) as unknown as Array<{ email: string | null }>;
  return rows[0]?.email ?? null;
}

/** Claim the (digest, recipient, period) slot. True = we own it and should send. */
export async function claimDigest(tenantId: string, digestKey: string, recipient: string, period: string): Promise<boolean> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      INSERT INTO report_digest_runs (tenant_id, digest_key, recipient_user_id, period, status)
      VALUES (${tenantId}::uuid, ${digestKey}, ${recipient}, ${period}::date, 'sending')
      ON CONFLICT DO NOTHING RETURNING 1`),
  )) as unknown as unknown[];
  return rows.length > 0;
}

async function finishDigest(tenantId: string, digestKey: string, recipient: string, period: string, status: 'sent' | 'failed' | 'skipped', error?: string) {
  await tenantTransaction((tx) =>
    tx.execute(sql`
      UPDATE report_digest_runs SET status = ${status}, error = ${error ?? null}, sent_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND digest_key = ${digestKey} AND recipient_user_id = ${recipient} AND period = ${period}::date`),
  );
}

async function deliver(to: string, subject: string, data: DigestData, idempotencyKey: string): Promise<'sent' | 'skipped' | string> {
  const provider = getEmailProvider();
  if (provider.name === 'console') {
    logger.info('report.digest.console', { subject, preview: renderDigestShort(data) });
    return 'skipped';
  }
  const res = await provider.send({
    from: getSenderIdentity(),
    to: [to],
    cc: [],
    bcc: [],
    subject,
    text: renderDigestText(data),
    html: renderDigestHtml(data),
    idempotencyKey,
  });
  return res.status === 'accepted' ? 'sent' : res.reason;
}

function tile(label: string, unit: Parameters<typeof formatMetric>[0], cur: number | null, prev: number | null, higherIsBetter: boolean): DigestTile {
  const d = delta(cur, prev);
  const dir = d.absolute === null ? null : d.absolute > 0 ? 'up' : d.absolute < 0 ? 'down' : 'flat';
  return {
    label,
    value: formatMetric(unit, cur),
    change: d.absolute === null ? null : `${d.absolute > 0 ? '+' : ''}${formatMetric(unit, d.absolute)}${d.percent !== null ? ` (${d.percent > 0 ? '+' : ''}${d.percent}%)` : ''}`,
    direction: dir,
    good: dir === null || dir === 'flat' ? null : (dir === 'up') === higherIsBetter,
  };
}

/** The daily manager digest's content for one recipient. */
export async function buildDailyDigest(scope: ReportScope, workspaceName: string, now = new Date()): Promise<{ data: DigestData; period: string }> {
  const tz = await getTenantTz(scope.tenantId);
  const yesterday = addDays(localDay(now, tz), -1);
  const range = resolveRange({ preset: 'custom', from: yesterday, to: yesterday, tz, now });
  const compare = compareRange(range, 'previous')!;
  const [sum, sla, stale, reps, narrative] = await Promise.all([
    summary(scope, range, compare),
    slaStats(scope, range),
    staleLeads(scope, 7, null, 2000),
    repProductivity(scope, range),
    generateNarrative({ scope, range, compare }).catch(() => null),
  ]);
  const tiles = sum.tiles
    .filter((t) => ['lead_volume', 'contact_rate', 'sla_compliance_pct', 'won_value'].includes(t.key))
    .map((t) => tile(t.label, t.unit, t.value, t.delta?.previous ?? null, t.higherIsBetter));
  const ranked = reps.rows.filter((r) => r.won || r.calls || r.activitiesPerDay);
  const top = ranked[0];
  const bottom = ranked.length > 1 ? ranked[ranked.length - 1] : undefined;
  const data: DigestData = {
    title: 'Daily sales digest',
    workspaceName,
    periodLabel: yesterday,
    tiles,
    tables: [
      {
        title: 'Attention',
        headers: ['', 'Count'],
        rows: [
          { cells: ['SLA breaches yesterday', String(sla.total.breached)] },
          { cells: ['Stale leads (no activity 7+ days)', String(stale.rows.length)] },
        ],
      },
      ...(top
        ? [
            {
              title: 'Reps',
              headers: ['', 'Rep', 'Won value', 'Calls'],
              rows: [
                { cells: ['Top', top.name, formatMetric('currency', top.wonValue), String(top.calls)] },
                ...(bottom ? [{ cells: ['Needs a look', bottom.name, formatMetric('currency', bottom.wonValue), String(bottom.calls)] }] : []),
              ],
            },
          ]
        : []),
    ],
    actions: narrative && narrative.status === 'ok' ? narrative.narrative.actions_for_manager.slice(0, 3).map((a) => a.action) : [],
    link: appUrl('/dashboard/insights?range=custom&from=' + yesterday + '&to=' + yesterday),
    unsubscribeLink: appUrl('/dashboard/settings/digests'),
  };
  return { data, period: yesterday };
}

/** The weekly digest: last full week (Mon–Sun) vs the week before, funnel, source ROI. */
export async function buildWeeklyDigest(scope: ReportScope, workspaceName: string, now = new Date()): Promise<{ data: DigestData; period: string }> {
  const tz = await getTenantTz(scope.tenantId);
  const thisMonday = weekStart(localDay(now, tz));
  const from = addDays(thisMonday, -7);
  const to = addDays(thisMonday, -1);
  const range = resolveRange({ preset: 'custom', from, to, tz, now });
  const compare = compareRange(range, 'previous')!;
  const [sum, fun, roi] = await Promise.all([summary(scope, range, compare), funnel(scope, range), sourceRoiReport(scope, range)]);
  const data: DigestData = {
    title: 'Weekly sales digest',
    workspaceName,
    periodLabel: `${from} – ${to}`,
    tiles: sum.tiles
      .filter((t) => ['lead_volume', 'won_value', 'sla_compliance_pct'].includes(t.key))
      .map((t) => tile(t.label, t.unit, t.value, t.delta?.previous ?? null, t.higherIsBetter)),
    tables: [
      {
        title: `Funnel (${fun.cohortSize} leads created)`,
        headers: ['Stage', 'Reached', 'Step %'],
        rows: fun.steps.map((s) => ({ cells: [s.stage, String(s.count), s.stepConversionPct === null ? '—' : `${s.stepConversionPct}%`] })),
      },
      {
        title: 'Lead sources',
        headers: ['Source', 'Leads', 'Won', 'Won value', 'ROI'],
        rows: roi.rows.slice(0, 8).map((r) => ({ cells: [r.name, String(r.leads), String(r.won), formatMetric('currency', r.wonValue), formatMetric('ratio', r.roi)] })),
      },
    ],
    actions: [],
    link: appUrl(`/dashboard/insights?range=custom&from=${from}&to=${to}`),
    unsubscribeLink: appUrl('/dashboard/settings/digests'),
  };
  return { data, period: thisMonday };
}

async function buildSavedReportDigest(scope: ReportScope, workspaceName: string, report: { id: string; name: string; definition: { metrics: string[]; range: string; compare?: string | null } }) {
  const tz = await getTenantTz(scope.tenantId);
  const range: ResolvedRange = resolveRange({ preset: report.definition.range, tz });
  const compare = compareRange(range, report.definition.compare === 'yoy' ? 'yoy' : 'previous');
  const [cur, prev] = await Promise.all([readFacts(scope, range), compare ? readFacts(scope, compare) : Promise.resolve(null)]);
  const c = sumCounters(cur.rows);
  const p = prev ? sumCounters(prev.rows) : null;
  const tiles = report.definition.metrics.filter(isMetricKey).flatMap((k) => {
    const def = METRICS[k];
    if (def.source !== 'rollup') return [];
    return [tile(def.label, def.unit, metricValue(k, c, { reps: 1, days: range.days }), p ? metricValue(k, p, { reps: 1, days: compare!.days }) : null, def.higherIsBetter)];
  });
  return {
    title: report.name,
    workspaceName,
    periodLabel: `${range.fromDay} – ${range.toDay}`,
    tiles,
    tables: [],
    actions: [],
    link: appUrl(`/dashboard/insights/saved?id=${report.id}`),
    unsubscribeLink: appUrl('/dashboard/settings/digests'),
  } satisfies DigestData;
}

export type DigestRunResult = { daily: number; weekly: number; saved: number; skipped: number };

/** Must run inside runWithSystemContext(tenantId). */
export async function runDigestsForTenant(tenantId: string, workspaceName: string, now = new Date()): Promise<DigestRunResult> {
  const out: DigestRunResult = { daily: 0, weekly: 0, saved: 0, skipped: 0 };
  const tz = await getTenantTz(tenantId);
  const { weekday, hour } = localWeekdayHour(now, tz);

  const send = async (key: string, userId: string, role: MembershipRole, build: (s: ReportScope) => Promise<{ data: DigestData; period: string }>, periodHint: string) => {
    if (!(await claimDigest(tenantId, key, userId, periodHint))) {
      out.skipped++;
      return false;
    }
    try {
      const email = await emailOf(userId);
      if (!email) {
        await finishDigest(tenantId, key, userId, periodHint, 'skipped', 'no email');
        return false;
      }
      const scope = await scopeUsers({ tenantId, userId, role });
      const { data } = await build(scope);
      const result = await deliver(email, `${data.title} · ${data.periodLabel}`, data, `${tenantId}:${key}:${userId}:${periodHint}`);
      await finishDigest(tenantId, key, userId, periodHint, result === 'sent' ? 'sent' : result === 'skipped' ? 'skipped' : 'failed', result === 'sent' || result === 'skipped' ? undefined : result);
      return result === 'sent' || result === 'skipped';
    } catch (err) {
      captureError(err, { category: 'reports.digest.failed', severity: 'medium', fields: { key } });
      await finishDigest(tenantId, key, userId, periodHint, 'failed', err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  if (hour === DIGEST_HOUR) {
    const managers = await recipientsWithRoles(tenantId, MANAGER_ROLES);
    const mutedDaily = await mutedUsers(tenantId, 'daily');
    const yesterday = addDays(localDay(now, tz), -1);
    for (const m of managers) {
      if (mutedDaily.has(m.user_id)) continue;
      if (await send('daily', m.user_id, m.role, (s) => buildDailyDigest(s, workspaceName, now), yesterday)) out.daily++;
    }
    if (weekday === 1) {
      const mutedWeekly = await mutedUsers(tenantId, 'weekly');
      const monday = weekStart(localDay(now, tz));
      for (const m of managers) {
        if (mutedWeekly.has(m.user_id)) continue;
        if (await send('weekly', m.user_id, m.role, (s) => buildWeeklyDigest(s, workspaceName, now), monday)) out.weekly++;
      }
    }
  }

  // Saved reports with a schedule due this hour. Each recipient sees the
  // report in THEIR scope, not the author's.
  const saved = (await tenantTransaction((tx) =>
    tx.execute(sql`SELECT id, name, definition, schedule FROM saved_reports WHERE tenant_id = ${tenantId}::uuid AND schedule IS NOT NULL`),
  )) as unknown as Array<{ id: string; name: string; definition: { metrics: string[]; range: string; compare?: string | null }; schedule: SavedReportSchedule }>;
  const today = localDay(now, tz);
  const allMembers = await recipientsWithRoles(tenantId, ['owner', 'admin', 'manager', 'member', 'viewer']);
  const roleOf = new Map(allMembers.map((m) => [m.user_id, m.role]));
  for (const r of saved) {
    const s = r.schedule;
    if (!s || s.hour !== hour || (s.frequency === 'weekly' && s.weekday !== weekday)) continue;
    for (const uid of s.recipients ?? []) {
      const role = roleOf.get(uid);
      if (!role) continue;
      if (await send(`saved:${r.id}`, uid, role, async (scope) => ({ data: await buildSavedReportDigest(scope, workspaceName, r), period: today }), today)) out.saved++;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ mutes */

export async function listMutes(tenantId: string, userId: string): Promise<string[]> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`SELECT digest FROM report_digest_mutes WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}`),
  )) as unknown as Array<{ digest: string }>;
  return rows.map((r) => r.digest);
}

export async function setMute(tenantId: string, userId: string, digest: 'daily' | 'weekly' | 'all', muted: boolean): Promise<void> {
  await tenantTransaction((tx) =>
    muted
      ? tx.execute(sql`INSERT INTO report_digest_mutes (tenant_id, user_id, digest) VALUES (${tenantId}::uuid, ${userId}, ${digest}) ON CONFLICT DO NOTHING`)
      : tx.execute(sql`DELETE FROM report_digest_mutes WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId} AND digest = ${digest}`),
  );
}
