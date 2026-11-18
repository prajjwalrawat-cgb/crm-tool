'use client';

import { AlertTriangle, CalendarPlus, ChevronDown, Loader2, RotateCw, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { CallAiSummary, TranscriptSegment, TranscriptStatus } from '@/db/schema/telephony';
import { DISPOSITION_LABELS } from '@/lib/telephony/serialize';

import { acceptCallFollowUp, retryCallTranscription } from '../../telephony/actions';

const SPEAKER_TONE: Record<TranscriptSegment['speaker'], string> = {
  agent: 'text-indigo-700 dark:text-indigo-300',
  customer: 'text-emerald-700 dark:text-emerald-300',
  unknown: 'text-slate-700 dark:text-[#E4E4E7]',
};

function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`;
}

function speakerName(s: TranscriptSegment): string {
  if (s.speaker === 'agent') return 'Agent';
  if (s.speaker === 'customer') return 'Customer';
  return s.label ?? 'Speaker';
}

/** Speaker turns with timestamps; falls back to the plain transcript. */
function TranscriptTurns({ segments, transcript }: { segments: TranscriptSegment[] | null; transcript: string }) {
  if (!segments?.length) {
    return <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-slate-600 dark:text-[#A1A1AA]">{transcript}</pre>;
  }
  const unlabelled = segments.every((s) => s.speaker === 'unknown');
  return (
    <div className="mt-1 max-h-72 space-y-1.5 overflow-auto">
      {unlabelled ? (
        <p className="text-[10px] text-slate-400">Speakers were separated automatically; the app can&apos;t tell which one is the agent.</p>
      ) : null}
      {segments.map((s, i) => (
        <p key={i} className="text-slate-600 dark:text-[#A1A1AA]">
          <span className="mr-1 font-mono text-[10px] text-slate-400">{clock(s.startMs)}</span>
          <span className={`mr-1 font-semibold ${SPEAKER_TONE[s.speaker]}`}>{speakerName(s)}:</span>
          {s.text}
        </p>
      ))}
    </div>
  );
}

/** Collapsed-by-default AI summary + transcript turns + one-click follow-up + transcription state. */
export function CallSummaryCard({
  callId,
  summary,
  transcript,
  segments = null,
  transcriptStatus = null,
  transcriptError = null,
  hasRecording = false,
  followUpTaskId,
}: {
  callId: string;
  summary: CallAiSummary | null;
  transcript: string | null;
  segments?: TranscriptSegment[] | null;
  transcriptStatus?: TranscriptStatus | null;
  transcriptError?: string | null;
  hasRecording?: boolean;
  followUpTaskId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [accepted, setAccepted] = useState(!!followUpTaskId);
  const [pending, startTransition] = useTransition();
  const [retrying, startRetry] = useTransition();
  const router = useRouter();

  const showState =
    hasRecording && !transcript && (transcriptStatus === 'pending' || transcriptStatus === 'failed' || transcriptStatus === 'skipped');
  if (!summary && !transcript && !showState) return null;

  const retry = () =>
    startRetry(async () => {
      const r = await retryCallTranscription(callId);
      if (!r.ok) return void toast.error(r.message);
      toast.success('Transcription queued');
      router.refresh();
    });

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/60 text-[12px] dark:border-[#1F1F1F] dark:bg-[#0F0F0F]">
      {summary ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-medium text-slate-700 dark:text-[#E4E4E7]"
          >
            <Sparkles className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
            AI summary
            <span className="ml-1 rounded bg-white px-1.5 text-[10px] text-slate-500 ring-1 ring-slate-200 dark:bg-black dark:ring-[#1F1F1F]">
              {summary.sentiment}
            </span>
            <ChevronDown className={`ml-auto h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          {open ? (
            <div className="space-y-2 border-t border-slate-200 px-2.5 py-2 dark:border-[#1F1F1F]">
              <p className="text-slate-700 dark:text-[#E4E4E7]">{summary.summary}</p>
              {summary.next_steps.length ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Next steps</p>
                  <ul className="ml-4 list-disc text-slate-600 dark:text-[#A1A1AA]">
                    {summary.next_steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {summary.objections.length ? (
                <p className="text-slate-600 dark:text-[#A1A1AA]">
                  <span className="font-medium">Objections:</span> {summary.objections.join('; ')}
                </p>
              ) : null}
              {summary.competitor_mentions.length ? (
                <p className="text-slate-600 dark:text-[#A1A1AA]">
                  <span className="font-medium">Competitors:</span> {summary.competitor_mentions.join(', ')}
                </p>
              ) : null}
              <p className="text-[11px] text-slate-400">
                Suggested disposition: {summary.suggested_disposition === 'unclear' ? 'unclear' : DISPOSITION_LABELS[summary.suggested_disposition]} · AI-generated from the transcript; check before relying on it.
              </p>
              {summary.follow_up_date ? (
                <button
                  type="button"
                  disabled={accepted || pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await acceptCallFollowUp(callId);
                      if (!r.ok) return void toast.error(r.message);
                      setAccepted(true);
                      toast.success('Follow-up task created');
                      router.refresh();
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-500/30 dark:bg-black dark:text-indigo-300"
                >
                  {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <CalendarPlus className="h-3 w-3" aria-hidden />}
                  {accepted ? `Follow-up task added (${summary.follow_up_date})` : `Accept follow-up task for ${summary.follow_up_date}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {transcript ? (
        <div className="border-t border-slate-200 px-2.5 py-1.5 dark:border-[#1F1F1F]">
          <button type="button" onClick={() => setShowTranscript((v) => !v)} className="text-[11px] font-medium text-slate-500 hover:text-slate-800">
            {showTranscript ? 'Hide transcript' : 'Show transcript'}
          </button>
          {showTranscript ? <TranscriptTurns segments={segments} transcript={transcript} /> : null}
        </div>
      ) : null}
      {showState ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]" role="status">
          {transcriptStatus === 'pending' ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Transcribing…
            </>
          ) : (
            <>
              <AlertTriangle className={`h-3 w-3 ${transcriptStatus === 'failed' ? 'text-rose-500' : 'text-amber-500'}`} aria-hidden />
              <span>
                {transcriptStatus === 'failed' ? 'Transcription failed' : 'Not transcribed'}
                {transcriptError ? `: ${transcriptError}` : null}
              </span>
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="ml-auto inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:bg-black dark:text-[#E4E4E7]"
              >
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RotateCw className="h-3 w-3" aria-hidden />}
                Retry
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
