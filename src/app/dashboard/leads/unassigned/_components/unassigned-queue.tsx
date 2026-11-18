'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { assignLeadsAction } from '../../actions';
import { Button, Card, EmptyState, formatWhen, inputCls, selectCls } from '../../../settings/lead-capture/_components/ui';

type Lead = {
  id: string;
  name: string;
  company: string | null;
  place: string;
  productInterest: string | null;
  sourceName: string | null;
  queuedAt: string;
  contact: string | null;
};

function waited(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}

export function UnassignedQueue({
  filter,
  sources,
  people,
  leads,
}: {
  filter: { q: string; sourceId: string; state: string };
  sources: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  leads: Lead[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [to, setTo] = useState('');
  const [q, setQ] = useState(filter.q);
  const [sourceId, setSourceId] = useState(filter.sourceId);
  const [state, setState] = useState(filter.state);

  const allOnPage = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const count = allMatching ? null : selected.size;

  function applyFilter(e: React.FormEvent) {
    e.preventDefault();
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (sourceId) p.set('source', sourceId);
    if (state.trim()) p.set('state', state.trim());
    setSelected(new Set());
    setAllMatching(false);
    router.push(`${pathname}${p.size ? `?${p}` : ''}`);
  }

  function assign() {
    if (!to) return void toast.error('Pick who to assign to');
    if (!allMatching && selected.size === 0) return void toast.error('Select at least one lead');
    startTransition(async () => {
      const r = await assignLeadsAction(
        allMatching
          ? { filter: { q: filter.q || undefined, sourceId: filter.sourceId || undefined, state: filter.state || undefined }, to }
          : { dealIds: [...selected], to },
      );
      if (!r.ok) return void toast.error(r.message);
      toast.success(`Assigned ${r.data?.assigned ?? 0}${r.data?.failed ? ` · ${r.data.failed} could not be assigned` : ''}`);
      setSelected(new Set());
      setAllMatching(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <Card>
        <form onSubmit={applyFilter} className="grid gap-2 md:grid-cols-[1fr_14rem_12rem_auto]">
          <input className={inputCls} aria-label="Search" placeholder="Search name, company, city" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={selectCls} aria-label="Source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input className={inputCls} aria-label="State" placeholder="State" value={state} onChange={(e) => setState(e.target.value)} />
          <Button type="submit">Filter</Button>
        </form>
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-slate-600 dark:text-[#A1A1AA]">
            {allMatching ? 'All leads matching this filter selected' : `${count} selected`}
          </span>
          {allOnPage && !allMatching && leads.length >= 200 ? (
            <Button variant="ghost" onClick={() => setAllMatching(true)}>
              Select all matching the filter
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <select className={cn(selectCls, 'w-56')} aria-label="Assign to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Assign to…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={assign} disabled={pending || (!allMatching && selected.size === 0) || !to}>
              Assign
            </Button>
          </div>
        </div>

        {leads.length === 0 ? (
          <EmptyState title="The queue is empty">Every captured lead has an owner.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                <tr>
                  <th className="w-8 py-1.5">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allOnPage}
                      onChange={(e) => {
                        setAllMatching(false);
                        setSelected(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set());
                      }}
                    />
                  </th>
                  <th className="py-1.5 pr-3 font-medium">Lead</th>
                  <th className="py-1.5 pr-3 font-medium">Where</th>
                  <th className="py-1.5 pr-3 font-medium">Interest</th>
                  <th className="py-1.5 pr-3 font-medium">Source</th>
                  <th className="py-1.5 pr-3 font-medium">Waiting</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${l.name}`}
                        checked={allMatching || selected.has(l.id)}
                        onChange={(e) => {
                          setAllMatching(false);
                          setSelected((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(l.id);
                            else n.delete(l.id);
                            return n;
                          });
                        }}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Link href={`/dashboard/deals/${l.id}`} className="font-medium text-slate-900 hover:underline dark:text-[#FAFAFA]">
                        {l.name}
                      </Link>
                      <div className="text-[11.5px] text-slate-500">{[l.company, l.contact].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600 dark:text-[#A1A1AA]">{l.place || '—'}</td>
                    <td className="py-1.5 pr-3 text-slate-600 dark:text-[#A1A1AA]">{l.productInterest ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-slate-600 dark:text-[#A1A1AA]">{l.sourceName ?? '—'}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-600 dark:text-[#A1A1AA]" title={formatWhen(l.queuedAt)}>
                      {waited(l.queuedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
