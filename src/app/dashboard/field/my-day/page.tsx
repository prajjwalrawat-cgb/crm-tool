import { withTenantSession } from '@/lib/auth-guard';
import { getDay } from '@/lib/field/day';
import type { FieldActor } from '@/lib/field/types';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { MyDayView } from '../_components/my-day-view';
import { isValidDate, safeTz, todayInTz } from '../_lib/datetime';
import { ownMeetingStart } from '../_lib/meeting-start';
import { listOwnersInScope } from '../_lib/owners';
import { TenantTzProvider } from '../_lib/tz-context';

export const metadata = {
  title: 'My day',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The rep's own meetings for one tenant-local day (default today). `?date=`
 * picks a day; `?m=<id>` (notification links) opens that meeting's day and
 * highlights its card. Open to every persona; viewers get a read-only list.
 */
export default async function MyDayPage({ searchParams }: { searchParams: SearchParams }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const actor: FieldActor = { tenantId: tenant.id, userId, role: membership.role };
    const sp = await searchParams;
    const org = await getOrgSettings(tenant.id);
    const tz = safeTz(org.timezone);
    const today = todayInTz(tz);
    const highlightId = first(sp.m) ?? null;

    let date = first(sp.date);
    if (!isValidDate(date)) {
      const start = highlightId ? await ownMeetingStart(actor, highlightId) : null;
      date = start ? todayInTz(tz, start) : today;
    }

    const [day, owners] = await Promise.all([getDay(actor, { date, repId: userId }), listOwnersInScope(actor)]);
    const meetings = day.reps.find((r) => r.userId === userId)?.meetings ?? [];

    return (
      <TenantTzProvider tz={day.tz}>
        <MyDayView
          date={day.date}
          today={today}
          meetings={meetings}
          userId={userId}
          ownersInScope={owners}
          canWrite={membership.role !== 'viewer'}
          highlightId={highlightId}
        />
      </TenantTzProvider>
    );
  });
}
