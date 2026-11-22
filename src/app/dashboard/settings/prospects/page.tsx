import { withTenantSession } from '@/lib/auth-guard';
import { requirePersonas } from '@/lib/personas/guards';
import { getProspectSettings } from '@/lib/prospects/settings';

import { ProspectSettingsForm } from './_components/prospect-settings-form';

export const metadata = { title: 'Prospect board · Settings' };

/** Admin: claim window, auto-park and enrichment for the Prospect Board. */
export default async function ProspectSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getProspectSettings(tenant.id);
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-[#FAFAFA]">Prospect board</h1>
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            How long a claim lasts, when idle prospects are parked, and whether AI enrichment runs.
          </p>
        </header>
        <ProspectSettingsForm initial={settings} />
      </div>
    );
  });
}
