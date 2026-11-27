import { withTenantSession } from '@/lib/auth-guard';
import { requirePersonas } from '@/lib/personas/guards';
import { getProspectSettings } from '@/lib/prospects/settings';

import { ProspectSettingsForm } from './_components/prospect-settings-form';
import { ProspectSourcesForm } from './_components/prospect-sources-form';

export const metadata = { title: 'Prospect board · Settings' };

/** Admin: source list, claim window, auto-park and enrichment for the Prospect Board. */
export default async function ProspectSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getProspectSettings(tenant.id);
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-[#FAFAFA]">Prospect board</h1>
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            The Source list, how long a claim lasts, when idle prospects are parked, and whether AI enrichment runs.
          </p>
        </header>
        <ProspectSourcesForm initial={settings.sources} />
        <ProspectSettingsForm initial={settings} />
      </div>
    );
  });
}
