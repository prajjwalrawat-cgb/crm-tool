'use client';

import { ArrowLeft, Link2, Loader2, Unlink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { setQuoteDealAction } from '@/lib/quotes/actions';
import type { QuoteDealOption } from '@/lib/quotes/queries';

import { Button } from '../../../settings/lead-capture/_components/ui';
import { DealPicker } from '../../_components/deal-picker';
import { QuoteModal } from '../../_components/new-quote-dialog';

const linkCls =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10';

/**
 * The quote's deal, above the title: a link to it, and on an editable draft
 * "Link to deal" / "Change" / "Unlink".
 */
export function QuoteDealLink({
  quoteId,
  deal,
  canChange,
  dirty,
  limitedToOwnDeals,
}: {
  quoteId: string;
  /** The linked deal, or null when the quote has none. */
  deal: { id: string; name: string } | null;
  /** Draft and manageQuotes. */
  canChange: boolean;
  /** Unsaved edits: linking refreshes the editor, so save first. */
  dirty: boolean;
  limitedToOwnDeals: boolean;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState<QuoteDealOption | null>(null);
  const [pending, startTransition] = useTransition();
  const saveFirst = dirty ? 'Save your changes first' : undefined;

  function apply(dealId: string | null, success: string) {
    startTransition(async () => {
      const res = await setQuoteDealAction(quoteId, dealId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success);
      setPicking(false);
      router.refresh();
    });
  }

  function unlink() {
    if (!deal) return;
    if (!window.confirm(`Unlink this quote from “${deal.name}”? The client details on the quote are kept.`)) return;
    apply(null, 'Quote unlinked from the deal');
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
      <Link href="/dashboard/quotes" className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-[#FAFAFA]">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Quotes
      </Link>
      <span aria-hidden>·</span>
      {deal ? (
        <>
          <span>
            Deal:{' '}
            <Link href={`/dashboard/deals/${deal.id}`} className="font-medium text-slate-800 hover:underline dark:text-[#E4E4E7]">
              {deal.name}
            </Link>
          </span>
          {canChange ? (
            <>
              <button type="button" className={linkCls} onClick={() => setPicking(true)} disabled={pending || dirty} title={saveFirst}>
                Change
              </button>
              <button type="button" className={linkCls} onClick={unlink} disabled={pending || dirty} title={saveFirst}>
                <Unlink className="h-3 w-3" aria-hidden /> Unlink
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          <span>Not linked to a deal</span>
          {canChange ? (
            <button type="button" className={linkCls} onClick={() => setPicking(true)} disabled={pending || dirty} title={saveFirst}>
              <Link2 className="h-3 w-3" aria-hidden /> Link to deal
            </button>
          ) : null}
        </>
      )}
      {pending && !picking ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}

      {picking ? (
        <QuoteModal
          title={deal ? 'Change deal' : 'Link to a deal'}
          description={
            deal
              ? 'Move this draft to another deal. The client details on the quote are kept.'
              : 'If the quote has no client yet, it takes the deal’s company and contact.'
          }
          onClose={() => setPicking(false)}
          busy={pending}
          footer={
            <>
              <Button onClick={() => setPicking(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => choice && apply(choice.id, `Linked to ${choice.name}`)}
                disabled={pending || !choice || choice.id === deal?.id}
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {deal ? 'Move to this deal' : 'Link deal'}
              </Button>
            </>
          }
        >
          <DealPicker
            selectedId={choice?.id ?? deal?.id ?? null}
            onSelect={setChoice}
            limitedToOwnDeals={limitedToOwnDeals}
            disabled={pending}
            autoFocus
          />
        </QuoteModal>
      ) : null}
    </div>
  );
}
