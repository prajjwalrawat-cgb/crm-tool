'use client';

/**
 * Debounced live quote PDF preview. Browser-only (react-pdf): load it with
 * next/dynamic { ssr: false }. Re-renders 400 ms after `input` last changed;
 * while `input` is null (invalid) the last valid render stays up with a notice.
 * Pass a memoised `input`: a new object on every render restarts the timer.
 */
import { usePDF, type DocumentProps } from '@react-pdf/renderer';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';

import { registerQuoteFonts } from '@/lib/quotes/pdf/fonts';
import { QuoteDocument, type QuoteRenderInput } from '@/lib/quotes/pdf/quote-document';

registerQuoteFonts('browser');

const DEBOUNCE_MS = 400;

export default function QuotePdfPreview({
  input,
  caption,
  invalidMessage,
}: {
  input: QuoteRenderInput | null;
  /** Shown next to "Preview", e.g. "sample data". */
  caption?: string;
  invalidMessage: string;
}) {
  const [instance, update] = usePDF();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setInvalid(input === null);
      if (input) update(QuoteDocument(input) as ReactElement<DocumentProps>);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, update]);

  // usePDF revokes the previous object URL itself.
  const url = instance.url;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-[#262626] dark:bg-[#0A0A0A]">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5 text-[12px] dark:border-[#262626] dark:bg-[#0F0F0F]">
        <span className="font-medium text-slate-700 dark:text-[#D4D4D8]">Preview</span>
        {caption ? <span className="text-slate-400">{caption}</span> : null}
        {instance.loading ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-slate-400" aria-label="Rendering" /> : null}
      </div>
      {invalid ? (
        <div role="status" className="flex items-center gap-1.5 bg-amber-50 px-3 py-1.5 text-[12px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          {invalidMessage}
        </div>
      ) : null}
      {instance.error ? (
        <div role="alert" className="bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          The preview could not be rendered: {String(instance.error)}
        </div>
      ) : null}
      {url ? (
        <iframe title="Quote PDF preview" src={`${url}#toolbar=0&navpanes=0`} className="min-h-0 w-full flex-1 bg-white" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> Rendering preview…
        </div>
      )}
    </div>
  );
}
