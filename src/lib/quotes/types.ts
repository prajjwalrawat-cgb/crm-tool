/**
 * Shapes returned by the quote data layer (queries.ts). Type-only: safe to
 * import from client components.
 */
import type { QuoteStatus } from '@/db/schema/enums';
import type { QuoteItemRow, QuoteRow, quoteTemplates } from '@/db/schema/quotes';
import type { PdfParty, PdfSeller } from '@/lib/invoices/types';

import type { QuoteLineTotals, QuoteTotals } from './totals';
import type { QuoteContent, QuoteTemplateBody } from './template-schema';

export type { QuoteStatus };

/** PdfParty plus the buyer's contact, prefilled from the deal's contact. */
export type QuoteParty = PdfParty & { contactName?: string; contactEmail?: string };

export type QuoteTemplateRow = Omit<typeof quoteTemplates.$inferSelect, 'body'> & {
  body: QuoteTemplateBody;
};

export type QuoteSettings = {
  numberPrefix: string;
  numberSeparator: string;
  numberIncludeFy: boolean;
  numberPadding: number;
  defaultValidityDays: number;
};

export type QuoteDetailItem = QuoteItemRow & { totals: QuoteLineTotals };

export type QuoteDetail = Omit<QuoteRow, 'templateSnapshot' | 'content' | 'seller' | 'buyer' | 'consignee'> & {
  templateSnapshot: QuoteTemplateBody;
  content: QuoteContent;
  seller: PdfSeller;
  buyer: QuoteParty;
  consignee: QuoteParty | null;
  items: QuoteDetailItem[];
  totals: QuoteTotals;
};

export type QuoteListItem = {
  id: string;
  quoteNumber: string;
  revision: number;
  status: QuoteStatus;
  dealId: string;
  dealName: string;
  companyName: string | null;
  totalMinor: number;
  createdBy: string | null;
  createdAt: Date;
  sentAt: Date | null;
};
