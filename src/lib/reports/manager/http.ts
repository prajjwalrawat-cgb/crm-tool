import 'server-only';

import { NextResponse } from 'next/server';

import type { Membership, Tenant } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { getCurrentMembership } from '@/lib/membership';
import { captureError } from '@/lib/observability';
import { getCurrentTenant } from '@/lib/tenant';

import { scopeUsers, type ReportScope } from './scope';

/**
 * Session wrapper for /api/reports/* route handlers: resolves the session's
 * tenant + membership, enters the tenant context, and builds the report
 * scope with `scopeUsers` — every endpoint gets its scope from here.
 * No session → 401; no membership → 403.
 */
export type ReportSession = {
  tenant: Tenant;
  membership: Membership;
  scope: ReportScope;
  /** Re-enter this request's tenant context (for streamed bodies). */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
};

export async function withReportSession(fn: (s: ReportSession) => Promise<Response>): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const tenant = await getCurrentTenant();
  if (!tenant) return NextResponse.json({ error: 'no_workspace' }, { status: 401 });
  const run = <T,>(f: () => Promise<T>) => runWithTenantContext({ tenantId: tenant.id, userId }, f);
  try {
    return await run(async () => {
      const membership = await getCurrentMembership();
      if (!membership || membership.status !== 'active') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      const scope = await scopeUsers({ tenantId: tenant.id, userId, role: membership.role });
      return await fn({ tenant, membership, scope, run });
    });
  } catch (err) {
    captureError(err, { category: 'reports.api.failed', severity: 'medium' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/** URLSearchParams → plain object of the first value per key. */
export function queryOf(req: Request): Record<string, string> {
  const u = new URL(req.url);
  const out: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (!(k in out)) out[k] = v;
  return out;
}

export const json = (body: unknown, init?: { status?: number; cacheSeconds?: number }) =>
  NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { 'Cache-Control': init?.cacheSeconds ? `private, max-age=${init.cacheSeconds}` : 'no-store' },
  });
