import { NextResponse } from 'next/server';

import { sendWorkflowEvent } from '@/lib/inngest/send';
import { UUID_RE, withApiPermission } from '@/lib/lead-capture/api-auth';
import { resetIngestEventForRetry } from '@/lib/lead-capture/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/lead-ingest-events/:id/retry — re-process a failed event. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withApiPermission('manageLeadCapture', async ({ tenantId }) => {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    if (!(await resetIngestEventForRetry(id))) {
      return NextResponse.json({ error: 'not_retryable', message: 'Only failed events can be retried' }, { status: 409 });
    }
    await sendWorkflowEvent('crm/lead.ingest_received', { tenantId, eventId: id });
    return NextResponse.json({ ok: true });
  });
}
