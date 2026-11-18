import 'server-only';

import type { Membership, Tenant } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { scopeUsers, type ReportScope } from './scope';
import { resolveForTenant } from './services';
import type { CompareMode, ResolvedRange } from './time';

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export type ReportPageContext = {
  tenant: Tenant;
  membership: Membership;
  scope: ReportScope;
  range: ResolvedRange;
  compare: ResolvedRange | null;
  compareMode: CompareMode;
  currency: { code: string; locale: string };
  params: Record<string, string>;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Page entry for /dashboard/insights/*: tenant session → membership →
 * `scopeUsers` → range from the URL (?range, ?from, ?to, ?compareTo, all in
 * the tenant timezone). `fn` runs inside the tenant context.
 */
export async function withReportPage<T>(searchParams: SearchParams, fn: (ctx: ReportPageContext) => Promise<T>): Promise<T> {
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const f = first(v);
    if (typeof f === 'string') params[k] = f;
  }
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const [scope, resolved, settings] = await Promise.all([
      scopeUsers({ tenantId: tenant.id, userId, role: membership.role }),
      resolveForTenant(tenant.id, { range: params.range, from: params.from, to: params.to, compareTo: params.compareTo }),
      getOrgSettings(tenant.id),
    ]);
    return await fn({
      tenant,
      membership,
      scope,
      ...resolved,
      currency: { code: settings.defaultCurrency || 'INR', locale: settings.currencyLocale || 'en-IN' },
      params,
    });
  });
}
