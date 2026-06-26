/**
 * Serializable shapes passed from the server action to the client PDF
 * generator. Kept free of `server-only` and DB imports so a Client
 * Component can import these types without pulling the schema bundle.
 */

export type PdfParty = {
  name: string;
  address?: string;
  city?: string;
  locality?: string;
  pincode?: string;
  gstin?: string;
  state?: string;
  stateCode?: string;
};

export type PdfSeller = PdfParty & {
  pan?: string;
  cin?: string;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankBranch?: string;
};

export type PdfItem = {
  description: string;
  hsnSac?: string | null;
  unit: string;
  quantity: number;
  rateMinor: number;
  amountMinor: number;
  imageUrl?: string | null;
};

export type InvoicePdfData = {
  id: string;
  createdBy: string | null;
  piNumber: string;
  piDate: string;
  currency: string;
  status: string;
  /**
   * Workspace logo as a base64 data URL, shown top-left on the PDF. Fetched
   * server-side (avoids browser CORS on the storage URL) so the client PDF
   * can embed it directly. Live from the workspace's invoice settings.
   */
  logoDataUrl?: string | null;
  seller: PdfSeller;
  buyer: PdfParty;
  consignee: PdfParty | null;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  notes: string | null;
  taxRate: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  items: PdfItem[];
};
