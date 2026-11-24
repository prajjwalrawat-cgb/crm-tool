import 'server-only';

import { and, eq } from 'drizzle-orm';

import { deals, users } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { workspaceLogoDataUrl } from '@/lib/org-settings/logo';

import type { QuoteRenderInput } from './pdf/context';
import { buildPlaceholderValues } from './pdf/quote-document';
import { getQuote } from './queries';

/**
 * Everything the quote PDF is rendered from. The browser download and the
 * PDF filed on "mark as sent" both use this, so they come out identical.
 * Returns null when the quote does not exist in this tenant.
 */
export async function buildQuoteRenderInput(tenantId: string, quoteId: string): Promise<QuoteRenderInput | null> {
  const quote = await getQuote(tenantId, quoteId);
  if (!quote) return null;

  const dealId = quote.dealId;
  const { deal, creator } = await tenantTransaction(async (tx) => {
    const [d] = dealId
      ? await tx
          .select({ name: deals.name, customFields: deals.customFields })
          .from(deals)
          .where(and(eq(deals.tenantId, tenantId), eq(deals.id, dealId)))
          .limit(1)
      : [];
    const [u] = quote.createdBy
      ? await tx
          .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, quote.createdBy))
          .limit(1)
      : [];
    return { deal: d, creator: u };
  });

  const rep = creator
    ? {
        name: [creator.firstName, creator.lastName].filter(Boolean).join(' ').trim() || creator.email,
        email: creator.email,
      }
    : { name: '', email: '' };

  // 'org' and the older 'invoice' option both print the workspace logo
  // (Settings → Organization). Embedded as a data URL so the browser render
  // never fetches the storage URL (CORS) and matches the server render.
  const logoUrl = quote.templateSnapshot.theme.logoSource === 'none' ? null : await workspaceLogoDataUrl(tenantId);

  return {
    body: quote.templateSnapshot,
    quote,
    logoUrl,
    placeholderValues: { ...buildPlaceholderValues(quote, rep), 'deal.name': deal?.name ?? null },
    dealCustomFields: deal?.customFields ?? {},
  };
}
