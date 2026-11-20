'use client';

/**
 * The template builder's preview: the template body rendered with sample
 * data. Browser-only: load it with next/dynamic { ssr: false }.
 */
import { useMemo } from 'react';

import QuotePdfPreview from '@/components/quotes/quote-pdf-preview';
import { sampleRenderInput } from '@/lib/quotes/pdf/sample-data';
import { quoteTemplateBodySchema } from '@/lib/quotes/template-schema';

function toInput(body: unknown) {
  const parsed = quoteTemplateBodySchema.safeParse(body);
  return parsed.success ? sampleRenderInput(parsed.data) : null;
}

export default function PdfPreview({ body }: { body: unknown }) {
  const input = useMemo(() => toInput(body), [body]);
  return (
    <QuotePdfPreview
      input={input}
      caption="sample data"
      invalidMessage="Invalid — not saved. Showing the last valid version."
    />
  );
}
