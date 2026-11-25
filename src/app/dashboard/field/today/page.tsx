import { requirePermission, withTenantSession } from '@/lib/auth-guard';
import { formatCompactTenantCurrency } from '@/lib/currency/format';
import { getDay } from '@/lib/field/day';
import type { FieldActor } from '@/lib/field/types';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { can } from '@/lib/rbac';

import { DayBoard } from '../_components/day-board';
import { isValidDate, safeTz, todayInTz } from '../_lib/datetime';
import { scopedMeetingStart } from '../_lib/meeting-start';
import { listOwnersInScope } from '../_lib/owners';
import { TenantTzProvider } from '../_lib/tz-context';

export const metadata = {
  title: 'Field day',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Manager / admin board for one tenant-local day: KPI strip and one 09:00–19:00
 * swimlane per rep. Filters live in the URL (`?date=`, `?rep=`, `?risk=1`);
 * `?m=<id>` (notification links) opens that meeting's panel and, without a
 * `?date`, that meeting's day. The client refreshes this server render every
 * 30 s while visible and on realtime meeting updates.
 */
export default async function FieldTodayPage({ searchParams }: { searchParams: SearchParams }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { membership } = await requirePermission('viewFieldTeam');
    const actor: FieldActor = { tenantId: tenant.id, userId, role: membership.role };
    const sp = await searchParams;
    const org = await getOrgSettings(tenant.id);
    const tz = safeTz(org.timezone);
    const today = todayInTz(tz);
    const focusId = first(sp.m)?.trim() || null;

    let date = first(sp.date);
    if (!isValidDate(date)) {
      const start = focusId ? await scopedMeetingStart(actor, focusId) : null;
      date = start ? todayInTz(tz, start) : today;
    }
    const repId = first(sp.rep)?.trim() || null;
    const atRiskOnly = first(sp.risk) === '1';

    const [day, owners] = await Promise.all([
      getDay(actor, { date, repId: repId ?? undefined, atRiskOnly }),
      listOwnersInScope(actor),
    ]);

    return (
      <TenantTzProvider tz={day.tz}>
        <DayBoard
          day={day}
          today={today}
          userId={userId}
          tenantId={tenant.id}
          ownersInScope={owners}
          repId={repId}
          atRiskOnly={atRiskOnly}
          focusId={focusId}
          pipelineLabel={formatCompactTenantCurrency(day.kpis.pipelineMinor, org)}
          canManageReporting={can(membership.role, 'manageMembers')}
          canWrite={membership.role !== 'viewer'}
        />
      </TenantTzProvider>
    );
  });
}
