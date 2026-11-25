'use client';

import { AlertTriangle, Building2, Briefcase, CheckCircle2, MapPin, Navigation, NotebookPen, User, Video } from 'lucide-react';
import { useState } from 'react';

import type { DayMeeting } from '@/lib/field/day';
import { cn } from '@/lib/utils';

import { Button } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import { formatTimeInTz } from '../_lib/datetime';
import { STATUS_LABEL, STATUS_TONE, riskLabel } from '../_lib/labels';
import { directionsUrl } from '../_lib/maps-link';
import { useTenantTz } from '../_lib/tz-context';
import { CheckinButton } from './checkin-button';
import { MomDialog } from './mom-dialog';

const PRE_CHECKIN = new Set(['planned', 'en_route', 'arrived']);
const SAFE_LINK = /^https?:\/\//i;

const actionCls = 'min-h-11 flex-1 px-4 text-[14px]';

/**
 * One meeting on the rep's day: time, status and risk chips, links, the
 * check-in trail, and the next action for its status. Read-only when
 * `canWrite` is false (viewers).
 */
export function MeetingCard({
  meeting: m,
  canWrite,
  highlighted,
  onChanged,
}: {
  meeting: DayMeeting;
  canWrite: boolean;
  highlighted: boolean;
  onChanged: () => void;
}) {
  const tz = useTenantTz();
  const [mom, setMom] = useState<null | { checkOut: boolean }>(null);
  const time = (d: Date | string) => formatTimeInTz(d, tz);

  const physical = m.type === 'physical';
  const nav = physical ? directionsUrl(m) : null;
  const joinUrl = !physical && m.virtualUrl && SAFE_LINK.test(m.virtualUrl) ? m.virtualUrl : null;
  const lastIn = [...m.checkins].reverse().find((c) => c.kind === 'in' && c.accepted);
  const lastOut = [...m.checkins].reverse().find((c) => c.kind === 'out');
  const cancelled = m.status === 'cancelled';

  function navigate() {
    // Fire-and-forget: the Maps app opens either way. keepalive lets it land after the tab is backgrounded.
    if (!canWrite || m.status !== 'planned') return;
    void fieldApi(`/meetings/${m.id}/en-route`, { keepalive: true }).then((r) => r.ok && onChanged());
  }

  return (
    <article
      id={`meeting-${m.id}`}
      className={cn(
        'scroll-mt-20 rounded-xl border bg-white p-4 shadow-sm transition dark:bg-[#0F0F0F]',
        m.risk.reasons.length > 0 ? 'border-amber-300 dark:border-amber-700/60' : 'border-slate-200 dark:border-[#262626]',
        highlighted && 'ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-black',
        cancelled && 'opacity-60',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium tabular-nums text-slate-500 dark:text-[#A1A1AA]">
            {time(m.startAt)} – {time(m.endAt)}
            {m.source === 'walk_in' ? ' · Walk-in' : ''}
          </p>
          <h2 className="mt-0.5 break-words text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">{m.title}</h2>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-medium', STATUS_TONE[m.status])}>
          {STATUS_LABEL[m.status]}
        </span>
      </header>

      {m.risk.reasons.length > 0 && !cancelled ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Risks">
          {m.risk.reasons.map((r) => (
            <li
              key={r}
              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {riskLabel(r, m.risk)}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="mt-3 space-y-1.5 text-[13px] text-slate-700 dark:text-[#D4D4D8]">
        {m.company ? (
          <div className="flex items-center gap-2">
            <dt className="sr-only">Company</dt>
            <Building2 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <dd className="min-w-0 truncate">{m.company.name}</dd>
          </div>
        ) : null}
        {m.contact ? (
          <div className="flex items-center gap-2">
            <dt className="sr-only">Contact</dt>
            <User className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <dd className="min-w-0 truncate">{m.contact.name}</dd>
          </div>
        ) : null}
        {m.deal ? (
          <div className="flex items-center gap-2">
            <dt className="sr-only">Deal</dt>
            <Briefcase className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <dd className="min-w-0 truncate">{m.deal.name}</dd>
          </div>
        ) : m.needsLinking ? (
          <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            <dt className="sr-only">Deal</dt>
            <Briefcase className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
            <dd>Not linked to a deal yet</dd>
          </div>
        ) : null}
        {physical ? (
          <div className="flex items-start gap-2">
            <dt className="sr-only">Address</dt>
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <dd className="min-w-0 break-words">{m.address?.trim() || 'No address yet'}</dd>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <dt className="sr-only">Meeting type</dt>
            <Video className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <dd>Virtual meeting</dd>
          </div>
        )}
      </dl>

      {lastIn || lastOut ? (
        <p className="mt-2 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          {lastIn ? (
            <>
              Checked in {time(lastIn.capturedAt)}
              {lastIn.verified ? ' · at site' : lastIn.overrideReason === 'site_not_geocoded' ? ' · site not pinned' : ' · not verified'}
            </>
          ) : null}
          {lastIn && lastOut ? ' · ' : null}
          {lastOut ? <>Checked out {time(lastOut.capturedAt)}</> : null}
        </p>
      ) : null}

      {m.outcome?.momText ? (
        <div className="mt-3 rounded-lg bg-emerald-50/60 p-3 text-[12.5px] text-slate-700 dark:bg-emerald-500/5 dark:text-[#D4D4D8]">
          <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> MOM
            {m.outcome.sentiment ? <span className="font-normal text-slate-500">· {m.outcome.sentiment}</span> : null}
          </p>
          <p className="mt-1 line-clamp-3 whitespace-pre-line break-words">{m.outcome.momText}</p>
        </div>
      ) : null}

      {!cancelled ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {nav ? (
            <a
              href={nav}
              target="_blank"
              rel="noopener noreferrer"
              onClick={navigate}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-[14px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7]"
            >
              <Navigation className="h-4 w-4" aria-hidden /> Navigate
            </a>
          ) : null}
          {joinUrl ? (
            <a
              href={joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-[14px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7]"
            >
              <Video className="h-4 w-4" aria-hidden /> Join
            </a>
          ) : null}

          {canWrite && physical && PRE_CHECKIN.has(m.status) ? (
            <div className="w-full sm:w-auto sm:flex-1">
              <CheckinButton meetingId={m.id} kind="in" onDone={onChanged} />
            </div>
          ) : null}

          {canWrite && m.status === 'checked_in' ? (
            <>
              <Button variant="primary" onClick={() => setMom({ checkOut: true })} className={actionCls}>
                <NotebookPen className="h-4 w-4" aria-hidden /> Check out & log MOM
              </Button>
              <div className="w-full sm:w-auto sm:flex-1">
                <CheckinButton meetingId={m.id} kind="out" onDone={onChanged} primary={false} />
              </div>
            </>
          ) : null}

          {canWrite && (m.status === 'checked_out' || (!physical && m.status === 'planned')) ? (
            <Button variant="primary" onClick={() => setMom({ checkOut: false })} className={actionCls}>
              <NotebookPen className="h-4 w-4" aria-hidden /> Log MOM
            </Button>
          ) : null}

          {canWrite && m.status === 'mom_logged' ? (
            <Button variant="ghost" onClick={() => setMom({ checkOut: false })} className="min-h-10 px-3">
              <NotebookPen className="h-4 w-4" aria-hidden /> Edit MOM
            </Button>
          ) : null}
        </div>
      ) : m.cancelReason ? (
        <p className="mt-2 text-[12px] text-slate-500 dark:text-[#A1A1AA]">Cancelled: {m.cancelReason}</p>
      ) : null}

      {mom ? (
        <MomDialog
          meetingId={m.id}
          meetingTitle={m.title}
          existing={m.outcome ? { momText: m.outcome.momText, sentiment: m.outcome.sentiment, nextSteps: m.outcome.nextSteps } : null}
          checkOut={mom.checkOut}
          onClose={() => setMom(null)}
          onSaved={() => {
            setMom(null);
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}
