import { withTenantSession } from '@/lib/auth-guard';
import { workspaceLogoUrl } from '@/lib/org-settings/logo';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { OrganizationForm } from './_components/organization-form';
import { OrganizationLogo } from './_components/organization-logo';

export const metadata = {
  title: 'Organization · Settings',
};

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

export default async function OrganizationSettingsPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    return (
      <div className="space-y-8">
      <OrganizationForm
        tenantName={tenant.name}
        timezones={COMMON_TIMEZONES}
        initial={{
          displayName: settings.displayName ?? '',
          locale: settings.locale,
          timezone: settings.timezone,
        }}
      />
      <OrganizationLogo initialUrl={workspaceLogoUrl(settings)} />
      </div>
    );
  });
}
