'use client';

import { AlertTriangle, Loader2, LocateFixed } from 'lucide-react';

import { Button } from '../../settings/lead-capture/_components/ui';
import type { PositionState } from '../_lib/use-position';

/**
 * Inline status for a location read: locating, low accuracy (Retry / Continue)
 * or an error (Retry). Renders nothing while idle.
 */
export function PositionPrompt({
  state,
  onRetry,
  onContinue,
}: {
  state: PositionState;
  onRetry: () => void;
  onContinue: () => void;
}) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'locating') {
    return (
      <p role="status" className="flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-[#A1A1AA]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Getting your location…
      </p>
    );
  }
  const low = state.kind === 'low';
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {low
            ? `GPS accuracy is low (±${state.pos.accuracyM} m) — move outdoors or retry`
            : state.message}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onRetry} className="min-h-10 px-4">
          <LocateFixed className="h-3.5 w-3.5" aria-hidden /> Retry
        </Button>
        {low ? (
          <Button variant="primary" onClick={onContinue} className="min-h-10 px-4">
            Continue
          </Button>
        ) : null}
      </div>
    </div>
  );
}
