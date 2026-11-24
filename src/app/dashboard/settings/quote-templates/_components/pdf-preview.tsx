'use client';

/**
 * The template builder's preview: the template body rendered with sample
 * data. Browser-only: load it with next/dynamic { ssr: false }.
 */
import { useMemo } from 'react';

import QuotePdfPreview from '@/components/quotes/quote-pdf-preview';
import { sampleRenderInput } from '@/lib/quotes/pdf/sample-data';
import { quoteTemplateBodySchema } from '@/lib/quotes/template-schema';

function toInput(body: unknown, logoUrl: string | null) {
  const parsed = quoteTemplateBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const input = sampleRenderInput(parsed.data);
  return { ...input, logoUrl: parsed.data.theme.logoSource === 'none' ? null : logoUrl };
}

/** `logoUrl`: the workspace logo as a data URL (null when none is uploaded). */
export default function PdfPreview({ body, logoUrl }: { body: unknown; logoUrl: string | null }) {
  const input = useMemo(() => toInput(body, logoUrl), [body, logoUrl]);
  return (
    <QuotePdfPreview
      input={input}
      caption="sample data"
      invalidMessage="Invalid — not saved. Showing the last valid version."
    />
  );
}
