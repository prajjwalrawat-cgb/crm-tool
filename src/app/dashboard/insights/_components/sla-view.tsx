'use client';

import Link from 'next/link';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import { TrendLine } from './lazy';
import { ReassignButton } from './stale-table';
import { Card, EmptyState, VIZ } from './ui';

type Heat = { weekday: number; hour: number; due: number; breached: number };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Hour-of-day × weekday heatmap of SLA breaches (sequential: one hue,
 * light → dark by breach count, mixed into the surface so dark mode gets
 * its own steps). Hover/focus a cell for the exact numbers; a table view is
 * one click away.
 */
export function SlaHeatmap({ cells }: { cells: Heat[] }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<Heat | null>(null);
  const by = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c]));
  const max = Math.max(1, ...cells.map((c) => c.breached));
  if (cells.length === 0) return <EmptyState title="No assignments in this period" />;
  return (
    <div className={VIZ}>
      <div className="mb-2 flex items-center justify-between text-[11.5px] text-slate-500">
        <span>{hover ? `${DAYS[hover.weekday]} ${String(hover.hour).padStart(2, '0')}:00 · ${hover.breached} breached of ${hover.due} due` : 'Breaches by when the lead was assigned (workspace time)'}</span>
        <button type="button" onClick={() => setAsTable((v) => !v)} className="rounded px-1.5 py-0.5 hover:bg-slate-100">
          {asTable ? 'Show heatmap' : 'Show as table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1">Day</th>
                <th>Hour</th>
                <th className="text-right">Due</th>
                <th className="text-right">Breached</th>
              </tr>
            </thead>
            <tbody>
              {[...cells]
                .sort((a, b) => b.breached - a.breached)
                .map((c) => (
                  <tr key={`${c.weekday}-${c.hour}`} className="border-t border-slate-100">
                    <td className="py-1">{DAYS[c.weekday]}</td>
                    <td>{String(c.hour).padStart(2, '0')}:00</td>
                    <td className="text-right tabular-nums">{c.due}</td>
                    <td className="text-right tabular-nums">{c.breached}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[560px] gap-[2px]" style={{ gridTemplateColumns: '36px repeat(24, minmax(0, 1fr))' }} role="grid" aria-label="SLA breaches by weekday and hour">
            <div />
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} className="text-center text-[9.5px] text-slate-400">
                {h % 3 === 0 ? h : ''}
              </div>
            ))}
            {ORDER.map((d) => (
              <div key={d} className="contents" role="row">
                <div className="pr-1 text-right text-[10.5px] leading-5 text-slate-500">{DAYS[d]}</div>
                {Array.from({ length: 24 }).map((_, h) => {
                  const c = by.get(`${d}-${h}`) ?? { weekday: d, hour: h, due: 0, breached: 0 };
                  const pct = c.breached === 0 ? 0 : 12 + Math.round((c.breached / max) * 78);
                  return (
                    <button
                      key={h}
                      type="button"
                      role="gridcell"
                      aria-label={`${DAYS[d]} ${h}:00, ${c.breached} breached of ${c.due} due`}
                      onMouseEnter={() => setHover(c)}
                      onFocus={() => setHover(c)}
                      onMouseLeave={() => setHover(null)}
                      className="h-5 rounded-[3px] bg-slate-100 outline-offset-1 focus-visible:outline-2 focus-visible:outline-slate-900"
                      style={pct ? { background: `color-mix(in oklab, var(--viz-1) ${pct}%, transparent)` } : undefined}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[10.5px] text-slate-500">
            <span>0</span>
            <div className="h-2 w-32 rounded" style={{ background: 'linear-gradient(to right, color-mix(in oklab, var(--viz-1) 12%, transparent), var(--viz-1))' }} />
            <span>{max} breaches</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function SlaTrend({ data }: { data: Array<{ day: string; compliancePct: number | null }> }) {
  return (
    <div className={VIZ}>
      <TrendLine data={data.map((d) => ({ day: d.day, value: d.compliancePct }))} label="SLA met" unit="%" />
    </div>
  );
}

type Breach = { assignmentId: string; dealId: string; dealName: string; ownerId: string; ownerName: string; assignedAt: string; slaDueAt: string; firstTouchAt: string | null; open: boolean };

export function BreachList({ rows, canReassign }: { rows: Breach[]; canReassign: boolean }) {
  if (rows.length === 0) return <EmptyState title="No SLA breaches in this period" />;
  const t = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  return (
    <Card title={`Breaches (${rows.length})`}>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-white text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1.5">Lead</th>
              <th>Owner</th>
              <th>Due</th>
              <th>First response</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.assignmentId} className="border-t border-slate-100">
                <td className="py-1.5">
                  <Link href={`/dashboard/deals/${b.dealId}`} className="text-slate-900 hover:underline">
                    {b.dealName}
                  </Link>
                </td>
                <td className="text-slate-700">{b.ownerName}</td>
                <td className="text-slate-700">{t(b.slaDueAt)}</td>
                <td className={cn(b.firstTouchAt ? 'text-slate-700' : 'font-medium text-rose-700')}>{b.firstTouchAt ? `${t(b.firstTouchAt)} (late)` : 'not yet'}</td>
                <td className="text-right">{b.open && canReassign && <ReassignButton dealId={b.dealId} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
