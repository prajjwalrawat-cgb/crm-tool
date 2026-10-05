'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { CreateDrawer } from '../../_components/create-drawer';
import { Drawer } from '../../_components/drawer';
import { DownloadPdfButton } from './download-pdf-button';
import { InvoiceDetailDrawer } from './invoice-detail-drawer';
import { InvoiceForm, type SellerProfileOption } from './invoice-form';
import type { InvoiceListRow } from '@/lib/invoices/queries';
import { formatMoneyMinor } from '@/lib/invoices/money';
import type { InvoicePdfData } from '@/lib/invoices/types';
import type { InvoiceStatus } from '@/lib/collections/diagnostic';

import { InvoiceStatusBadge } from './invoice-status-badge';

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export function InvoicesView({
  rows,
  total,
  page,
  size,
  totalPages,
  initialSearch,
  currentUserId,
  canManageAll,
  sellerProfiles,
  defaultPaymentTerms,
  defaultDeliveryTerms,
  statuses,
}: {
  rows: InvoiceListRow[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
  initialSearch: string;
  currentUserId: string;
  canManageAll: boolean;
  sellerProfiles: SellerProfileOption[];
  defaultPaymentTerms: string;
  defaultDeliveryTerms: string;
  /** Collection status per invoice id (0069). */
  statuses: Record<string, InvoiceStatus>;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  const [createKey, setCreateKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<InvoicePdfData | null>(null);
  const [, startTransition] = useTransition();
  const firstRender = useRef(true);

  // Debounced search → URL (?q). Resets to page 1, preserves size.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      startTransition(() => {
        const params = new URLSearchParams();
        const q = search.trim();
        if (q) params.set('q', q);
        if (size !== 50) params.set('size', String(size));
        const qs = params.toString();
        router.replace(`/dashboard/invoices${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, size, router]);

  function hrefFor(p: number, s: number = size) {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    params.set('page', String(p));
    params.set('size', String(s));
    return `/dashboard/invoices?${params.toString()}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by PI number or buyer…"
            aria-label="Search invoices"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
        <CreateDrawer
          label="New PI"
          drawerTitle="New proforma invoice"
          description="The PI number is generated automatically."
          closeOnSuccessKey={createKey}
          widthClass="max-w-3xl"
        >
          {() => (
            <InvoiceForm
              key={createKey}
              sellerProfiles={sellerProfiles}
              defaultPaymentTerms={defaultPaymentTerms}
              defaultDeliveryTerms={defaultDeliveryTerms}
              onSuccess={() => {
                setCreateKey((k) => k + 1);
                router.refresh();
              }}
            />
          )}
        </CreateDrawer>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
          <p className="text-[14px] font-medium text-slate-700">No invoices found</p>
          <p className="mt-1 text-[12px] text-slate-500">
            {initialSearch ? 'Try a different search.' : 'Create your first PI with “New PI”.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-[13px]">
              <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">PI Number</th>
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Buyer</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className="cursor-pointer hover:bg-slate-50/60"
                  >
                    <td className="px-4 py-2.5 font-medium text-indigo-700">{r.piNumber}</td>
                    <td className="px-4 py-2.5 text-slate-600">{dateFmt.format(new Date(r.piDate))}</td>
                    <td className="px-4 py-2.5 text-slate-700">{r.buyerName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                      {formatMoneyMinor(r.totalMinor, r.currency)}
                    </td>
                    <td className="px-4 py-2.5">
                      {statuses[r.id] ? <InvoiceStatusBadge status={statuses[r.id]!} /> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <DownloadPdfButton id={r.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-[12px] text-slate-500">
            <span>{total} total · page {Math.min(page, totalPages)} of {totalPages}</span>
            <div className="flex items-center gap-2">
              {[25, 50, 100].map((s) => (
                <Link
                  key={s}
                  href={hrefFor(1, s)}
                  className={
                    s === size
                      ? 'rounded-md bg-indigo-50 px-2 py-1 font-medium text-indigo-700'
                      : 'rounded-md px-2 py-1 hover:bg-slate-100'
                  }
                >
                  {s}
                </Link>
              ))}
              <PageLink href={hrefFor(page - 1)} disabled={page <= 1} label="Prev" />
              <PageLink href={hrefFor(page + 1)} disabled={page >= totalPages} label="Next" />
            </div>
          </div>
        </div>
      )}

      <InvoiceDetailDrawer
        invoiceId={selectedId}
        onClose={() => setSelectedId(null)}
        currentUserId={currentUserId}
        canManageAll={canManageAll}
        onEdit={(data) => {
          setSelectedId(null);
          setEditing(data);
        }}
        onDeleted={() => {
          setSelectedId(null);
          router.refresh();
        }}
      />

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit invoice"
        description={editing?.piNumber}
        widthClass="max-w-3xl"
      >
        {editing ? (
          <InvoiceForm
            key={editing.id}
            mode="edit"
            invoiceId={editing.id}
            initial={editing}
            sellerProfiles={sellerProfiles}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function PageLink({ href, disabled, label }: { href: string; disabled: boolean; label: string }) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded-md border border-slate-200 px-2.5 py-1 text-slate-300">
        {label}
      </span>
    );
  }
  return (
    <Link href={href} className="rounded-md border border-slate-200 px-2.5 py-1 text-slate-600 transition hover:bg-slate-100">
      {label}
    </Link>
  );
}
