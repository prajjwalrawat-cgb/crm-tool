import { withTenantSession } from '@/lib/auth-guard';
import { listMutes } from '@/lib/reports/manager/digest';

import { DigestPrefs } from './_components/digest-prefs';

export const metadata = { title: 'Report digests · Settings' };

export default async function DigestSettingsPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const mutes = await listMutes(tenant.id, userId);
    return <DigestPrefs muted={mutes} />;
  });
}
