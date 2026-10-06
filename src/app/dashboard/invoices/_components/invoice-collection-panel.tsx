'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  addInvoicePaymentAction,
  deleteInvoicePaymentAction,
  getInvoiceCollectionAction,
  listInvoiceDealOptionsAction,
  setInvoiceDealAction,
  type InvoiceCollectionPayload,
} from '@/app/dashboard/collections/actions';
import type { DealOption } from '@/lib/collections/queries';
import { formatMoneyMinor } from '@/lib/invoices/money';
import { cn } from '@/lib/utils';

import { InvoiceStatusBadge } from './invoice-status-badge';

const input =
  'w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]';

/**
 * Collection for one proforma invoice: which deal it bills (so which rep),
 * its credit period and due date, and the payments received against it.
 * Partial payments are separate rows; "paid" is when they reach the total.
 */
export function InvoiceCollectionPanel({ invoiceId, onChanged }: { invoiceId: string; onChanged?: () => void }) {
  const [view, setView] = useState<InvoiceCollectionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [editingLink, setEditingLink] = useState(false);
  const [dealOptions, setDealOptions] = useState<DealOption[] | null>(null);
  const [dealId, setDealId] = useState<string>('');
  const [creditDays, setCreditDays] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');

  const apply = useCallback((res: Awaited<ReturnType<typeof getInvoiceCollectionAction>>) => {
    if (res.ok) {
      setView(res.value);
      setDealId(res.value.dealId ?? '');
      setCreditDays(res.value.creditDaysOverride != null ? String(res.value.creditDaysOverride) : '');
      setError(null);
    } else {
      setError(res.message);
    }
  }, []);

  /** Re-read after a change (called from event handlers, not the effect). */
  const load = useCallback(async () => apply(await getInvoiceCollectionAction(invoiceId)), [apply, invoiceId]);

  useEffect(() => {
    let active = true;
    void getInvoiceCollectionAction(invoiceId).then((res) => {
      if (active) apply(res);
    });
    return () => {
      active = false;
    };
  }, [apply, invoiceId]);

  function startEditLink() {
    setEditingLink(true);
    if (!dealOptions) {
      void listInvoiceDealOptionsAction().then((r) => setDealOptions(r.ok ? r.value : []));
    }
  }

  function after(res: { ok: true } | { ok: false; message: string }, msg: string) {
    if (res.ok) {
      toast.success(msg);
      void load();
      onChanged?.();
    } else {
      toast.error(res.message);
    }
  }

  function saveLink() {
    start(async () => {
      const res = await setInvoiceDealAction({
        invoiceId,
        dealId: dealId || null,
        creditDays: creditDays.trim() === '' ? null : creditDays,
      });
      after(res, 'Collection details saved');
      if (res.ok) setEditingLink(false);
    });
  }

  function addPayment() {
    start(async () => {
      const res = await addInvoicePaymentAction({ invoiceId, amount, paidOn, reference: reference || null });
      after(res, 'Payment recorded');
      if (res.ok) {
        setAmount('');
        setReference('');
      }
    });
  }

  function removePayment(paymentId: string) {
    if (!window.confirm('Remove this payment?')) return;
    start(async () => after(await deleteInvoicePaymentAction({ paymentId }), 'Payment removed'));
  }

  if (error) return <p className="text-[12px] text-slate-500">{error}</p>;
  if (!view) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden />
      </div>
    );
  }

  const cur = view.currency;
  const st = view.status;
  const creditSource =
    st.creditDaysSource === 'invoice'
      ? 'set on this invoice'
      : st.creditDaysSource === 'deal'
        ? 'from the deal’s agreed terms'
        : `workspace standard${view.dealId ? ' (no terms on the deal)' : ''}`;

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-[#1F1F1F]">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Collection</h3>
        <InvoiceStatusBadge status={st} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-slate-500">Deal</dt>
        <dd className="text-slate-800 dark:text-[#FAFAFA]">
          {view.dealName ?? <span className="text-amber-700">Not linked — not attributed to any rep</span>}
        </dd>
        <dt className="text-slate-500">Credit period</dt>
        <dd className="text-slate-800 dark:text-[#FAFAFA]">
          {st.creditDays} days <span className="text-slate-400">({creditSource})</span>
        </dd>
        <dt className="text-slate-500">Due</dt>
        <dd className={cn('text-slate-800 dark:text-[#FAFAFA]', st.overdue && 'font-semibold text-rose-600')}>
          {st.dueDate}
          {st.overdue ? ' · overdue' : ''}
        </dd>
        <dt className="text-slate-500">Received</dt>
        <dd className="tabular-nums text-slate-800 dark:text-[#FAFAFA]">
          {formatMoneyMinor(st.paidMinor, cur)} of {formatMoneyMinor(view.totalMinor, cur)}
          {st.outstandingMinor > 0 ? <span className="text-slate-500"> · {formatMoneyMinor(st.outstandingMinor, cur)} outstanding</span> : null}
        </dd>
        {st.fullyPaidOn ? (
          <>
            <dt className="text-slate-500">Collected in</dt>
            <dd className="text-slate-800 dark:text-[#FAFAFA]">
              {st.daysToCollect} days ({st.collectedOnTime ? 'on time' : 'late'})
            </dd>
          </>
        ) : null}
      </dl>

      {view.access.editLink ? (
        editingLink ? (
          <div className="grid gap-2 rounded-md bg-slate-50 p-2 sm:grid-cols-[1fr_8rem_auto] dark:bg-[#141414]">
            <label className="text-[11px] text-slate-500">
              Deal
              <select value={dealId} onChange={(e) => setDealId(e.target.value)} className={`${input} mt-0.5`} disabled={!dealOptions}>
                <option value="">— Not linked —</option>
                {view.dealId && !dealOptions?.some((d) => d.id === view.dealId) ? (
                  <option value={view.dealId}>{view.dealName ?? 'Current deal'}</option>
                ) : null}
                {(dealOptions ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.company ? ` · ${d.company}` : ''} ({d.stage})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-slate-500">
              Credit days
              <input
                type="number"
                min={0}
                max={730}
                value={creditDays}
                onChange={(e) => setCreditDays(e.target.value)}
                placeholder="from deal"
                className={`${input} mt-0.5`}
              />
            </label>
            <div className="flex items-end gap-1.5">
              <button type="button" onClick={saveLink} disabled={pending} className="rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
                Save
              </button>
              <button type="button" onClick={() => setEditingLink(false)} className="rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] text-slate-600 dark:border-[#1F1F1F]">
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-slate-400 sm:col-span-3">
              Leave credit days empty to use the deal’s agreed terms (or the {view.standardCreditDays}-day standard).
            </p>
          </div>
        ) : (
          <button type="button" onClick={startEditLink} className="text-[12px] font-medium text-indigo-600 hover:text-indigo-500">
            {view.dealId ? 'Change deal / credit days' : 'Link to a deal'}
          </button>
        )
      ) : null}

      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Payments</h4>
        {view.payments.length === 0 ? (
          <p className="text-[12px] text-slate-500">No payments recorded.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-[12px] dark:divide-[#1F1F1F]">
            {view.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-1.5">
                <span>
                  <span className="font-medium tabular-nums text-slate-800 dark:text-[#FAFAFA]">{formatMoneyMinor(p.amountMinor, cur)}</span>
                  <span className="text-slate-500"> · {p.paidOn}</span>
                  {p.reference ? <span className="text-slate-400"> · {p.reference}</span> : null}
                </span>
                {view.access.recordPayments ? (
                  <button type="button" onClick={() => removePayment(p.id)} disabled={pending} className="text-slate-400 hover:text-rose-600" aria-label="Remove payment">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {view.access.recordPayments ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
            <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Amount (${cur})`} className={input} />
            <input type="date" value={paidOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setPaidOn(e.target.value)} className={input} />
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference (UTR / cheque)" maxLength={120} className={input} />
            <button type="button" onClick={addPayment} disabled={pending || !amount} className="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
              Record payment
            </button>
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-slate-400">Payments are recorded by a manager or admin.</p>
        )}
      </div>
    </section>
  );
}
