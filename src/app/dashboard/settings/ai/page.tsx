import { getAIMode } from '@/lib/ai/config';
import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { AiForm } from './_components/ai-form';

export const metadata = {
  title: 'AI · Settings',
};

export default async function AiSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    const aiMode = getAIMode();
    return (
      <AiForm
        aiMode={aiMode}
        initial={{
          aiEnabled: settings.aiEnabled,
          aiAggressiveness: settings.aiAggressiveness as
            | 'conservative'
            | 'balanced'
            | 'aggressive',
          insightRefresh: settings.insightRefresh as
            | 'on_change'
            | 'hourly'
            | 'daily'
            | 'manual',
        }}
      />
    );
  });
}
