import { withTenantSession } from '@/lib/auth-guard';
import { resolveDashboardRange } from '@/lib/dashboard/range';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';

import { AdminHome } from './_components/home/admin-home';
import { ManagerHome } from './_components/home/manager-home';
import { SalesHome } from './_components/home/sales-home';

export const metadata = {
  title: 'Dashboard',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Single `/dashboard` route. NO redirects to persona-specific URLs —
 * the route stays stable for everyone; what renders inside switches
 * by persona. Manager view additionally honors `?view=team|rep:<id>`
 * to pivot between team-wide and per-rep funnels.
 *
 * Persona is derived from `personaOf(membership.role)` server-side so
 * a sales user who fakes `?view=rep:other-user` never sees the
 * manager surface — they always get SalesHome regardless of params.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const sp = await searchParams;
    // One window for the whole page — every widget reads this same
    // object rather than parsing `?range=` for itself.
    const range = resolveDashboardRange(sp);

    // Awaiting the home as a function call (rather than returning JSX
    // with `<Home/>`) keeps the data fetching inside the
    // `runWithTenantContext` scope set up by withTenantSession.
    // If we returned JSX, the async children would render AFTER this
    // function returned — and the AsyncLocalStorage tenant context
    // would already be torn down by then.
    if (persona === 'admin') {
      return await AdminHome({
        tenantId: tenant.id,
        tenantName: tenant.name,
        userId,
        view: parseManagerView(sp.view),
        range,
      });
    }

    if (persona === 'manager') {
      const view = parseManagerView(sp.view);
      return await ManagerHome({
        tenantId: tenant.id,
        tenantName: tenant.name,
        userId,
        view,
      });
    }

    return await SalesHome({
      tenantId: tenant.id,
      tenantName: tenant.name,
      userId,
    });
  });
}

/**
 * `?view=team` (default) or `?view=rep:<userId>`. Anything else falls
 * back to team. The userId is left as a raw string — server-side
 * queries scope by tenant + userId, so a bogus id just yields an
 * empty funnel rather than leaking any other tenant's data.
 */
function parseManagerView(
  raw: string | string[] | undefined,
): { mode: 'team' } | { mode: 'rep'; userId: string } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return { mode: 'team' };
  if (value === 'team') return { mode: 'team' };
  if (value.startsWith('rep:')) {
    const userId = value.slice(4).trim();
    if (userId.length > 0 && userId.length <= 128) {
      return { mode: 'rep', userId };
    }
  }
  return { mode: 'team' };
}
