import 'server-only';

import { NextResponse } from 'next/server';

import type { MembershipRole } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';

import { TelephonyError } from './types';

export type Viewer = { tenantId: string; userId: string; role: MembershipRole };

/**
 * Session for /api/calls/* route handlers. Runs `fn` inside the tenant
 * context, maps TelephonyError to a 4xx JSON response and a missing session
 * to 401.
 */
export async function withViewer(fn: (viewer: Viewer) => Promise<Response>): Promise<Response> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return await runWithTenantContext({ tenantId: orgId, userId }, async () => {
    const membership = await requireMembership();
    try {
      return await fn({ tenantId: orgId, userId, role: membership.role });
    } catch (err) {
      if (err instanceof TelephonyError) {
        const status = err.code === 'not_found' ? 404 : err.code === 'not_owner' ? 403 : 409;
        return NextResponse.json({ error: err.code, message: err.message }, { status });
      }
      throw err;
    }
  });
}
