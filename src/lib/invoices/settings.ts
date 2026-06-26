import 'server-only';

import type { InvoiceSeller } from '@/db/schema';
import { getOrgSettings } from '@/lib/org-settings/queries';

/**
 * Per-workspace invoice defaults (seller + bank details + default terms),
 * stored on the tenant's organization_settings row. Read on the new-invoice
 * form to auto-fill the seller block; written by the owner-only settings page.
 */
export type InvoiceSettings = {
  seller: InvoiceSeller;
  paymentTerms: string;
  deliveryTerms: string;
  logoUrl: string | null;
};

export async function getInvoiceSettings(
  tenantId: string,
): Promise<InvoiceSettings> {
  const s = await getOrgSettings(tenantId);
  return {
    seller: {
      name: s.invoiceSellerName ?? '',
      address: s.invoiceSellerAddress ?? undefined,
      gstin: s.invoiceGstin ?? undefined,
      pan: s.invoicePan ?? undefined,
      cin: s.invoiceCin ?? undefined,
      bankName: s.invoiceBankName ?? undefined,
      bankAccount: s.invoiceBankAccount ?? undefined,
      bankIfsc: s.invoiceBankIfsc ?? undefined,
      bankBranch: s.invoiceBankBranch ?? undefined,
    },
    paymentTerms: s.invoicePaymentTerms ?? '',
    deliveryTerms: s.invoiceDeliveryTerms ?? '',
    logoUrl: s.invoiceLogoUrl ?? null,
  };
}
