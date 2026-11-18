'use client';

import { Maximize2, Minimize2, Trophy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fmt, type CurrencyCtx } from '@/lib/reports/manager/format';
import { cn } from '@/lib/utils';

import { Bone, ErrorBox, VIZ } from './ui';

type Row = { userId: string; name: string; value: number; rank: number };
type Data = { rows: Row[]; generatedAt: string };

const METRICS = [
  ['won_value', 'Won value'],
  ['calls', 'Calls'],
  ['qualified', 'Qualified'],
] as const;
const PERIODS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
] as const;

/** Live leaderboard: polls every 30s; TV mode = full screen + large type. */
export function LeaderboardBoard({ currency, initial }: { currency: CurrencyCtx; initial: Data | null }) {
  const [metric, setMetric] = useState<(typeof METRICS)[number][0]>('won_value');
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>('month');
  const [data, setData] = useState<Data | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [tv, setTv] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    fetch(`/api/reports/leaderboard?metric=${metric}&period=${period}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: Data) => {
        setData(d);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  }, [metric, period]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const onFs = () => setTv(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleTv = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => setTv((v) => !v));
  };

  const max = Math.max(1, ...(data?.rows.map((r) => r.value) ?? [1]));
  const unit = metric === 'won_value' ? 'currency' : 'count';

  return (
    <div ref={root} className={cn('rounded-lg border border-slate-200 bg-white p-4', VIZ, tv && 'fixed inset-0 z-50 overflow-auto rounded-none p-10')}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Metric">
          {METRICS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={metric === k} type="button" onClick={() => setMetric(k)} className={cn('rounded-md px-2.5 py-1 font-medium', tv ? 'text-lg' : 'text-[12.5px]', metric === k ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}>
              {l}
            </button>
          ))}
          <span className="mx-1 w-px bg-slate-200" />
          {PERIODS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={period === k} onClick={() => setPeriod(k)} className={cn('rounded-md px-2.5 py-1', tv ? 'text-lg' : 'text-[12.5px]', period === k ? 'bg-slate-200 text-slate-900' : 'text-slate-600 hover:bg-slate-100')}>
              {l}
            </button>
          ))}
        </div>
        <button type="button" onClick={toggleTv} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50">
          {tv ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {tv ? 'Exit TV mode' : 'TV mode'}
        </button>
      </div>
      {err && <ErrorBox message={`Could not refresh: ${err}`} />}
      {!data && !err && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bone key={i} className="h-8 w-full" />
          ))}
        </div>
      )}
      {data && (
        <ol className={cn('space-y-1.5', tv && 'space-y-3')}>
          {data.rows.map((r) => (
            <li key={r.userId} className="grid grid-cols-[2.5rem_minmax(0,12rem)_1fr_auto] items-center gap-3">
              <span className={cn('flex items-center justify-center font-semibold tabular-nums text-slate-500', tv ? 'text-3xl' : 'text-[13px]')}>
                {r.rank === 1 && r.value > 0 ? <Trophy className={cn('text-slate-700', tv ? 'h-8 w-8' : 'h-4 w-4')} aria-label="First" /> : r.rank}
              </span>
              <span className={cn('truncate font-medium text-slate-900', tv ? 'text-3xl' : 'text-[13px]')}>{r.name}</span>
              <span className={cn('block rounded bg-slate-100', tv ? 'h-8' : 'h-3')}>
                <span className="block h-full rounded bg-[var(--viz-1)]" style={{ width: `${(r.value / max) * 100}%` }} />
              </span>
              <span className={cn('text-right font-semibold tabular-nums text-slate-900', tv ? 'text-3xl' : 'text-[13px]')}>{fmt(unit, r.value, currency, unit === 'currency')}</span>
            </li>
          ))}
        </ol>
      )}
      {data && <p className={cn('mt-4 text-slate-400', tv ? 'text-base' : 'text-[11px]')}>Updated {new Date(data.generatedAt).toLocaleTimeString()} · refreshes every 30 seconds</p>}
    </div>
  );
}
