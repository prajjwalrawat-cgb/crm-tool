'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { getInvoiceForPdfAction } from '@/lib/invoices/actions';

export function DownloadPdfButton({
  id,
  variant = 'icon',
}: {
  id: string;
  variant?: 'icon' | 'button';
}) {
  const [loading, setLoading] = useState(false);

  async function handleDownload() {
    setLoading(true);
    try {
      const data = await getInvoiceForPdfAction(id);
      if (!data) {
        toast.error('Invoice not found.');
        return;
      }
      // Lazy-load jsPDF so it isn't bundled into the initial page chunk.
      const { generateInvoicePdf } = await import('@/lib/invoices/pdf');
      generateInvoicePdf(data);
    } catch {
      toast.error('Could not generate the PDF.');
    } finally {
      setLoading(false);
    }
  }

  if (variant === 'button') {
    return (
      <button
        type="button"
        onClick={handleDownload}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:bg-slate-800/40"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Download className="h-4 w-4" aria-hidden />
        )}
        Download PDF
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={loading}
      aria-label="Download PDF"
      title="Download PDF"
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60 dark:text-[#A1A1AA] dark:hover:bg-slate-800/60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Download className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
