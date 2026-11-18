import { NextResponse, type NextRequest } from 'next/server';

import { INGEST_STATUSES, type IngestStatus } from '@/db/schema';
import { listIngestEvents } from '@/lib/lead-capture/admin';
import { UUID_RE, withApiPermission } from '@/lib/lead-capture/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/lead-ingest-events?status=failed&sourceId=&limit= */
export async function GET(request: NextRequest) {
  return withApiPermission('manageLeadCapture', async ({ tenantId }) => {
    const q = request.nextUrl.searchParams;
    const status = q.get('status');
    if (status && !(INGEST_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 });
    }
    const sourceId = q.get('sourceId');
    const events = await listIngestEvents(tenantId, {
      status: status ? (status as IngestStatus) : undefined,
      sourceId: sourceId && UUID_RE.test(sourceId) ? sourceId : undefined,
      limit: Number(q.get('limit') ?? 50) || 50,
    });
    return NextResponse.json({ events });
  });
}
