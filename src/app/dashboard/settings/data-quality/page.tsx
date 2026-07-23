import { withTenantSession } from '@/lib/auth-guard';
import {
  findCompanyDuplicatePairs,
  findContactDuplicatePairs,
} from '@/lib/dedup/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { getWorkspaceSettings } from '@/lib/workspace-settings/queries';

import { DataQualityManager } from './_components/data-quality-manager';

export const metadata = { title: 'Data Quality · Settings' };

export default async function DataQualitySettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [settings, companyPairs, contactPairs] = await Promise.all([
      getWorkspaceSettings(tenant.id),
      findCompanyDuplicatePairs(tenant.id),
      findContactDuplicatePairs(tenant.id),
    ]);

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Data quality
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Candidate duplicate companies and contacts, ranked by similarity.
            Pick a survivor to merge — every child record (deals, activities,
            emails, tasks) is repointed and the merge is recorded for reversal.
          </p>
        </header>
        <DataQualityManager
          enabled={settings.dedupEnabled}
          companyPairs={companyPairs}
          contactPairs={contactPairs}
        />
      </main>
    );
  });
}
