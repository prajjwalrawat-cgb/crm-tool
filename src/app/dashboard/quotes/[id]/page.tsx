import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { listDealDocuments } from '@/lib/deals/documents';
import { getDealById } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { isOfferingsEnabled, listOfferingOptions } from '@/lib/offerings/queries';
import { templateBodiesEqual } from '@/lib/quotes/editor-form';
import { getQuoteTemplate, listQuoteTemplates, listQuotesForDeal } from '@/lib/quotes/queries';
import { buildQuoteRenderInput } from '@/lib/quotes/render-input';
import type { QuoteDetail } from '@/lib/quotes/types';
import { can } from '@/lib/rbac';

import { QuoteEditor } from './_components/quote-editor';

export const metadata = { title: 'Quote' };

/**
 * Whether "Re-apply template" would change anything: the template it would
 * use (the quote's own while active, else the default — as reapplyTemplate
 * resolves it) differs from the quote's snapshot.
 */
async function templateChangedSince(tenantId: string, quote: QuoteDetail): Promise<boolean> {
  const own = quote.templateId ? await getQuoteTemplate(tenantId, quote.templateId) : null;
  const current =
    own && !own.archivedAt ? own : ((await listQuoteTemplates(tenantId)).find((t) => t.isDefault) ?? null);
  return current !== null && !templateBodiesEqual(current.body, quote.templateSnapshot);
}

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return await withTenantSession(async ({ tenant }) => {
    const [membership, renderInput] = await Promise.all([requireMembership(), buildQuoteRenderInput(tenant.id, id)]);
    if (!renderInput) notFound();
    const quote = renderInput.quote;

    const canManage = can(membership.role, 'manageQuotes');
    const canSetDealValue = canManage && can(membership.role, 'manageDeals');
    const isDraft = quote.status === 'draft';

    const [deal, siblings, documents, templateChanged, offeringsEnabled, offerings] = await Promise.all([
      getDealById(tenant.id, quote.dealId),
      quote.status === 'superseded' ? listQuotesForDeal(tenant.id, quote.dealId) : Promise.resolve([]),
      quote.pdfDocumentId ? listDealDocuments(tenant.id, quote.dealId) : Promise.resolve([]),
      isDraft && canManage ? templateChangedSince(tenant.id, quote) : Promise.resolve(false),
      isOfferingsEnabled(tenant.id),
      // Retired offerings included so rows that carry one still show it.
      listOfferingOptions(tenant.id, { activeOnly: false }),
    ]);

    // The revision that replaced this one: the latest of the same number.
    const newer = siblings
      .filter((s) => s.quoteNumber === quote.quoteNumber && s.revision > quote.revision)
      .sort((a, b) => b.revision - a.revision)[0];
    const fileUrl = documents.find((d) => d.id === quote.pdfDocumentId)?.fileUrl ?? null;

    return (
      <QuoteEditor
        // A fresh editor after every server change (save, re-apply, send).
        key={quote.updatedAt.toISOString()}
        renderInput={renderInput}
        canManage={canManage}
        canSetDealValue={canSetDealValue}
        templateChanged={templateChanged}
        fileUrl={fileUrl}
        deal={deal ? { id: deal.id, name: deal.name, amountMinor: deal.amountMinor, currency: deal.currency } : null}
        newerRevision={newer ? { id: newer.id, revision: newer.revision } : null}
        offerings={
          offeringsEnabled ? offerings.map((o) => ({ id: o.id, name: o.name, active: o.active })) : []
        }
      />
    );
  });
}
