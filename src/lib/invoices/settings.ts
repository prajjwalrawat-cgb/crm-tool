import 'server-only';

import { getOrgSettings } from '@/lib/org-settings/queries';

/**
 * Workspace-level invoice settings (logo + default terms). Per-state seller +
 * bank details live in `invoice_seller_profiles` (see `seller-profiles.ts`).
 */
export type InvoiceSettings = {
  paymentTerms: string;
  deliveryTerms: string;
  logoUrl: string | null;
};

export async function getInvoiceSettings(
  tenantId: string,
): Promise<InvoiceSettings> {
  const s = await getOrgSettings(tenantId);
  return {
    paymentTerms: s.invoicePaymentTerms ?? '',
    deliveryTerms: s.invoiceDeliveryTerms ?? '',
    logoUrl: s.invoiceLogoUrl ?? null,
  };
}
