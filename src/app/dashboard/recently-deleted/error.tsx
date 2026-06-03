'use client';

import { useEffect } from 'react';

export default function RecentlyDeletedErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[recently-deleted] route error:', error);
  }, [error]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <h2 className="text-lg font-semibold text-red-900">
          Failed to load deleted records.
        </h2>
        <p className="mt-2 text-sm text-red-800">
          We hit an unexpected error. Try again — if it keeps happening,
          share the reference below with support.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
        >
          Try again
        </button>
        {error.digest ? (
          <p className="mt-3 font-mono text-[10.5px] text-red-700/80">
            ref: {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
