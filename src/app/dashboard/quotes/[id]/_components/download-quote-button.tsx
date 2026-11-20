'use client';

import { Download, Loader2 } from 'lucide-react';
import type { DocumentProps } from '@react-pdf/renderer';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { getQuoteForPdfAction } from '@/lib/quotes/actions';

import { Button } from '../../../settings/lead-capture/_components/ui';

/** "Q/2026-27/0001", 2 -> "Q-2026-27-0001 Rev 2.pdf" (the filed PDF's name, made path-safe). */
function downloadName(quoteNumber: string, revision: number): string {
  return `${quoteNumber.replace(/[\\/:*?"<>|]+/g, '-')} Rev ${revision}.pdf`;
}

/**
 * Download the quote PDF. A sent quote links to the PDF filed on the deal;
 * otherwise the PDF is rendered in the browser from exactly the render input
 * the server files on send (getQuoteForPdfAction), so the two match.
 */
export function DownloadQuoteButton({
  quoteId,
  fileUrl,
  disabledReason,
}: {
  quoteId: string;
  /** The filed PDF (sent / superseded quotes). */
  fileUrl: string | null;
  /** Set to disable the button, e.g. while there are unsaved changes. */
  disabledReason?: string;
}) {
  const [loading, setLoading] = useState(false);

  if (fileUrl) {
    return (
      <a
        href={fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7] dark:hover:bg-[#181818]"
      >
        <Download className="h-3.5 w-3.5" aria-hidden /> Download PDF
      </a>
    );
  }

  async function download() {
    setLoading(true);
    try {
      const res = await getQuoteForPdfAction(quoteId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Loaded on demand: react-pdf is browser-heavy and only needed here.
      const [{ pdf }, { QuoteDocument }, { registerQuoteFonts }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('@/lib/quotes/pdf/quote-document'),
        import('@/lib/quotes/pdf/fonts'),
      ]);
      registerQuoteFonts('browser');
      const blob = await pdf(QuoteDocument(res.input) as ReactElement<DocumentProps>).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName(res.input.quote.quoteNumber, res.input.quote.revision);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error('Could not generate the PDF.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={download} disabled={loading || Boolean(disabledReason)} title={disabledReason}>
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
      Download PDF
    </Button>
  );
}
