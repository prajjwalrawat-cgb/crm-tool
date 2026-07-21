import { ChevronRight, Heart, HeartCrack, HeartPulse, Sparkles } from 'lucide-react';

import { getRelationshipView } from '@/lib/communications/relationships/score';
import type { RelationshipStatus } from '@/db/schema';
import { cn } from '@/lib/utils';

/**
 * Relationship-health snapshot for a single CRM entity. Server
 * component — reads the cached `relationship_signals` row and renders
 * the score chip + signal breakdown + explanation list.
 *
 * Render-friendly: when no signal row exists (deal with no
 * communications yet), shows an empty state instead of a misleading
 * "at risk" badge.
 *
 * Used on deal / company / contact detail pages and on the thread
 * detail page (when the thread is linked to an entity).
 */
export async function RelationshipHealthCard({
  tenantId,
  entityType,
  entityId,
}: {
  tenantId: string;
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
}) {
  const { signal, breakdown, explanations } = await getRelationshipView(
    tenantId,
    entityType,
    entityId,
  );

  if (!signal || !breakdown) {
    // Empty state: collapse to a single line rather than a full-height card so
    // it doesn't waste prime real estate before any communication exists.
    // Expands on click; auto-renders full (below) once a real signal lands.
    return (
      <details className="group rounded-lg border border-dashed border-slate-200 bg-slate-50/40 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
          <HeartPulse className="h-3 w-3 text-slate-400 dark:text-[#71717A]" aria-hidden />
          Relationship health
          <span className="font-normal normal-case tracking-normal text-slate-400 dark:text-[#71717A]">
            — no activity yet
          </span>
          <ChevronRight
            className="ml-auto h-3 w-3 text-slate-400 transition-transform group-open:rotate-90 dark:text-[#71717A]"
            aria-hidden
          />
        </summary>
        <p className="px-3 pb-2.5 text-[11.5px] leading-snug text-slate-500 dark:text-[#A1A1AA]">
          The score appears once outbound or inbound email lands on this{' '}
          {entityType}.
        </p>
      </details>
    );
  }

  const Icon = statusIcon[breakdown.status];
  const scorePct = Math.round(breakdown.score * 100);

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        statusChrome[breakdown.status],
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
          <Icon className="h-3 w-3" aria-hidden />
          Relationship health
        </div>
        <span className="font-mono text-[10.5px] tabular-nums">
          {scorePct}/100
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[16px] font-semibold capitalize tracking-tight">
          {breakdown.status.replace('_', ' ')}
        </span>
        <span className="text-[10.5px] opacity-75">
          n={breakdown.sampleSize}
        </span>
      </div>

      <SignalBars breakdown={breakdown} />

      {explanations.length > 0 ? (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-[10.5px] font-medium opacity-80 hover:opacity-100">
            <span className="inline-flex items-center gap-0.5">
              <Sparkles className="h-2.5 w-2.5" aria-hidden />
              Why this score?
            </span>
          </summary>
          <ul className="mt-1 space-y-0.5 text-[11px] leading-snug opacity-90">
            {explanations.map((e, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-60" aria-hidden />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const statusChrome: Record<RelationshipStatus, string> = {
  healthy:
    'border-emerald-200/80 bg-emerald-50/60 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  warming:
    'border-indigo-200/80 bg-indigo-50/60 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200',
  stale:
    'border-amber-200/80 bg-amber-50/60 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  at_risk:
    'border-rose-200/80 bg-rose-50/60 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200',
};

const statusIcon: Record<RelationshipStatus, typeof Heart> = {
  healthy: Heart,
  warming: HeartPulse,
  stale: HeartPulse,
  at_risk: HeartCrack,
};

function SignalBars({
  breakdown,
}: {
  breakdown: NonNullable<
    Awaited<ReturnType<typeof getRelationshipView>>['breakdown']
  >;
}) {
  const bars = [
    { label: 'Inbound', value: breakdown.inboundDensity, weight: '40%' },
    { label: 'Consistency', value: breakdown.responseConsistency, weight: '30%' },
    { label: 'Recency', value: breakdown.recencyDecay, weight: '30%' },
  ];
  return (
    <div className="mt-2 space-y-1.5">
      {bars.map((b) => (
        <div key={b.label}>
          <div className="flex items-baseline justify-between text-[10.5px] opacity-80">
            <span>{b.label}</span>
            <span className="font-mono tabular-nums">
              {Math.round(b.value * 100)}% · {b.weight}
            </span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-current opacity-70 transition-[width]"
              style={{ width: `${Math.round(b.value * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
