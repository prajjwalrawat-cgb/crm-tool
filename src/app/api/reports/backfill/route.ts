import { z } from 'zod';

import { sendWorkflowEvent } from '@/lib/inngest/send';
import { json, withReportSession } from '@/lib/reports/manager/http';
import { listBackfillJobs, startBackfill } from '@/lib/reports/manager/rollup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** GET /api/reports/backfill — progress of every rollup backfill job (admins). */
export async function GET() {
  return withReportSession(async ({ tenant, membership }) => {
    if (membership.role !== 'owner' && membership.role !== 'admin') return json({ error: 'forbidden' }, { status: 403 });
    const jobs = await listBackfillJobs(tenant.id);
    return json({
      jobs: jobs.map((j) => ({ ...j, progressPct: j.daysTotal ? Math.round((j.daysDone / j.daysTotal) * 1000) / 10 : 100 })),
    });
  });
}

/** POST /api/reports/backfill {fromDay, toDay} — start a resumable historical rollup backfill (admins). */
export async function POST(req: Request) {
  return withReportSession(async ({ tenant, membership }) => {
    if (membership.role !== 'owner' && membership.role !== 'admin') return json({ error: 'forbidden' }, { status: 403 });
    const b = Body.safeParse(await req.json().catch(() => ({})));
    if (!b.success) return json({ error: 'invalid_body', issues: b.error.issues }, { status: 400 });
    const jobId = await startBackfill({ tenantId: tenant.id, fromDay: b.data.fromDay, toDay: b.data.toDay, startedBy: membership.userId });
    await sendWorkflowEvent('crm/report.backfill_requested', { tenantId: tenant.id, jobId });
    return json({ jobId }, { status: 202 });
  });
}
