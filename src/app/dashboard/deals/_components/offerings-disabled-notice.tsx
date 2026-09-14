import { Info } from 'lucide-react';
import Link from 'next/link';

import type { DealOfferingTag } from '@/lib/offerings/types';
import { cn } from '@/lib/utils';

/**
 * Shown in place of the Offerings field/card when the workspace has Offerings
 * switched OFF (0067) but THIS deal was tagged before the switch.
 *
 * Informational, never blocking. Saving the deal still works and leaves its
 * tags exactly as they are (the update action skips the tag sync while the
 * switch is off). An error here would be wrong twice over: nothing failed,
 * and blocking the save would recreate the bug the skip exists to prevent.
 *
 * Why say anything at all, when OFF otherwise means invisible: for a deal
 * that HAS tags, silence is misleading. A rep could reasonably conclude the
 * deal has no offerings, or that saving removed them — and the tags will
 * reappear the moment an admin switches the feature back on. Untagged deals
 * render nothing, because there is nothing to explain.
 *
 * No client hooks, so it renders from the server deal page and inside the
 * client edit drawer alike.
 */
export function OfferingsDisabledNotice({
  tags,
  canTurnOn,
  compact = false,
}: {
  tags: readonly DealOfferingTag[];
  /** Owner/admin (`manageOfferings`): gets a link to the switch, not "ask an admin". */
  canTurnOn: boolean;
  /** Tighter padding for the deal page sidebar. */
  compact?: boolean;
}) {
  if (tags.length === 0) return null;

  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 text-slate-600 dark:border-[#262626] dark:bg-[#111111] dark:text-[#A1A1AA]',
        compact ? 'px-2.5 py-2 text-[11.5px]' : 'px-3 py-2.5 text-xs',
      )}
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium text-slate-700 dark:text-[#D4D4D8]">
          Offerings are turned off for this workspace
        </p>
        <p>
          This deal is tagged with{' '}
          {tags.map((t, i) => (
            <span key={t.id}>
              {i > 0 ? ', ' : null}
              <span className="font-medium text-slate-700 dark:text-[#D4D4D8]">
                {t.name}
              </span>
            </span>
          ))}
          . {tags.length === 1 ? 'It is' : 'They are'} hidden and can&apos;t be
          changed while offerings are off. Saving this deal keeps{' '}
          {tags.length === 1 ? 'it' : 'them'} as {tags.length === 1 ? 'it is' : 'they are'}.
        </p>
        {canTurnOn ? (
          <p>
            <Link
              href="/dashboard/settings/offerings"
              className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
            >
              Turn offerings on in Settings
            </Link>{' '}
            to edit them.
          </p>
        ) : (
          <p>Ask an admin to turn offerings back on to edit them.</p>
        )}
      </div>
    </div>
  );
}
