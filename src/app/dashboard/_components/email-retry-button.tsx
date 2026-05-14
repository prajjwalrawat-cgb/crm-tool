'use client';

import { Loader2, RotateCw } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { retryEmailAction } from '../email/actions';

/**
 * Tiny inline retry control for failed emails surfaced in the entity
 * timeline. Hides itself when the retry budget is exhausted — the
 * server still re-checks that invariant, this is just to avoid a
 * useless control. Optimistic UX is intentionally simple: toast on
 * outcome, let the page revalidation refresh the row's status.
 */
export function EmailRetryButton({
  emailId,
  retryCount,
  maxAttempts = 3,
}: {
  emailId: string;
  retryCount: number;
  maxAttempts?: number;
}) {
  const [pending, start] = useTransition();
  if (retryCount >= maxAttempts) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        start(async () => {
          const result = await retryEmailAction({ emailId });
          if (result.ok) {
            toast.success('Email re-sent');
          } else {
            toast.error(result.message);
          }
        });
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-800 transition',
        'hover:border-amber-400 hover:bg-amber-100',
        pending && 'cursor-wait opacity-70',
      )}
      title={`Retry (${retryCount}/${maxAttempts} attempts used)`}
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <RotateCw className="h-3 w-3" aria-hidden />
      )}
      Retry
    </button>
  );
}
