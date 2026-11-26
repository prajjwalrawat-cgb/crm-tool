'use client';

import { Clock, Loader2, LogIn, LogOut, MapPinCheck } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { verifyTooFarText } from '@/lib/field/verification';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import { checkinGateLabel } from '../_lib/checkin-gate';
import { formatTimeInTz } from '../_lib/datetime';
import type { GeoPosition } from '../_lib/geolocate';
import { useTenantTz } from '../_lib/tz-context';
import { usePosition } from '../_lib/use-position';
import { PositionPrompt } from './position-prompt';

type CheckResult = { verified: boolean; distanceM: number | null };

type Stage =
  | { kind: 'idle' }
  | { kind: 'sending' }
  /** Saved: stays disabled until the parent re-renders (router.refresh swaps the card). */
  | { kind: 'done' }
  | { kind: 'override'; pos: GeoPosition; distanceM: number; radiusM: number }
  /** The server refused: outside the check-in time window (422 outside_window). */
  | { kind: 'window'; label: string }
  /** Verify only: still outside the radius (422 outside_radius). No override. */
  | { kind: 'far'; message: string }
  | { kind: 'failed'; pos: GeoPosition; message: string; overrideReason?: string };

const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

const ENDPOINT = { in: 'checkin', out: 'checkout', verify: 'verify' } as const;
const LABEL = {
  in: { idle: 'Check in', done: 'Checked in', note: 'Your location is saved with this check-in' },
  out: { idle: 'Check out', done: 'Checked out', note: 'Your location is saved with this check-out' },
  verify: { idle: 'Verify location', done: 'Verified', note: 'Your location is saved with this verification' },
} as const;

/**
 * Check in / Check out / Verify location with one GPS read. Flow: notice → locate (low-accuracy
 * Retry / Continue) → POST. A check-in outside the radius (422) asks for a
 * reason and resends with `overrideReason`. Failed sends keep the position so
 * Retry does not need a new fix. A check-in outside its time window (the
 * server's `checkinOpensAt` / `checkinClosesAt`) is disabled with the opening
 * or closing time, re-checked every minute. Verify location (checked in,
 * not verified) has no override: outside the radius it says how far the rep
 * still is and offers Retry.
 */
export function CheckinButton({
  meetingId,
  kind,
  onDone,
  primary = true,
  window: win,
}: {
  meetingId: string;
  kind: 'in' | 'out' | 'verify';
  onDone: () => void;
  primary?: boolean;
  /** Check-in only: the window from DayMeeting (ISO). */
  window?: { opensAt: string; closesAt: string };
}) {
  const reasonId = useId();
  const tz = useTenantTz();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [now, setNow] = useState(() => new Date());
  const opensAt = win?.opensAt;
  const closesAt = win?.closesAt;
  useEffect(() => {
    if (kind !== 'in' || !opensAt || !closesAt) return;
    // Each minute: re-evaluate the window and drop a stale server refusal.
    const t = setInterval(() => {
      setNow(new Date());
      setStage((s) => (s.kind === 'window' ? { kind: 'idle' } : s));
    }, 60_000);
    return () => clearInterval(t);
  }, [kind, opensAt, closesAt]);
  const gate = kind === 'in' ? checkinGateLabel(opensAt, closesAt, now, tz) : null;
  const [reason, setReason] = useState('');
  const position = usePosition((pos) => void send(pos));

  async function send(pos: GeoPosition, overrideReason?: string) {
    setStage({ kind: 'sending' });
    const res = await fieldApi<CheckResult>(`/meetings/${meetingId}/${ENDPOINT[kind]}`, {
      body: { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM, ...(overrideReason ? { overrideReason } : {}) },
    });
    if (res.ok) {
      setStage({ kind: 'done' });
      setReason('');
      const note = res.data.verified ? '' : ' (not verified)';
      toast.success(kind === 'verify' ? "Verified — you're on site." : kind === 'in' ? `Checked in${note}` : `Checked out${note}`);
      onDone();
      return;
    }
    if (kind === 'in' && res.code === 'outside_window') {
      const at = new Date();
      const o = String(res.body.opensAt ?? '');
      const c = String(res.body.closesAt ?? '');
      setNow(at);
      // Server clock is the authority: if ours still thinks the window is open, pick by which end is nearer.
      const label =
        checkinGateLabel(o, c, at, tz) ??
        (o && c
          ? at.getTime() < new Date(c).getTime() - (new Date(c).getTime() - new Date(o).getTime()) / 2
            ? `Check-in opens at ${formatTimeInTz(o, tz)}`
            : `Check-in closed at ${formatTimeInTz(c, tz)}`
          : res.error);
      setStage({ kind: 'window', label });
      return;
    }
    if (kind === 'in' && res.code === 'outside_radius') {
      setStage({
        kind: 'override',
        pos,
        distanceM: Number(res.body.distanceM ?? 0),
        radiusM: Number(res.body.radiusM ?? 0),
      });
      return;
    }
    if (kind === 'verify' && res.code === 'outside_radius') {
      setStage({ kind: 'far', message: verifyTooFarText(Number(res.body.distanceM ?? 0), Number(res.body.radiusM ?? 0)) });
      return;
    }
    setStage({ kind: 'failed', pos, message: res.error, overrideReason });
  }

  const busy = position.state.kind === 'locating' || stage.kind === 'sending';
  const done = stage.kind === 'done';
  const blocked = gate ?? (stage.kind === 'window' ? stage.label : null);
  const Icon = kind === 'in' ? LogIn : kind === 'out' ? LogOut : MapPinCheck;

  return (
    <div className="w-full space-y-2">
      {stage.kind !== 'override' ? (
        <>
          <Button
            variant={primary ? 'primary' : 'secondary'}
            disabled={busy || done || blocked !== null}
            title={blocked ?? undefined}
            onClick={() => {
              setStage({ kind: 'idle' });
              void position.locate();
            }}
            className="min-h-11 w-full px-4 text-[14px]"
          >
            {blocked !== null && !busy ? (
              <Clock className="h-4 w-4" aria-hidden />
            ) : busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Icon className="h-4 w-4" aria-hidden />}
            {blocked !== null && !busy
              ? blocked
              : stage.kind === 'sending'
              ? 'Saving…'
              : done
                ? LABEL[kind].done
                : LABEL[kind].idle}
          </Button>
          {position.state.kind === 'idle' && stage.kind === 'idle' && blocked === null ? (
            <p className="text-center text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              {LABEL[kind].note}
            </p>
          ) : null}
        </>
      ) : null}

      <PositionPrompt state={position.state} onRetry={() => void position.locate()} onContinue={position.accept} />

      {stage.kind === 'failed' ? (
        <div role="alert" className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12.5px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-200">
          <p>{stage.message}</p>
          <Button onClick={() => void send(stage.pos, stage.overrideReason)} className="min-h-10 px-4">
            Retry
          </Button>
        </div>
      ) : null}

      {stage.kind === 'far' ? (
        <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-100">
          <p>{stage.message}</p>
          <Button
            onClick={() => {
              setStage({ kind: 'idle' });
              void position.locate();
            }}
            className="min-h-10 px-4"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {stage.kind === 'override' ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="font-medium">
            You are {fmtM(stage.distanceM)} from the meeting site (check-in radius {fmtM(stage.radiusM)}).
          </p>
          <label htmlFor={reasonId} className="block">
            Why are you checking in from here? Your manager will see this.
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            autoFocus
            placeholder="e.g. Client moved the meeting to their other office"
            className={cn(inputCls, 'text-[14px] sm:text-[13px]')}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!reason.trim()}
              onClick={() => void send(stage.pos, reason.trim())}
              className="min-h-10 px-4"
            >
              Check in anyway
            </Button>
            <Button
              onClick={() => {
                setStage({ kind: 'idle' });
                void position.locate();
              }}
              className="min-h-10 px-4"
            >
              Try location again
            </Button>
            <Button variant="ghost" onClick={() => setStage({ kind: 'idle' })} className="min-h-10 px-4">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
