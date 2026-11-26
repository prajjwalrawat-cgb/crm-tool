'use client';

import { CalendarPlus, ChevronLeft, ChevronRight, Loader2, LocateOff, MapPinned, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { DayMeeting } from '@/lib/field/day';

import { Button } from '../../settings/lead-capture/_components/ui';
import { formatDayLabel, shiftDate, todayInTz } from '../_lib/datetime';
import { useTenantTz } from '../_lib/tz-context';
import { FieldSheet } from './field-sheet';
import { MeetingCard } from './meeting-card';
import { MeetingForm } from './meeting-form';
import { WalkInDialog } from './walk-in-dialog';

/**
 * Rep's day: header (date nav, tracking state, New meeting / Log walk-in) and
 * the time-ordered meeting cards. Every write ends in `router.refresh()`, which
 * re-runs the server page (getDay); coming back to the tab (e.g. from the Maps
 * app) refreshes too.
 */
export function MyDayView({
  date,
  today,
  meetings,
  userId,
  ownersInScope,
  canWrite,
  highlightId,
}: {
  date: string;
  today: string;
  meetings: DayMeeting[];
  userId: string;
  ownersInScope: Array<{ id: string; name: string }>;
  canWrite: boolean;
  highlightId: string | null;
}) {
  const router = useRouter();
  const tz = useTenantTz();
  const [refreshing, startRefresh] = useTransition();
  const [sheet, setSheet] = useState<null | 'new' | 'walk-in'>(null);
  const refresh = useCallback(() => startRefresh(() => router.refresh()), [router]);

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(`meeting-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId]);

  const dayHref = (d: string) => (d === today ? '/dashboard/field/my-day' : `/dashboard/field/my-day?date=${d}`);
  const active = meetings.filter((m) => m.status !== 'cancelled');
  const done = active.filter((m) => m.status === 'mom_logged').length;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-6">
      <header className="mb-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">My day</h1>
            <p className="mt-0.5 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
              {date === today ? 'Today, ' : ''}
              {formatDayLabel(date)}
              {active.length > 0 ? ` · ${done} of ${active.length} done` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Link
              href={dayHref(shiftDate(date, -1))}
              aria-label="Previous day"
              className="rounded-lg p-2.5 text-slate-600 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#181818]"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Link>
            {date !== today ? (
              <Link
                href={dayHref(today)}
                className="rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-indigo-600 hover:bg-slate-100 dark:hover:bg-[#181818]"
              >
                Today
              </Link>
            ) : null}
            <Link
              href={dayHref(shiftDate(date, 1))}
              aria-label="Next day"
              className="rounded-lg p-2.5 text-slate-600 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#181818]"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh"
              className="rounded-lg p-2.5 text-slate-600 hover:bg-slate-100 disabled:opacity-60 dark:text-[#A1A1AA] dark:hover:bg-[#181818]"
            >
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>

        <p className="flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          <LocateOff className="h-3.5 w-3.5" aria-hidden /> Location tracking: off — manual check-in
        </p>

        {canWrite ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" onClick={() => setSheet('new')} className="min-h-11 text-[14px]">
              <CalendarPlus className="h-4 w-4" aria-hidden /> New meeting
            </Button>
            <Button onClick={() => setSheet('walk-in')} className="min-h-11 text-[14px]">
              <MapPinned className="h-4 w-4" aria-hidden /> Log walk-in
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">View only: your role cannot change meetings.</p>
        )}
      </header>

      {meetings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center dark:border-[#2A2A2A] dark:bg-[#0F0F0F]">
          <p className="text-[14px] font-medium text-slate-800 dark:text-[#FAFAFA]">No meetings {date === today ? 'today' : 'on this day'}</p>
          <p className="mt-1 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
            {canWrite ? 'Plan one with New meeting, or log a walk-in when you visit a customer.' : 'Nothing is planned.'}
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {meetings.map((m) => (
            <li key={m.id}>
              <MeetingCard
                meeting={m}
                userId={userId}
                ownersInScope={ownersInScope}
                canWrite={canWrite}
                highlighted={m.id === highlightId}
                onChanged={refresh}
              />
            </li>
          ))}
        </ol>
      )}

      {sheet === 'new' ? (
        <FieldSheet title="New meeting" onClose={() => setSheet(null)}>
          <MeetingForm
            defaultOwnerId={userId}
            ownersInScope={ownersInScope}
            onSaved={(m) => {
              setSheet(null);
              if (m.ownerId !== userId) {
                toast.success('Meeting planned for your rep');
                return;
              }
              toast.success('Meeting planned');
              const on = todayInTz(tz, new Date(m.startAt));
              if (on === date) refresh();
              else router.push(`${dayHref(on)}${on === today ? '?' : '&'}m=${m.id}`);
            }}
          />
        </FieldSheet>
      ) : null}
      {sheet === 'walk-in' ? (
        <WalkInDialog
          onClose={() => setSheet(null)}
          onSaved={(id) => {
            setSheet(null);
            router.push(`/dashboard/field/my-day?m=${id}`);
          }}
        />
      ) : null}
    </main>
  );
}
