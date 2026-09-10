'use client';

import { Download, Loader2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { buildReportCsvAction } from '../actions';

/**
 * Client button that requests the CSV from the server action, then
 * triggers a browser download via a Blob URL. Kept in the client so
 * the page can stay a server component end-to-end.
 */
export function CsvDownloadButton({
  reportId,
  owner,
  scopeParams,
}: {
  reportId: string;
  owner: 'all' | 'mine';
  /**
   * Extra URL params the report's runner understands (today: the funnel's
   * offering / category scope). Forwarded so the file matches what is on
   * screen rather than silently exporting the unfiltered report.
   */
  scopeParams?: { offering?: string; category?: string };
}) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        start(async () => {
          const result = await buildReportCsvAction({
            reportId,
            filters: { owner, ...scopeParams },
          });
          if (!result.ok) {
            toast.error(result.message);
            return;
          }
          const blob = new Blob([result.csv], {
            type: 'text/csv;charset=utf-8',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = result.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-60"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Download className="h-3.5 w-3.5" aria-hidden />
      )}
      Download CSV
    </button>
  );
}
