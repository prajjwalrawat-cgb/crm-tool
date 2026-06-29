import { redirect } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { listSellerProfiles } from '@/lib/invoices/seller-profiles';
import { getInvoiceSettings } from '@/lib/invoices/settings';
import { isOwner, requireMembership } from '@/lib/membership';

import { InvoiceSettingsForm } from './_components/invoice-settings-form';

export const metadata = { title: 'Invoice settings' };

export default async function InvoiceSettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    // Owner-only.
    const membership = await requireMembership();
    if (!isOwner(membership)) redirect('/dashboard');

    const [settings, profiles] = await Promise.all([
      getInvoiceSettings(tenant.id),
      listSellerProfiles(tenant.id),
    ]);

    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Invoice settings
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Seller &amp; bank details for {tenant.name}, per state. Add a profile
            for each GST registration (e.g. Delhi, Karnataka). Members pick the
            state when creating a PI and the seller block auto-fills.
          </p>
        </header>

        <InvoiceSettingsForm
          logoUrl={settings.logoUrl ?? ''}
          paymentTerms={settings.paymentTerms}
          deliveryTerms={settings.deliveryTerms}
          profiles={profiles}
        />
      </main>
    );
  });
}
