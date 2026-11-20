import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { getQuoteSettings } from '@/lib/quotes/queries';

import { QuoteSettingsForm } from './_components/quote-settings-form';

export const metadata = { title: 'Quotes · Settings' };

export default async function QuoteSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [settings, org] = await Promise.all([getQuoteSettings(tenant.id), getOrgSettings(tenant.id)]);

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Quotes</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            How quote numbers are built and how long a new quote stays valid. Numbers are allocated when a quote is
            created and restart every fiscal year when the fiscal year is part of the number. Changing the format
            does not renumber existing quotes.
          </p>
        </header>
        <QuoteSettingsForm initial={settings} fiscalYearStartMonth={org.fiscalYearStartMonth ?? 1} />
      </main>
    );
  });
}
