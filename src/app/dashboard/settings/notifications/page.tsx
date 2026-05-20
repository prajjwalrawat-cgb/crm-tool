import { Bell } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { NotificationsForm } from './_components/notifications-form';

export const metadata = {
  title: 'Notifications · Settings',
};

export default async function NotificationsSettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    return (
      <NotificationsForm
        initial={{
          notifyAssignments: settings.notifyAssignments,
          notifyRecommendations: settings.notifyRecommendations,
          notifyWorkflows: settings.notifyWorkflows,
          notifyEmailEvents: settings.notifyEmailEvents,
          realtimeEnabled: settings.realtimeEnabled,
        }}
      />
    );
  });
}
