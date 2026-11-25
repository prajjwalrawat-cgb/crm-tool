'use client';

import { Loader2, LogIn, LogOut } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import type { GeoPosition } from '../_lib/geolocate';
import { usePosition } from '../_lib/use-position';
import { PositionPrompt } from './position-prompt';

type CheckResult = { verified: boolean; distanceM: number | null };

type Stage =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'override'; pos: GeoPosition; distanceM: number; radiusM: number }
  | { kind: 'failed'; pos: GeoPosition; message: string; overrideReason?: string };

const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/**
 * Check in / Check out with one GPS read. Flow: notice → locate (low-accuracy
 * Retry / Continue) → POST. A check-in outside the radius (422) asks for a
 * reason and resends with `overrideReason`. Failed sends keep the position so
 * Retry does not need a new fix.
 */
export function CheckinButton({
  meetingId,
  kind,
  onDone,
  primary = true,
}: {
  meetingId: string;
  kind: 'in' | 'out';
  onDone: () => void;
  primary?: boolean;
}) {
  const reasonId = useId();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [reason, setReason] = useState('');
  const position = usePosition((pos) => void send(pos));

  async function send(pos: GeoPosition, overrideReason?: string) {
    setStage({ kind: 'sending' });
    const res = await fieldApi<CheckResult>(`/meetings/${meetingId}/${kind === 'in' ? 'checkin' : 'checkout'}`, {
      body: { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM, ...(overrideReason ? { overrideReason } : {}) },
    });
    if (res.ok) {
      setStage({ kind: 'idle' });
      setReason('');
      const note = res.data.verified ? '' : ' (not verified)';
      toast.success(kind === 'in' ? `Checked in${note}` : `Checked out${note}`);
      onDone();
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
    setStage({ kind: 'failed', pos, message: res.error, overrideReason });
  }

  const busy = position.state.kind === 'locating' || stage.kind === 'sending';
  const Icon = kind === 'in' ? LogIn : LogOut;

  return (
    <div className="w-full space-y-2">
      {stage.kind !== 'override' ? (
        <>
          <Button
            variant={primary ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => {
              setStage({ kind: 'idle' });
              void position.locate();
            }}
            className="min-h-11 w-full px-4 text-[14px]"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Icon className="h-4 w-4" aria-hidden />}
            {stage.kind === 'sending' ? 'Saving…' : kind === 'in' ? 'Check in' : 'Check out'}
          </Button>
          {position.state.kind === 'idle' && stage.kind === 'idle' ? (
            <p className="text-center text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              Your location is saved with this check-{kind}
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
