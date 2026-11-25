'use client';

import {
  AlertTriangle,
  Briefcase,
  Building2,
  CheckCircle2,
  Loader2,
  MapPin,
  MapPinned,
  User,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { MeetingStatus } from '@/db/schema/enums';
import type { DayMeeting } from '@/lib/field/day';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import { formatTimeInTz } from '../_lib/datetime';
import { STATUS_LABEL, STATUS_TONE, riskLabel } from '../_lib/labels';
import { useTenantTz } from '../_lib/tz-context';

/** A site can be pinned until the rep checks in (mirrors the service rule). */
const PINNABLE = new Set<MeetingStatus>(['planned', 'en_route', 'arrived']);

const SENTIMENT_LABEL: Record<string, string> = { positive: 'Positive', neutral: 'Neutral', negative: 'Negative' };

function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km from site` : `${Math.round(m)} m from site`;
}

function verificationText(c: DayMeeting['checkins'][number]): string {
  if (!c.accepted) return c.rejectReason === 'outside_radius' ? 'Too far from the site' : 'Rejected';
  if (c.verified) return 'Verified at site';
  if (c.overrideReason === 'site_not_geocoded') return 'Site not located';
  return c.overrideReason ? `Override: ${c.overrideReason}` : 'Not verified';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Side panel for one meeting on the manager board: links, check-in trail
 * (every attempt), MOM, risks in plain words, and "Pin site" before check-in.
 * Non-modal: the board stays usable, Escape or the close button dismiss it.
 */
export function MeetingPanel({
  meeting: m,
  repName,
  onClose,
  onChanged,
}: {
  meeting: DayMeeting;
  repName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const tz = useTenantTz();
  const ids = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const time = (d: Date | string) => formatTimeInTz(d, tz);
  const physical = m.type === 'physical';
  const canPin = physical && PINNABLE.has(m.status);

  useEffect(() => {
    closeRef.current?.focus();
  }, [m.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${ids}-title`}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-[#262626] dark:bg-[#0F0F0F]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-[#1F1F1F]">
        <div className="min-w-0">
          <p className="text-[12px] font-medium tabular-nums text-slate-500 dark:text-[#A1A1AA]">
            {repName} · {time(m.startAt)} – {time(m.endAt)}
            {m.source === 'walk_in' ? ' · Walk-in' : ''}
          </p>
          <h2 id={`${ids}-title`} className="mt-0.5 break-words text-[16px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
            {m.title}
          </h2>
          <span className={cn('mt-2 inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-medium', STATUS_TONE[m.status])}>
            {STATUS_LABEL[m.status]}
          </span>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close meeting details"
          className="-mr-1 rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-[#181818]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[13px] text-slate-700 dark:text-[#D4D4D8]">
        <Section title="Risks">
          {m.risk.reasons.length > 0 ? (
            <ul className="space-y-1.5">
              {m.risk.reasons.map((r) => (
                <li
                  key={r}
                  className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {riskLabel(r, m.risk)}
                    {r === 'travel_gap' && m.risk.estimate ? ' (estimated)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500 dark:text-[#A1A1AA]">No risks right now.</p>
          )}
        </Section>

        <Section title="Details">
          <dl className="space-y-1.5">
            <div className="flex items-center gap-2">
              <dt className="sr-only">Deal</dt>
              <Briefcase className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <dd className="min-w-0 truncate">
                {m.deal ? (
                  <Link href={`/dashboard/deals/${m.deal.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    {m.deal.name}
                  </Link>
                ) : (
                  <span className="text-slate-500 dark:text-[#A1A1AA]">No deal linked</span>
                )}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="sr-only">Contact</dt>
              <User className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <dd className="min-w-0 truncate">{m.contact?.name ?? <span className="text-slate-500 dark:text-[#A1A1AA]">No contact</span>}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="sr-only">Company</dt>
              <Building2 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <dd className="min-w-0 truncate">{m.company?.name ?? <span className="text-slate-500 dark:text-[#A1A1AA]">No company</span>}</dd>
            </div>
            {physical ? (
              <div className="flex items-start gap-2">
                <dt className="sr-only">Site</dt>
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <dd className="min-w-0 break-words">
                  {m.address?.trim() || 'No address'}
                  <span className="block text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                    {m.lat !== null && m.lng !== null
                      ? `Pinned at ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}${m.geocodeStatus === 'manual' ? ' (set by hand)' : ''}`
                      : 'Site not located yet'}
                  </span>
                </dd>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <dt className="sr-only">Meeting type</dt>
                <Video className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <dd>Virtual meeting</dd>
              </div>
            )}
          </dl>
        </Section>

        {physical ? (
          <Section title="Check-ins">
            {m.checkins.length === 0 ? (
              <p className="text-slate-500 dark:text-[#A1A1AA]">No check-in attempts yet.</p>
            ) : (
              <ol className="space-y-2">
                {m.checkins.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    {c.accepted ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 dark:text-[#FAFAFA]">
                        {c.kind === 'in' ? 'Check-in' : 'Check-out'} {c.accepted ? 'accepted' : 'rejected'}
                        <span className="font-normal tabular-nums text-slate-500 dark:text-[#A1A1AA]"> · {time(c.capturedAt)}</span>
                      </p>
                      <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                        {c.distanceFromSiteM !== null ? `${distanceText(c.distanceFromSiteM)} · ` : ''}
                        {verificationText(c)}
                        {c.accuracyM !== null ? ` · GPS ±${Math.round(c.accuracyM)} m` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        ) : null}

        <Section title="MOM">
          {m.outcome ? (
            <div className="space-y-2">
              {m.outcome.sentiment ? (
                <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                  Sentiment: <span className="font-medium text-slate-700 dark:text-[#D4D4D8]">{SENTIMENT_LABEL[m.outcome.sentiment] ?? m.outcome.sentiment}</span>
                </p>
              ) : null}
              <p className="whitespace-pre-line break-words">{m.outcome.momText?.trim() || 'No notes written.'}</p>
              {m.outcome.nextSteps.length > 0 ? (
                <div>
                  <p className="text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]">Next steps</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {m.outcome.nextSteps.map((s, i) => (
                      <li key={i} className="break-words">
                        {s.text}
                        {s.dueDate ? <span className="text-slate-500 dark:text-[#A1A1AA]"> · due {s.dueDate}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-slate-500 dark:text-[#A1A1AA]">No MOM logged yet.</p>
          )}
        </Section>

        {canPin ? <PinSite meetingId={m.id} onPinned={onChanged} /> : null}
      </div>
    </aside>
  );
}

/** "Pin site": a Google Maps link or "lat, lng". The server's message is shown on failure. */
function PinSite({ meetingId, onPinned }: { meetingId: string; onPinned: () => void }) {
  const ids = useId();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const res = await fieldApi(`/meetings/${meetingId}/site`, { body: { input: value } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setInput('');
    toast.success('Site pinned');
    onPinned();
  }

  return (
    <Section title="Pin site">
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor={`${ids}-pin`} className="block text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          Paste a Google Maps link or coordinates (lat, lng). Check-ins are measured from this point.
        </label>
        <div className="flex gap-2">
          <input
            id={`${ids}-pin`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="28.5355, 77.3910"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids}-err` : undefined}
            className={cn(inputCls, 'h-9 flex-1 text-[13px]')}
          />
          <Button type="submit" variant="primary" disabled={busy || !input.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPinned className="h-4 w-4" aria-hidden />}
            Pin site
          </Button>
        </div>
        {error ? (
          <p id={`${ids}-err`} role="alert" className="text-[12px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </form>
    </Section>
  );
}
