'use client';

import { RefreshCw, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { changeLabel, fmt, type CurrencyCtx } from '@/lib/reports/manager/format';
import type { KpiTile } from '@/lib/reports/manager/services';
import { cn } from '@/lib/utils';

import { Sparkline } from './lazy';
import { Bone, Card, DeltaText, ErrorBox, ExportLink, VIZ } from './ui';

type RangeQuery = Record<string, string>;

/* -------------------------------------------------------------- KPI strip */

export function KpiStrip({ tiles, currency, query }: { tiles: KpiTile[]; currency: CurrencyCtx; query: RangeQuery }) {
  const [drill, setDrill] = useState<KpiTile | null>(null);
  return (
    <>
      <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6', VIZ)}>
        {tiles.map((t) => {
          const d = t.delta;
          const good = d?.absolute == null || d.absolute === 0 ? null : d.absolute > 0 === t.higherIsBetter;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => t.drill && setDrill(t)}
              disabled={!t.drill}
              title={t.description}
              className="group flex min-w-0 flex-col rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-slate-300 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-default"
            >
              <span className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500">{t.label}</span>
              <span className="mt-1 truncate text-xl font-semibold tabular-nums text-slate-900">{fmt(t.unit, t.value, currency, t.unit === 'currency')}</span>
              {d ? <DeltaText text={changeLabel(d.absolute, d.percent, t.unit, currency)} good={good} /> : <span className="text-[11.5px] text-slate-500">{t.note ?? 'current snapshot'}</span>}
              <div className="mt-1">{t.sparkline.length > 1 ? <Sparkline data={t.sparkline} label={t.label} /> : <div className="h-8" />}</div>
            </button>
          );
        })}
      </div>
      {drill && <DrillDialog tile={drill} query={query} currency={currency} onClose={() => setDrill(null)} />}
    </>
  );
}

/* ----------------------------------------------------------- drill dialog */

type DrillResponse = { count: number; sum: number | null; truncated: boolean; rows: Array<Record<string, string | number | null>> };

const DRILL_COLUMNS: Record<string, Array<[string, string]>> = {
  lead_volume: [['name', 'Lead'], ['stage', 'Stage'], ['created_at', 'Created']],
  won_value: [['name', 'Deal'], ['value', 'Value'], ['closed_at', 'Closed']],
  won_count: [['name', 'Deal'], ['value', 'Value'], ['closed_at', 'Closed']],
  calls_made: [['status', 'Status'], ['started_at', 'Started'], ['talk_time_sec', 'Talk (s)']],
  sla_compliance_pct: [['name', 'Lead'], ['assigned_at', 'Assigned'], ['sla_due_at', 'Due'], ['met', 'Met']],
  pipeline_value: [['name', 'Deal'], ['stage', 'Stage'], ['value', 'Value']],
  forecast_this_month: [['name', 'Deal'], ['stage', 'Stage'], ['value', 'Value'], ['expected_close_date', 'Close']],
};

function DrillDialog({ tile, query, currency, onClose }: { tile: KpiTile; query: RangeQuery; currency: CurrencyCtx; onClose: () => void }) {
  const [data, setData] = useState<DrillResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const metric = tile.drill!;
  useEffect(() => {
    const qs = new URLSearchParams({ ...query, metric }).toString();
    fetch(`/api/reports/drill?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [metric, query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const cols = DRILL_COLUMNS[metric] ?? [];
  return (
    <div role="dialog" aria-modal="true" aria-label={`${tile.label} details`} className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-16" onClick={onClose}>
      <div className="max-h-[75vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">{tile.label}</h2>
            <p className="text-[12px] text-slate-500">
              {data
                ? `${data.count.toLocaleString('en-IN')} rows${data.sum !== null ? ` · ${metric.includes('value') || metric.includes('forecast') ? fmt('currency', data.sum, currency) : `${data.sum.toLocaleString('en-IN')} ${metric === 'calls_made' ? 'connected' : 'met'}`}` : ''}${data.truncated ? ' · first rows shown' : ''}`
                : 'Loading…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ExportLink report={`drill:${metric}`} query={query} />
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {error && <div className="p-4"><ErrorBox message={`Could not load: ${error}`} /></div>}
          {!data && !error && (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Bone key={i} className="h-5 w-full" />
              ))}
            </div>
          )}
          {data && (
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>{cols.map(([, l]) => <th key={l} className="px-3 py-2 font-medium">{l}</th>)}</tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => {
                  const dealId = (r.deal_id ?? r.lead_id ?? (metric === 'calls_made' ? null : r.id)) as string | null;
                  return (
                    <tr key={String(r.id ?? i)} className="border-t border-slate-100">
                      {cols.map(([k], ci) => {
                        const v = r[k];
                        const text = v === null || v === undefined ? '—' : k === 'value' ? fmt('currency', Number(v), currency) : k === 'met' ? (Number(v) ? 'Yes' : 'No') : String(v).replace('T', ' ').slice(0, k.endsWith('_at') ? 16 : 200);
                        return (
                          <td key={k} className="px-3 py-1.5 text-slate-800">
                            {ci === 0 && dealId ? <Link className="text-slate-900 underline-offset-2 hover:underline" href={`/dashboard/deals/${dealId}`}>{text}</Link> : text}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- narrative card */

type Narrative = {
  headline: string;
  whats_up: string[];
  whats_down: string[];
  likely_drivers: string[];
  actions_for_manager: Array<{ action: string; metric: string }>;
  caveats: string[];
};
type NarrativeResponse =
  | { status: 'ok'; narrative: Narrative; generatedAt: string; cached: boolean }
  | { status: 'unavailable' | 'disabled'; reason: string };

export function NarrativeCard({ query }: { query: RangeQuery }) {
  const [state, setState] = useState<NarrativeResponse | 'loading' | 'error'>('loading');
  // Only sets state from the response callbacks; the parent remounts this
  // card (key = range) when the period changes, which resets it to loading.
  const fetchNarrative = useCallback(
    (force: boolean) =>
      fetch('/api/reports/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: query.range, from: query.from, to: query.to, compareTo: query.compareTo === 'yoy' ? 'yoy' : 'previous', force }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: NarrativeResponse) => setState(d))
        .catch(() => setState('error')),
    [query.range, query.from, query.to, query.compareTo],
  );
  useEffect(() => {
    void fetchNarrative(false);
  }, [fetchNarrative]);
  const load = (force: boolean) => {
    setState('loading');
    void fetchNarrative(force);
  };

  if (state !== 'loading' && state !== 'error' && state.status === 'disabled') return null;
  return (
    <Card
      title="What changed and why"
      actions={
        <button type="button" onClick={() => load(true)} disabled={state === 'loading'} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-50">
          <RefreshCw className={cn('h-3.5 w-3.5', state === 'loading' && 'animate-spin')} aria-hidden />
          Regenerate
        </button>
      }
    >
      {state === 'loading' && (
        <div className="space-y-2">
          <Bone className="h-4 w-2/3" />
          <Bone className="h-3 w-full" />
          <Bone className="h-3 w-5/6" />
        </div>
      )}
      {(state === 'error' || (state !== 'loading' && state.status === 'unavailable')) && (
        <p className="text-[12.5px] text-slate-500">Narrative unavailable. The numbers above are unaffected.</p>
      )}
      {state !== 'loading' && state !== 'error' && state.status === 'ok' && (
        <div className="space-y-3 text-[13px] text-slate-800">
          <p className="flex items-start gap-2 font-medium text-slate-900">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            {state.narrative.headline}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <List title="Up" items={state.narrative.whats_up} />
            <List title="Down" items={state.narrative.whats_down} />
            <List title="Likely drivers" items={state.narrative.likely_drivers} />
            <List title="Suggested actions" items={state.narrative.actions_for_manager.map((a) => a.action)} />
          </div>
          {state.narrative.caveats.length > 0 && <p className="text-[11.5px] text-slate-500">Caveats: {state.narrative.caveats.join(' ')}</p>}
          <p className="text-[11px] text-slate-400">
            AI-written from aggregate numbers only; every figure is checked against them. {state.cached ? 'Cached' : 'Generated'} {new Date(state.generatedAt).toLocaleTimeString()}.
          </p>
        </div>
      )}
    </Card>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px]">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
