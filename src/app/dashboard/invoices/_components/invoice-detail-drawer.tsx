'use client';

import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  deleteInvoiceAction,
  getInvoiceForPdfAction,
} from '@/lib/invoices/actions';
import { formatMoneyMinor } from '@/lib/invoices/money';
import type { InvoicePdfData, PdfParty } from '@/lib/invoices/types';

import { Drawer } from '../../_components/drawer';
import { DownloadPdfButton } from './download-pdf-button';
import { InvoiceCollectionPanel } from './invoice-collection-panel';

export function InvoiceDetailDrawer({
  invoiceId,
  onClose,
  onEdit,
  onDeleted,
  currentUserId,
  canManageAll,
}: {
  invoiceId: string | null;
  onClose: () => void;
  onEdit: (data: InvoicePdfData) => void;
  onDeleted: () => void;
  currentUserId: string;
  canManageAll: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<InvoicePdfData | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, startDelete] = useTransition();

  const canDelete = data
    ? canManageAll || data.createdBy === currentUserId
    : false;

  function handleDelete() {
    if (!data) return;
    if (!window.confirm(`Delete ${data.piNumber}? This can't be undone.`)) return;
    startDelete(async () => {
      const res = await deleteInvoiceAction(data.id);
      if (res.ok) {
        toast.success('Invoice deleted');
        onDeleted();
      } else {
        toast.error(res.error);
      }
    });
  }

  useEffect(() => {
    if (!invoiceId) {
      setData(null);
      return;
    }
    let active = true;
    setLoading(true);
    getInvoiceForPdfAction(invoiceId)
      .then((d) => {
        if (active) setData(d);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [invoiceId]);

  return (
    <Drawer
      open={invoiceId !== null}
      onClose={onClose}
      title={data?.piNumber ?? 'Invoice'}
      description={data ? data.piDate : undefined}
      widthClass="max-w-2xl"
      footer={
        data ? (
          <div className="flex items-center justify-between gap-2">
            {canDelete ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-3 py-2 text-[13px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-60"
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden />
                )}
                Delete
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              {/* Same rule as delete, and as updateInvoiceAction enforces:
                  managers can open any PI to record payments, not edit it. */}
              {canDelete ? (
              <button
                type="button"
                onClick={() => onEdit(data)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </button>
              ) : null}
              <DownloadPdfButton id={data.id} variant="button" />
            </div>
          </div>
        ) : null
      }
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden />
        </div>
      ) : !data ? (
        <p className="text-sm text-slate-500">Invoice not found.</p>
      ) : (
        <div className="space-y-5">
          <DetailBody data={data} />
          <InvoiceCollectionPanel invoiceId={data.id} onChanged={() => router.refresh()} />
        </div>
      )}
    </Drawer>
  );
}

function PartyBlock({ title, party }: { title: string; party: PdfParty }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      <p className="mt-1 text-[13px] font-medium text-slate-900">{party.name}</p>
      {party.address ? (
        <p className="whitespace-pre-line text-[12px] text-slate-600">{party.address}</p>
      ) : null}
      {party.gstin ? <p className="text-[12px] text-slate-600">GSTIN: {party.gstin}</p> : null}
    </div>
  );
}

function DetailBody({ data }: { data: InvoicePdfData }) {
  const cur = data.currency;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <PartyBlock title="Seller" party={data.seller} />
        <PartyBlock title="Buyer (Bill to)" party={data.buyer} />
        <PartyBlock title="Ship to" party={data.consignee ?? data.buyer} />
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Payment</h3>
          {data.paymentTerms ? <p className="mt-1 text-[12px] text-slate-600">{data.paymentTerms}</p> : null}
          {data.deliveryTerms ? <p className="text-[12px] text-slate-600">Delivery: {data.deliveryTerms}</p> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-100 text-[12.5px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-center font-medium">Unit</th>
              <th className="px-3 py-2 text-right font-medium">Rate</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((it, i) => (
              <tr key={i}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {it.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.imageUrl} alt="" className="h-10 w-10 rounded border border-slate-200 object-cover" />
                    ) : null}
                    <div>
                      <p className="font-medium text-slate-800">{it.description}</p>
                      {it.hsnSac ? <p className="text-[11px] text-slate-400">HSN {it.hsnSac}</p> : null}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{it.quantity}</td>
                <td className="px-3 py-2 text-center text-slate-600">{it.unit}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoneyMinor(it.rateMinor, cur)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoneyMinor(it.amountMinor, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ml-auto w-full max-w-xs space-y-1 text-[13px]">
        <div className="flex justify-between text-slate-600"><span>Subtotal</span><span className="tabular-nums">{formatMoneyMinor(data.subtotalMinor, cur)}</span></div>
        {(() => {
          const shipMinor = data.shippingMinor ?? 0;
          const sameRate = Number(data.shippingTaxRate ?? 0) === Number(data.taxRate);
          const gstLabel = shipMinor > 0 && !sameRate ? 'GST' : `GST @ ${Number(data.taxRate)}%`;
          return (
            <>
              {shipMinor > 0 ? (
                <div className="flex justify-between text-slate-600"><span>Shipping</span><span className="tabular-nums">{formatMoneyMinor(shipMinor, cur)}</span></div>
              ) : null}
              <div className="flex justify-between text-slate-600"><span>{gstLabel}</span><span className="tabular-nums">{formatMoneyMinor(data.taxMinor, cur)}</span></div>
            </>
          );
        })()}
        <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900"><span>Total</span><span className="tabular-nums">{formatMoneyMinor(data.totalMinor, cur)}</span></div>
      </div>
    </div>
  );
}
