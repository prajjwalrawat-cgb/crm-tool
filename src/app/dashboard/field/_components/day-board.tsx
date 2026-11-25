'use client';

import { AlertTriangle, CalendarPlus, Info, Loader2, RefreshCw, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { useRealtimeEventOfType } from '@/hooks/use-realtime-events';
import type { DayView } from '@/lib/field/day';
import { cn } from '@/lib/utils';

import { Button } from '../../settings/lead-capture/_components/ui';
import { formatDayLabel, todayInTz } from '../_lib/datetime';
import { blockGeometry } from '../_lib/timeline';
import { useTenantTz } from '../_lib/tz-context';
import { BoardFilters, boardHref, type BoardFilterState } from './board-filters';
import { FieldSheet } from './field-sheet';
import { KpiStrip } from './kpi-strip';
import { MeetingForm } from './meeting-form';
import { MeetingPanel } from './meeting-panel';
import { HOURS, NAME_COL, Swimlane, hourPct } from './swimlane';

const POLL_MS = 30_000;

const hourText = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;

const LEGEND: Array<{ label: string; cls: string; icon?: boolean }> = [
  { label: 'Planned', cls: 'border-slate-300 bg-slate-100 dark:border-[#3F3F46] dark:bg-[#1F1F1F]' },
  { label: 'On site', cls: 'border-blue-400 bg-blue-100 dark:border-blue-500/60 dark:bg-blue-500/15' },
  { label: 'Done (MOM logged)', cls: 'border-emerald-400 bg-emerald-100 dark:border-emerald-500/60 dark:bg-emerald-500/15' },
  { label: 'At risk', cls: 'border-amber-400 bg-amber-100 dark:border-amber-500/70 dark:bg-amber-500/15', icon: true },
  { label: 'Overlapping', cls: 'border-slate-300 bg-white outline outline-2 outline-red-500 dark:bg-[#0F0F0F]' },
];

/**
 * Manager's day board. Data is the server-rendered DayView; this component
 * only re-asks the server (`router.refresh()`) every 30 s while the tab is
 * visible, when it becomes visible again, and on realtime `meeting.updated`
 * events for reps in scope. Filters navigate (router.replace) so a refresh
 * keeps them.
 */
export function DayBoard({
  day,
  today,
  userId,
  tenantId,
  ownersInScope,
  repId,
  atRiskOnly,
  focusId,
  pipelineLabel,
}: {
  day: DayView;
  today: string;
  userId: string;
  tenantId: string;
  ownersInScope: Array<{ id: string; name: string }>;
  repId: string | null;
  atRiskOnly: boolean;
  focusId: string | null;
  pipelineLabel: string;
}) {
  const router = useRouter();
  const tz = useTenantTz();
  const [refreshing, startRefresh] = useTransition();
  const [navigating, startNav] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  // A new ?m= (e.g. after planning a meeting on another day) opens that panel.
  const [seenFocus, setSeenFocus] = useState(focusId);
  if (seenFocus !== focusId) {
    setSeenFocus(focusId);
    setSelectedId(focusId);
  }
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const filters: BoardFilterState = { date: day.date, repId, atRiskOnly };

  const refresh = useCallback(() => startRefresh(() => router.refresh()), [router]);

  // 30 s polling, paused while the tab is hidden; coming back refreshes at once.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(refresh, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // Realtime (no-op unless NEXT_PUBLIC_REALTIME_ENABLED): coalesce bursts into one refresh.
  const inScope = new Set(ownersInScope.map((o) => o.id));
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);
  useRealtimeEventOfType(tenantId, 'meeting.updated', (event) => {
    if (!inScope.has(event.ownerId)) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(refresh, 500);
  });

  // "Now" line, client-only (no hydration mismatch), ticking each minute.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
  let nowPct: number | null = null;
  if (now !== null && todayInTz(tz, new Date(now)) === day.date) {
    const g = blockGeometry(new Date(now), new Date(now), tz);
    nowPct = g.clippedStart || g.clippedEnd ? null : g.leftPct;
  }

  // One lane per rep with meetings, plus empty lanes for the rest of the scope (not when filtering to risks).
  const lanes = (() => {
    const list = [...day.reps];
    if (!atRiskOnly) {
      const wanted = repId ? ownersInScope.filter((o) => o.id === repId) : ownersInScope.filter((o) => o.id !== userId);
      for (const o of wanted) {
        if (!list.some((r) => r.userId === o.id)) list.push({ userId: o.id, name: o.name, meetings: [] });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  })();

  let selected: { meeting: DayView['reps'][number]['meetings'][number]; repName: string } | null = null;
  for (const lane of selectedId ? day.reps : []) {
    const m = lane.meetings.find((x) => x.id === selectedId);
    if (m) selected = { meeting: m, repName: lane.name };
  }
  const focusMissing = focusId !== null && selectedId === focusId && selected === null;

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`block-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [focusId]);

  const navigate = (next: BoardFilterState) => startNav(() => router.replace(boardHref(next, today), { scroll: false }));

  const closePanel = () => {
    const id = selectedId;
    setSelectedId(null);
    const back = triggerRef.current ?? (id ? document.getElementById(`block-${id}`) : null);
    back?.focus();
    triggerRef.current = null;
    // Drop ?m= so a reload does not reopen it.
    if (focusId) router.replace(boardHref(filters, today), { scroll: false });
  };

  const defaultOwnerId = (repId && ownersInScope.some((o) => o.id === repId) ? repId : null) ?? ownersInScope.find((o) => o.id !== userId)?.id ?? userId;
  const meetingCount = day.reps.reduce((n, r) => n + r.meetings.filter((m) => m.status !== 'cancelled').length, 0);

  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Field day</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
            {day.date === today ? 'Today, ' : ''}
            {formatDayLabel(day.date)} · times in {day.tz}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh board"
            title="Refreshes on its own every 30 seconds"
            className="rounded-lg p-2.5 text-slate-600 hover:bg-slate-100 disabled:opacity-60 dark:text-[#A1A1AA] dark:hover:bg-[#181818]"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </button>
          <Button variant="primary" onClick={() => setCreating(true)} className="min-h-9 px-3.5 text-[13px]">
            <CalendarPlus className="h-4 w-4" aria-hidden /> New meeting
          </Button>
        </div>
      </header>

      {day.scopeFallback ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12.5px] text-sky-900 dark:border-sky-900/60 dark:bg-sky-500/10 dark:text-sky-200"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            You have no reps reporting to you yet — showing the whole workspace. Set up reporting lines in{' '}
            <Link href="/dashboard/settings/reporting-lines" className="font-medium underline">
              Settings → Reporting lines
            </Link>
            .
          </p>
        </div>
      ) : null}

      <div className="mb-4">
        <BoardFilters value={filters} today={today} reps={ownersInScope} pending={navigating} onChange={navigate} />
      </div>

      <div className="mb-4">
        <KpiStrip kpis={day.kpis} pipelineLabel={pipelineLabel} />
      </div>

      <ul className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-slate-600 dark:text-[#A1A1AA]" aria-label="Legend">
        {LEGEND.map((l) => (
          <li key={l.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('inline-flex h-3.5 w-5 items-center justify-center rounded border', l.cls)}>
              {l.icon ? <AlertTriangle className="h-2.5 w-2.5 text-amber-700" /> : null}
            </span>
            {l.label}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block w-5 border-t-2 border-dashed border-slate-400" />
          Drive between sites (red: too tight)
        </li>
      </ul>

      {focusMissing ? (
        <div
          role="status"
          className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12.5px] text-slate-700 dark:border-[#262626] dark:bg-[#111111] dark:text-[#D4D4D8]"
        >
          <p>That meeting is not on this board. It may be on another day, hidden by a filter, cancelled, or outside your team.</p>
          <button type="button" onClick={closePanel} aria-label="Dismiss" className="rounded p-1 hover:bg-slate-200 dark:hover:bg-[#1F1F1F]">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      <div
        className={cn(
          'overflow-x-auto rounded-xl border border-slate-200 bg-white transition-opacity dark:border-[#262626] dark:bg-[#0F0F0F]',
          navigating && 'opacity-60',
        )}
        aria-busy={navigating || refreshing}
      >
        <div className="min-w-[56rem]">
          <div className="flex border-b border-slate-200 dark:border-[#262626]" aria-hidden>
            <div className={cn(NAME_COL, 'sticky left-0 z-20 border-r border-slate-100 bg-white px-3 py-2 text-[11.5px] font-medium text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0F0F0F]')}>
              Rep
            </div>
            <div className="relative h-8 flex-1">
              {HOURS.map((h, i) => (
                <span
                  key={h}
                  className={cn(
                    'absolute top-2 whitespace-nowrap text-[11px] tabular-nums text-slate-500 dark:text-[#A1A1AA]',
                    i === 0 ? 'pl-1' : i === HOURS.length - 1 ? '-translate-x-full pr-1' : '-translate-x-1/2',
                  )}
                  style={{ left: `${hourPct(h)}%` }}
                >
                  {hourText(h)}
                </span>
              ))}
            </div>
          </div>

          {lanes.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-[14px] font-medium text-slate-800 dark:text-[#FAFAFA]">
                {atRiskOnly ? 'Nothing at risk' : `No meetings ${day.date === today ? 'today' : 'on this day'}`}
              </p>
              <p className="mt-1 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
                {atRiskOnly ? 'Every meeting in view is on track.' : 'Plan one with New meeting.'}
              </p>
            </div>
          ) : (
            <div role="list" aria-label={`Reps on ${formatDayLabel(day.date)}, ${meetingCount} meetings`}>
              {lanes.map((rep) => (
                <Swimlane
                  key={rep.userId}
                  rep={rep}
                  selectedId={selectedId}
                  nowPct={nowPct}
                  showTravel={!atRiskOnly}
                  onSelect={(id, el) => {
                    triggerRef.current = el;
                    setSelectedId(id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
        The grid shows 9 am – 7 pm; meetings outside it sit at the edge with an arrow. Drive times marked “est.” are
        straight-line estimates.
      </p>

      {selected && !creating ? (
        <MeetingPanel meeting={selected.meeting} repName={selected.repName} onClose={closePanel} onChanged={refresh} />
      ) : null}

      {creating ? (
        <FieldSheet title="New meeting" onClose={() => setCreating(false)}>
          <MeetingForm
            defaultOwnerId={defaultOwnerId}
            ownersInScope={ownersInScope}
            onSaved={(m) => {
              setCreating(false);
              toast.success('Meeting planned');
              const on = todayInTz(tz, new Date(m.startAt));
              if (on === day.date) {
                refresh();
              } else {
                const href = boardHref({ ...filters, date: on }, today);
                router.push(`${href}${href.includes('?') ? '&' : '?'}m=${m.id}`);
              }
            }}
          />
        </FieldSheet>
      ) : null}
    </main>
  );
}
