import { withTenantSession } from '@/lib/auth-guard';
import { getCollectionSettings } from '@/lib/collections/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { CreditTermsForm } from './_components/credit-terms-form';

export const metadata = { title: 'Credit terms · Settings' };

export default async function CreditTermsSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const s = await getCollectionSettings(tenant.id);
    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Credit terms</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            The workspace’s standard credit period, used by the Collections report and by deal credit terms.
            {s.saved ? '' : ' Not saved yet — showing defaults.'}
          </p>
        </header>
        <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0F0F0F]">
          <CreditTermsForm standard={s.standardCreditDays} excess={s.materialExcessDays} />
        </section>
      </main>
    );
  });
}
