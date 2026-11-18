'use client';

import { ErrorBox } from './_components/ui';

export default function InsightsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-3">
      <ErrorBox message={`This report could not be loaded. ${error.digest ? `(ref ${error.digest})` : ''}`} />
      <button type="button" onClick={reset} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50">
        Try again
      </button>
    </div>
  );
}
