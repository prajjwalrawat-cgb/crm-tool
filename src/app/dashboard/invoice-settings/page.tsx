import { redirect } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { getInvoiceSettings } from '@/lib/invoices/settings';
import { isOwner, requireMembership } from '@/lib/membership';

import { InvoiceSettingsForm } from './_components/invoice-settings-form';

export const metadata = { title: 'Invoice settings' };

export default async function InvoiceSettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    // Owner-only.
    const membership = await requireMembership();
    if (!isOwner(membership)) redirect('/dashboard');

    const s = await getInvoiceSettings(tenant.id);

    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Invoice settings
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Seller &amp; bank details for {tenant.name}. These auto-fill on every
            new proforma invoice in this workspace.
          </p>
        </header>

        <InvoiceSettingsForm
          initial={{
            logoUrl: s.logoUrl ?? '',
            sellerName: s.seller.name,
            sellerAddress: s.seller.address ?? '',
            gstin: s.seller.gstin ?? '',
            pan: s.seller.pan ?? '',
            cin: s.seller.cin ?? '',
            bankName: s.seller.bankName ?? '',
            bankAccount: s.seller.bankAccount ?? '',
            bankIfsc: s.seller.bankIfsc ?? '',
            bankBranch: s.seller.bankBranch ?? '',
            paymentTerms: s.paymentTerms,
            deliveryTerms: s.deliveryTerms,
          }}
        />
      </main>
    );
  });
}
