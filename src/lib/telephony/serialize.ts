import type { CallAiSummary, CallDisposition, CallRow, CallStatus } from '@/db/schema/telephony';

/**
 * The ONLY shape a call leaves the server in. The provider recording URL and
 * our storage key are internal and are deliberately not copied: clients get
 * `hasRecording` and fetch audio through /api/calls/:id/recording, which
 * checks access and streams our stored copy.
 */
export type SerializedCall = {
  id: string;
  direction: 'outbound' | 'inbound';
  status: CallStatus;
  leadId: string | null;
  contactId: string | null;
  userId: string | null;
  fromNumber: string;
  toNumber: string;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  talkTimeSec: number | null;
  hasRecording: boolean;
  disposition: CallDisposition | null;
  notes: string | null;
  callbackAt: string | null;
  transcript: string | null;
  aiSummary: CallAiSummary | null;
  aiSummaryStatus: CallRow['aiSummaryStatus'];
  followUpTaskId: string | null;
  campaignId: string | null;
  createdAt: string;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function serializeCall(row: CallRow, opts: { includeTranscript?: boolean } = {}): SerializedCall {
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    leadId: row.leadId,
    contactId: row.contactId,
    userId: row.userId,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    startedAt: iso(row.startedAt),
    answeredAt: iso(row.answeredAt),
    endedAt: iso(row.endedAt),
    durationSec: row.durationSec,
    talkTimeSec: row.talkTimeSec,
    hasRecording: !!row.recordingStorageKey,
    disposition: row.disposition,
    notes: row.notes,
    callbackAt: iso(row.callbackAt),
    transcript: opts.includeTranscript ? row.transcript : null,
    aiSummary: row.aiSummary ?? null,
    aiSummaryStatus: row.aiSummaryStatus,
    followUpTaskId: row.followUpTaskId,
    campaignId: row.campaignId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return '0s';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export const DISPOSITION_LABELS: Record<CallDisposition, string> = {
  connected: 'Connected',
  not_reachable: 'Not reachable',
  callback: 'Call back',
  interested: 'Interested',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  do_not_call: 'Do not call',
  skipped: 'Skipped',
};
