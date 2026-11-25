'use client';

import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';

import type { DayMeeting } from '@/lib/field/day';
import { cn } from '@/lib/utils';

import { formatTimeInTz } from '../_lib/datetime';
import { STATUS_LABEL, riskLabel } from '../_lib/labels';
import { DAY_END_HOUR, DAY_START_HOUR, blockColor, blockGeometry, layoutLane, type BlockColor } from '../_lib/timeline';
import { useTenantTz } from '../_lib/tz-context';

export const NAME_COL = 'w-44 shrink-0';
const ROW_H = 44;
const TRAVEL_H = 22;
/** Blocks never render narrower than this, so short or clamped meetings stay clickable. */
const MIN_BLOCK = '2.25rem';

const COLOR: Record<BlockColor, string> = {
  planned:
    'border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200 dark:border-[#3F3F46] dark:bg-[#1F1F1F] dark:text-[#E4E4E7] dark:hover:bg-[#27272A]',
  onsite:
    'border-blue-400 bg-blue-100 text-blue-900 hover:bg-blue-200 dark:border-blue-500/60 dark:bg-blue-500/15 dark:text-blue-200',
  done: 'border-emerald-400 bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:border-emerald-500/60 dark:bg-emerald-500/15 dark:text-emerald-200',
  atrisk:
    'border-amber-400 bg-amber-100 text-amber-900 hover:bg-amber-200 dark:border-amber-500/70 dark:bg-amber-500/15 dark:text-amber-200',
};

export const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, i) => DAY_START_HOUR + i);
export const hourPct = (h: number) => ((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100;

function blockLabel(rep: string, m: DayMeeting, tz: string): string {
  const time = `${formatTimeInTz(m.startAt, tz)} to ${formatTimeInTz(m.endAt, tz)}`;
  const risks = m.risk.reasons.length > 0 ? `At risk: ${m.risk.reasons.map((r) => riskLabel(r, m.risk)).join('; ')}` : 'No risks';
  return `${rep}: ${m.title}, ${time}, ${STATUS_LABEL[m.status]}${m.type === 'virtual' ? ', virtual' : ''}. ${risks}.`;
}

/**
 * One rep's row on the 09:00–19:00 grid: blocks stacked into sub-rows where
 * they overlap (red outline), plus a travel track under them with a dashed
 * "~N min drive" connector between consecutive physical meetings (red when
 * the gap is too tight). Blocks are buttons that open the meeting panel.
 */
export function Swimlane({
  rep,
  selectedId,
  nowPct,
  showTravel,
  onSelect,
}: {
  rep: { userId: string; name: string; meetings: DayMeeting[] };
  selectedId: string | null;
  nowPct: number | null;
  /** Off when the lane is a filtered subset: a connector would join meetings that are not consecutive. */
  showTravel: boolean;
  onSelect: (id: string, trigger: HTMLElement) => void;
}) {
  const tz = useTenantTz();
  const laid = layoutLane(rep.meetings, tz);
  const lane = showTravel ? laid : { ...laid, connectors: [] };
  const atRisk = lane.blocks.filter((b) => b.meeting.risk.reasons.length > 0).length;
  const travelH = lane.connectors.length > 0 ? TRAVEL_H : 0;
  const height = lane.rows * ROW_H + travelH;

  return (
    <div role="listitem" className="flex border-b border-slate-100 last:border-b-0 dark:border-[#1F1F1F]">
      <div className={cn(NAME_COL, 'sticky left-0 z-20 border-r border-slate-100 bg-white px-3 py-2.5 dark:border-[#1F1F1F] dark:bg-[#0F0F0F]')}>
        <p className="truncate text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]" title={rep.name}>
          {rep.name}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
          {lane.blocks.length === 0 ? (
            'No meetings'
          ) : (
            <>
              {lane.blocks.length} meeting{lane.blocks.length === 1 ? '' : 's'}
              {atRisk > 0 ? (
                <span className="inline-flex items-center gap-0.5 font-medium text-amber-700 dark:text-amber-300">
                  · <AlertTriangle className="h-3 w-3" aria-hidden />
                  {atRisk} at risk
                </span>
              ) : null}
            </>
          )}
        </p>
      </div>

      <div className="relative flex-1" style={{ height: Math.max(height, ROW_H) }}>
        {HOURS.map((h) => (
          <div
            key={h}
            aria-hidden
            className="absolute inset-y-0 w-px bg-slate-100 dark:bg-[#1A1A1A]"
            style={{ left: `${hourPct(h)}%` }}
          />
        ))}
        {nowPct !== null ? (
          <div aria-hidden className="absolute inset-y-0 z-10 w-0.5 bg-red-500/70" style={{ left: `${nowPct}%` }} />
        ) : null}

        <ul aria-label={`${rep.name}'s meetings`}>
          {lane.blocks.map(({ meeting: m, row, overlaps }) => {
            const g = blockGeometry(m.startAt, m.endAt, tz);
            const color = blockColor(m);
            const selected = m.id === selectedId;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  id={`block-${m.id}`}
                  aria-label={blockLabel(rep.name, m, tz)}
                  aria-pressed={selected}
                  onClick={(e) => onSelect(m.id, e.currentTarget)}
                  title={`${m.title} · ${formatTimeInTz(m.startAt, tz)}–${formatTimeInTz(m.endAt, tz)}`}
                  className={cn(
                    'absolute z-[15] flex items-center gap-1 overflow-hidden rounded-md border px-1.5 text-left text-[11.5px] leading-tight shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1',
                    COLOR[color],
                    overlaps && 'outline outline-2 outline-red-500 dark:outline-red-400',
                    selected && 'ring-2 ring-indigo-600 ring-offset-1 dark:ring-offset-black',
                  )}
                  style={{
                    top: row * ROW_H + 4,
                    height: ROW_H - 8,
                    left: `min(${g.leftPct}%, calc(100% - ${MIN_BLOCK}))`,
                    width: `max(${g.widthPct}%, ${MIN_BLOCK})`,
                  }}
                >
                  {g.clippedStart ? <ChevronLeft className="h-3 w-3 shrink-0" aria-hidden /> : null}
                  {color === 'atrisk' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.title}</span>
                    <span className="block truncate tabular-nums opacity-80">
                      {formatTimeInTz(m.startAt, tz)}
                      {m.type === 'virtual' ? ' · virtual' : ''}
                    </span>
                  </span>
                  {g.clippedEnd ? <ChevronRight className="h-3 w-3 shrink-0" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>

        {lane.connectors.map((c) => {
          const text = c.minutes !== null ? `~${c.minutes} min drive${c.estimate ? ' est.' : ''}` : null;
          return (
            <div
              key={`${c.fromId}-${c.toId}`}
              className={cn(
                'absolute flex items-center',
                c.tight ? 'text-red-700 dark:text-red-400' : 'text-slate-500 dark:text-[#A1A1AA]',
              )}
              style={{ top: lane.rows * ROW_H, height: TRAVEL_H, left: `${c.leftPct}%`, width: `${c.widthPct}%` }}
              title={text ? (c.tight ? `${text}: not enough time between meetings` : text) : 'Travel'}
            >
              <div
                aria-hidden
                className={cn('absolute inset-x-0 top-1/2 border-t-2 border-dashed', c.tight ? 'border-red-500' : 'border-slate-300 dark:border-[#3F3F46]')}
              />
              {text ? (
              <span
                className={cn(
                  'relative mx-auto inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-white px-1 text-[10.5px] font-medium dark:bg-[#0F0F0F]',
                  c.widthPct === 0 && '-translate-x-1/2',
                )}
              >
                {c.tight ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
                {text}
                {c.tight ? <span className="sr-only"> (too tight)</span> : null}
              </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
