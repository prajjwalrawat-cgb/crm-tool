'use client';

import { FilePlus2, Loader2, RefreshCw, Send, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { formatCurrency } from '@/lib/deals/currency';
import {
  createQuoteRevisionAction,
  markQuoteSentAction,
  reapplyTemplateAction,
  setDealAmountFromQuoteAction,
} from '@/lib/quotes/actions';
import { formatInr } from '@/lib/quotes/editor-form';
import type { QuoteStatus } from '@/lib/quotes/types';

import { Button } from '../../../settings/lead-capture/_components/ui';
import { DownloadQuoteButton } from './download-quote-button';

export type ActionsBarDeal = { amountMinor: number; currency: string };

export function QuoteActionsBar({
  quoteId,
  status,
  revision,
  canManage,
  canSetDealValue,
  dirty,
  saving,
  onSave,
  templateChanged,
  fileUrl,
  deal,
  dealValueMinor,
}: {
  quoteId: string;
  status: QuoteStatus;
  revision: number;
  /** manageQuotes: false for viewers (download only). */
  canManage: boolean;
  /** manageQuotes AND manageDeals. */
  canSetDealValue: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  /** The quote's template changed since this quote's snapshot. */
  templateChanged: boolean;
  /** The PDF filed on send. */
  fileUrl: string | null;
  deal: ActionsBarDeal | null;
  /** The value "Set deal value" writes: the saved quote's taxable value (subtotal − discount). */
  dealValueMinor: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = pending || saving;

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success);
      if (after) after();
      else router.refresh();
    });
  }

  function markSent() {
    if (!window.confirm(`This locks Rev ${revision} and files the PDF on the deal.`)) return;
    run(() => markQuoteSentAction(quoteId), 'Quote marked as sent. The PDF is filed on the deal.');
  }

  function reapply() {
    if (!window.confirm('Re-apply the latest version of the template? Your line items and edited text are kept where the sections still exist.')) return;
    run(() => reapplyTemplateAction(quoteId), 'Template re-applied');
  }

  function newRevision() {
    startTransition(async () => {
      const res = await createQuoteRevisionAction(quoteId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Rev ${revision + 1} created as a draft`);
      router.push(`/dashboard/quotes/${res.id}`);
    });
  }

  function setDealValue() {
    const from = deal ? formatCurrency(deal.amountMinor, deal.currency) : '—';
    const to = formatInr(dealValueMinor);
    if (!window.confirm(`Set the deal value from ${from} to ${to} (the quote value before GST)?`)) return;
    run(() => setDealAmountFromQuoteAction(quoteId), `Deal value set to ${to}`);
  }

  const spinner = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'draft' && canManage ? (
        <>
          {templateChanged ? (
            <Button onClick={reapply} disabled={busy || dirty} title={dirty ? 'Save your changes first' : undefined}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Re-apply template
            </Button>
          ) : null}
          <DownloadQuoteButton quoteId={quoteId} fileUrl={null} disabledReason={dirty ? 'Save your changes first' : undefined} />
          <Button onClick={markSent} disabled={busy || dirty} title={dirty ? 'Save your changes first' : undefined}>
            <Send className="h-3.5 w-3.5" aria-hidden /> Mark as sent
          </Button>
          <Button variant="primary" onClick={onSave} disabled={busy || !dirty}>
            {saving ? spinner : null}
            Save
          </Button>
        </>
      ) : (
        <>
          <DownloadQuoteButton quoteId={quoteId} fileUrl={fileUrl} />
          {status === 'sent' && canManage ? (
            <Button onClick={newRevision} disabled={busy}>
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden /> New revision
            </Button>
          ) : null}
          {status === 'sent' && canSetDealValue && deal ? (
            <Button onClick={setDealValue} disabled={busy}>
              <Wallet className="h-3.5 w-3.5" aria-hidden /> Set deal value from this quote
            </Button>
          ) : null}
          {pending ? spinner : null}
        </>
      )}
    </div>
  );
}
