'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import type { MeetingNextStep } from '@/db/schema';
import type { MeetingSentiment } from '@/db/schema/enums';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import type { GeoPosition } from '../_lib/geolocate';
import { usePosition } from '../_lib/use-position';
import { FieldSheet } from './field-sheet';
import { PositionPrompt } from './position-prompt';

type Step = { action: string; dueDate: string };
type Draft = { momText: string; sentiment: MeetingSentiment | null; steps: Step[] };

const SENTIMENTS: Array<[MeetingSentiment, string]> = [
  ['positive', 'Positive'],
  ['neutral', 'Neutral'],
  ['negative', 'Negative'],
];

const fieldCls = cn(inputCls, 'min-h-10 text-[14px] sm:text-[13px]');
/** Per user and meeting (`<userId>:<meetingId>`): a shared device never shows one rep another's draft. */
const draftKey = (id: string) => `field:mom-draft:${id}`;

function loadDraft(id: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function clearDraft(id: string) {
  try {
    window.localStorage.removeItem(draftKey(id));
  } catch {
    // Storage blocked: nothing to clear.
  }
}

/**
 * Minutes of meeting: text, sentiment, optional next steps. With `checkOut`
 * ("Check out & log MOM", meeting still checked in) it reads the location
 * first and the server checks out and saves the MOM in one transaction.
 * Unsent text is kept as a local draft so a dropped connection or an
 * accidental close does not lose it.
 */
export function MomDialog({
  meetingId,
  userId,
  meetingTitle,
  existing,
  checkOut,
  onClose,
  onSaved,
}: {
  meetingId: string;
  /** The signed-in user; scopes the local draft. */
  userId: string;
  meetingTitle: string;
  existing: { momText: string | null; sentiment: MeetingSentiment | null; nextSteps: MeetingNextStep[] } | null;
  checkOut: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ids = useId();
  const draftId = `${userId}:${meetingId}`;
  const [saved] = useState<Draft>(() => ({
    momText: existing?.momText ?? '',
    sentiment: existing?.sentiment ?? null,
    steps: (existing?.nextSteps ?? []).map((s) => ({ action: s.text, dueDate: s.dueDate ?? '' })),
  }));
  const [draft, setDraft] = useState<Draft>(() => loadDraft(draftId) ?? saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const position = usePosition((pos) => void send(pos));

  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey(draftId), JSON.stringify(draft));
    } catch {
      // Storage blocked (private mode): the form still works without a draft.
    }
  }, [draft, draftId]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (i: number, patch: Partial<Step>) =>
    update({ steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  async function send(pos?: GeoPosition) {
    setBusy(true);
    setError(null);
    const res = await fieldApi(`/meetings/${meetingId}/outcome`, {
      body: {
        momText: draft.momText.trim(),
        sentiment: draft.sentiment,
        nextSteps: draft.steps
          .filter((s) => s.action.trim())
          .map((s) => ({ action: s.action.trim(), dueDate: s.dueDate || null })),
        ...(pos ? { checkOutAt: { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } } : {}),
      },
    });
    setBusy(false);
    if (!res.ok) return setError(`${res.error} Your text is kept — tap save to retry.`);
    clearDraft(draftId);
    toast.success(checkOut ? 'Checked out and MOM saved' : 'MOM saved');
    onSaved();
  }

  function submit() {
    if (!draft.momText.trim()) return setError('Write a few lines about the meeting.');
    if (checkOut) void position.locate();
    else void send();
  }

  const locating = position.state.kind === 'locating';
  const working = busy || locating;
  const close = () => {
    // Nothing typed, or nothing changed from the saved MOM: no draft to keep.
    const empty = !draft.momText.trim() && draft.steps.every((s) => !s.action.trim());
    if (empty || JSON.stringify(draft) === JSON.stringify(saved)) clearDraft(draftId);
    onClose();
  };

  return (
    <FieldSheet
      title={checkOut ? 'Check out & log MOM' : existing ? 'Edit MOM' : 'Log MOM'}
      description={meetingTitle}
      onClose={close}
      busy={working}
      footer={
        <>
          <Button onClick={close} disabled={working} className="min-h-11 px-4">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={working} className="min-h-11 px-4 text-[14px]">
            {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {checkOut ? 'Check out & save' : 'Save MOM'}
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <label htmlFor={`${ids}-mom`} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
          What happened?
        </label>
        <textarea
          id={`${ids}-mom`}
          value={draft.momText}
          onChange={(e) => update({ momText: e.target.value })}
          rows={6}
          maxLength={20_000}
          autoFocus
          placeholder="Who you met, what was discussed, objections, what they agreed to…"
          className={fieldCls}
          disabled={working}
        />
      </div>

      <fieldset className="space-y-1">
        <legend className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">How did it go?</legend>
        <div className="grid grid-cols-3 gap-2">
          {SENTIMENTS.map(([value, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={draft.sentiment === value}
              disabled={working}
              onClick={() => update({ sentiment: draft.sentiment === value ? null : value })}
              className={cn(
                'min-h-10 rounded-lg border text-[13px] font-medium transition',
                draft.sentiment === value
                  ? value === 'positive'
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : value === 'negative'
                      ? 'border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'
                      : 'border-slate-500 bg-slate-100 text-slate-800 dark:bg-[#1F1F1F] dark:text-[#FAFAFA]'
                  : 'border-slate-200 bg-white text-slate-700 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7]',
              )}
            >
              {text}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Next steps (optional)</legend>
        {draft.steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <input
              aria-label={`Next step ${i + 1}`}
              value={s.action}
              onChange={(e) => setStep(i, { action: e.target.value })}
              maxLength={500}
              placeholder="e.g. Send revised quote"
              className={cn(fieldCls, 'min-w-0 flex-1 basis-full sm:basis-auto')}
              disabled={working}
            />
            <input
              type="date"
              aria-label={`Next step ${i + 1} due date`}
              value={s.dueDate}
              onChange={(e) => setStep(i, { dueDate: e.target.value })}
              className={cn(fieldCls, 'min-w-0 flex-1 sm:w-40 sm:flex-none')}
              disabled={working}
            />
            <Button
              variant="ghost"
              aria-label={`Remove next step ${i + 1}`}
              onClick={() => update({ steps: draft.steps.filter((_, j) => j !== i) })}
              disabled={working}
              className="min-h-10"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
        {draft.steps.length < 20 ? (
          <Button
            onClick={() => update({ steps: [...draft.steps, { action: '', dueDate: '' }] })}
            disabled={working}
            className="min-h-10"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add next step
          </Button>
        ) : null}
      </fieldset>

      {checkOut ? (
        <p className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">Your location is saved with this check-out</p>
      ) : null}
      <PositionPrompt state={position.state} onRetry={() => void position.locate()} onContinue={position.accept} />

      {error ? (
        <p role="alert" className="text-[12.5px] text-rose-600">
          {error}
        </p>
      ) : null}
    </FieldSheet>
  );
}
