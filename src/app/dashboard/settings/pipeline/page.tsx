import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { PipelineForm } from './_components/pipeline-form';

export const metadata = {
  title: 'Pipeline · Settings',
};

export default async function PipelineSettingsPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    return (
      <PipelineForm
        initial={{
          defaultDealStage: settings.defaultDealStage as
            | 'lead'
            | 'qualified'
            | 'proposal'
            | 'negotiation'
            | 'won'
            | 'lost',
          defaultReportRange: settings.defaultReportRange,
          dashboardMetrics: settings.dashboardMetrics,
          fiscalYearStartMonth: settings.fiscalYearStartMonth,
          dealUnitPricingEnabled: settings.dealUnitPricingEnabled,
        }}
      />
    );
  });
}
