/**
 * The quote PDF: one react-pdf renderer per template section type. Used for
 * the builder preview (browser), the editor preview and the server render
 * filed on "mark as sent". Call registerQuoteFonts() before rendering.
 * Not a hook-using component, so it can be called as a plain function.
 */
import type { JSX } from 'react';
import { Document, Page, Text, View } from '@react-pdf/renderer';

import type { Placeholder, QuoteSection } from '../template-schema';
import type { QuoteDetail } from '../types';
import { ClassicQuoteDocument } from './classic-document';
import { formatDate, makeStyles, type QuoteRenderInput, type RenderContext } from './context';
import { ClientSectionPdf } from './sections/client';
import { CustomFieldsSectionPdf } from './sections/custom-fields';
import { HeaderSectionPdf } from './sections/header';
import { LineItemsSectionPdf } from './sections/line-items';
import { PageBreakSectionPdf } from './sections/page-break';
import { PaymentScheduleSectionPdf } from './sections/payment-schedule';
import { SignatureSectionPdf } from './sections/signature';
import { TermsSectionPdf } from './sections/terms';
import { TextSectionPdf } from './sections/text';
import { TotalsSectionPdf } from './sections/totals';

export type { QuoteRenderInput };

function SectionPdf({ section, ctx }: { section: QuoteSection; ctx: RenderContext }) {
  switch (section.type) {
    case 'header':
      return <HeaderSectionPdf section={section} ctx={ctx} />;
    case 'client':
      return <ClientSectionPdf section={section} ctx={ctx} />;
    case 'text':
      return <TextSectionPdf section={section} ctx={ctx} />;
    case 'line_items':
      return <LineItemsSectionPdf section={section} ctx={ctx} />;
    case 'totals':
      return <TotalsSectionPdf section={section} ctx={ctx} />;
    case 'payment_schedule':
      return <PaymentScheduleSectionPdf section={section} ctx={ctx} />;
    case 'terms':
      return <TermsSectionPdf section={section} ctx={ctx} />;
    case 'custom_fields':
      return <CustomFieldsSectionPdf section={section} ctx={ctx} />;
    case 'signature':
      return <SignatureSectionPdf section={section} ctx={ctx} />;
    case 'page_break':
      return <PageBreakSectionPdf />;
  }
}

export function QuoteDocument(props: QuoteRenderInput): JSX.Element {
  if (props.body.theme.layout === 'classic') return ClassicQuoteDocument(props);
  const { body, quote } = props;
  const ctx: RenderContext = { ...props, styles: makeStyles(body.theme) };
  const ref = quote.revision > 1 ? `${quote.quoteNumber} Rev ${quote.revision}` : quote.quoteNumber;
  return (
    <Document title={ref} author={quote.seller.name} subject={`Quotation for ${quote.buyer.name}`} creator="CRM" producer="CRM">
      <Page size={body.theme.pageSize} style={ctx.styles.page} wrap>
        {body.sections
          .filter((s) => s.enabled)
          .map((s) => (
            <SectionPdf key={s.id} section={s} ctx={ctx} />
          ))}
        <View style={ctx.styles.footer} fixed>
          <Text>{ref}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Values for text-block placeholders. `deal.name` is not on QuoteDetail; callers that know it add it. */
export function buildPlaceholderValues(quote: QuoteDetail, rep: { name: string; email: string }): Partial<Record<Placeholder, string | null>> {
  return {
    'client.name': quote.buyer.name,
    'client.contact': quote.buyer.contactName ?? null,
    'client.gstin': quote.buyer.gstin ?? null,
    'rep.name': rep.name,
    'rep.email': rep.email,
    'quote.number': quote.quoteNumber,
    'quote.date': formatDate(quote.quoteDate),
    'quote.valid_until': formatDate(quote.validUntil),
    'seller.name': quote.seller.name,
  };
}
