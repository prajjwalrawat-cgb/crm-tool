import { NextResponse } from 'next/server';

import { getImportJob } from '@/lib/lead-capture/admin';
import { UUID_RE, withApiPermission } from '@/lib/lead-capture/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/jobs/:id — CSV import job progress. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withApiPermission('importLeads', async ({ tenantId }) => {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    const job = await getImportJob(tenantId, id);
    if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(job);
  });
}
