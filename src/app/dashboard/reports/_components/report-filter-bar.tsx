'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { cn } from '@/lib/utils';

/**
 * URL-synced filter bar for report detail pages. Two filters only at
 * v1: owner scope and visual mode (count vs amount). Each filter is a
 * pill group — server picks them up from `searchParams` on the next
 * render. No client-state caching; URL is the source of truth so a
 * shareable link reproduces what the sender sees.
 */
export function ReportFilterBar({
  reportId,
  currentOwner,
  currentMode,
  supportsOwnerScope,
  supportsMode,
}: {
  reportId: string;
  currentOwner: 'all' | 'mine';
  currentMode: 'count' | 'amount';
  supportsOwnerScope: boolean;
  supportsMode: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set(key, value);
    start(() => {
      router.replace(`/dashboard/reports/${reportId}?${next.toString()}`);
    });
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        pending && 'opacity-70',
      )}
    >
      {supportsOwnerScope ? (
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white text-[12px]">
          {(['all', 'mine'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setParam('owner', v)}
              className={cn(
                'px-3 py-1 transition',
                currentOwner === v
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-700 hover:bg-slate-50',
              )}
            >
              {v === 'all' ? 'All deals' : 'My deals'}
            </button>
          ))}
        </div>
      ) : null}

      {supportsMode ? (
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white text-[12px]">
          {(['amount', 'count'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setParam('mode', v)}
              className={cn(
                'px-3 py-1 transition',
                currentMode === v
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-700 hover:bg-slate-50',
              )}
            >
              {v === 'amount' ? 'By value' : 'By count'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
