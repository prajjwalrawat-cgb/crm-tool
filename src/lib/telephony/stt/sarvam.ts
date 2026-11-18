import type { TranscriptSegment } from '@/db/schema/telephony';

import {
  httpError,
  mergeSegments,
  networkError,
  SttError,
  type Transcriber,
  transcriptText,
} from './core';

/**
 * Sarvam AI speech-to-text via the Batch API (docs + sarvamai SDK 1.1.7
 * source checked 2026-11-18). The synchronous `POST /speech-to-text` is meant
 * for clips under ~30 s and has no diarisation, so real calls use batch:
 *
 *   1. POST /speech-to-text/job/v1                 {job_parameters} -> job_id
 *   2. POST /speech-to-text/job/v1/upload-files    {job_id, files}  -> upload_urls[f].file_url
 *   3. PUT  <file_url>  (x-ms-blob-type: BlockBlob)                     audio bytes
 *   4. POST /speech-to-text/job/v1/{job_id}/start  {}
 *   5. GET  /speech-to-text/job/v1/{job_id}/status  until Completed | Failed
 *   6. POST /speech-to-text/job/v1/download-files  {job_id, files}  -> download_urls[f].file_url
 *   7. GET  <file_url> -> { transcript, diarized_transcript.entries[], language_code }
 *
 * Auth header `api-subscription-key`. Model `saaras:v4` (env SARVAM_STT_MODEL),
 * mode `codemix` (env SARVAM_STT_MODE) so Hinglish keeps English words in
 * English, language `unknown` = auto-detect. Up to 2 h per file.
 *
 * Sarvam merges multi-channel audio into one, so speakers always come from
 * diarisation: 'unknown' with a "Speaker N" label, never agent/customer.
 */

const BASE = 'https://api.sarvam.ai';
const FILE_NAME = 'call';

type JobStatus = {
  job_state?: 'Accepted' | 'Pending' | 'Running' | 'Completed' | 'Failed';
  error_message?: string;
  job_details?: Array<{ state?: string; error_message?: string; outputs?: Array<{ file_name: string }> }>;
};
type SarvamOutput = {
  transcript?: string;
  language_code?: string | null;
  diarized_transcript?: { entries?: Array<{ transcript: string; start_time_seconds: number; end_time_seconds: number; speaker_id: string }> };
  timestamps?: { chunks?: string[]; words?: string[]; start_time_seconds?: number[]; end_time_seconds?: number[] };
};

export function sarvamModel(): string {
  return (process.env.SARVAM_STT_MODEL ?? 'saaras:v4').trim() || 'saaras:v4';
}

function extFor(contentType: string): string {
  if (/wav/i.test(contentType)) return 'wav';
  if (/ogg|opus/i.test(contentType)) return 'ogg';
  if (/mp4|m4a|aac/i.test(contentType)) return 'm4a';
  return 'mp3';
}

/** Map Sarvam's output JSON to our segments. Exported for selftests. */
export function parseSarvamOutput(out: SarvamOutput): { segments: TranscriptSegment[]; language: string | null; durationMs: number | null } {
  const entries = out.diarized_transcript?.entries ?? [];
  let segments: TranscriptSegment[];
  if (entries.length) {
    const ids = [...new Set(entries.map((e) => e.speaker_id))];
    segments = mergeSegments([
      entries.map((e) => ({
        speaker: 'unknown' as const,
        label: `Speaker ${ids.indexOf(e.speaker_id) + 1}`,
        startMs: Math.round(e.start_time_seconds * 1000),
        endMs: Math.round(e.end_time_seconds * 1000),
        text: e.transcript ?? '',
        confidence: null,
      })),
    ]);
  } else {
    const ts = out.timestamps;
    const chunks = ts?.chunks ?? ts?.words ?? [];
    segments = chunks.length
      ? mergeSegments([
          chunks.map((c, i) => ({
            speaker: 'unknown' as const,
            startMs: Math.round((ts?.start_time_seconds?.[i] ?? 0) * 1000),
            endMs: Math.round((ts?.end_time_seconds?.[i] ?? 0) * 1000),
            text: c,
            confidence: null,
          })),
        ])
      : mergeSegments([[{ speaker: 'unknown', startMs: 0, endMs: 0, text: out.transcript ?? '', confidence: null }]]);
  }
  const durationMs = segments.length ? Math.max(...segments.map((s) => s.endMs)) || null : null;
  return { segments, language: out.language_code ?? null, durationMs };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

export const sarvamTranscriber: Transcriber = {
  name: 'sarvam',
  get model() {
    return sarvamModel();
  },
  configured: () => (process.env.SARVAM_API_KEY ?? '').trim().length > 0,
  async transcribe(audio, opts) {
    const key = (process.env.SARVAM_API_KEY ?? '').trim();
    if (!key) throw new SttError('sarvam: SARVAM_API_KEY is not set', false);
    const doFetch = opts.fetch ?? fetch;
    const model = sarvamModel();
    const pollMs = Number(process.env.SARVAM_POLL_MS ?? 3000);
    const headers = { 'api-subscription-key': key, 'Content-Type': 'application/json' };
    const fileName = `${FILE_NAME}.${extFor(audio.contentType)}`;

    const call = async <T>(step: string, url: string, init: RequestInit): Promise<T> => {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, signal: opts.signal });
      } catch (err) {
        throw networkError('sarvam', step, err);
      }
      if (!res.ok) throw await httpError('sarvam', step, res);
      try {
        return (await res.json()) as T;
      } catch {
        throw new SttError(`sarvam ${step} returned invalid JSON`, true);
      }
    };

    const init = await call<{ job_id: string }>('init', `${BASE}/speech-to-text/job/v1`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        job_parameters: {
          model,
          mode: (process.env.SARVAM_STT_MODE ?? 'codemix').trim() || 'codemix',
          language_code: (process.env.SARVAM_LANGUAGE ?? 'unknown').trim() || 'unknown',
          with_diarization: true,
          num_speakers: 2,
        },
      }),
    });
    const jobId = init.job_id;
    if (!jobId) throw new SttError('sarvam init returned no job_id', true);

    const links = await call<{ upload_urls?: Record<string, { file_url: string }> }>('upload-links', `${BASE}/speech-to-text/job/v1/upload-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_id: jobId, files: [fileName] }),
    });
    const uploadUrl = links.upload_urls?.[fileName]?.file_url;
    if (!uploadUrl) throw new SttError('sarvam upload-links returned no URL', true);

    let put: Response;
    try {
      put = await doFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': audio.contentType || 'audio/mpeg' },
        body: audio.bytes as BodyInit,
        signal: opts.signal,
      });
    } catch (err) {
      throw networkError('sarvam', 'upload', err);
    }
    if (put.status < 200 || put.status > 226) throw new SttError(`sarvam upload failed: HTTP ${put.status}`, put.status >= 500 || put.status === 429, put.status);

    await call('start', `${BASE}/speech-to-text/job/v1/${encodeURIComponent(jobId)}/start`, { method: 'POST', headers, body: '{}' });

    let status: JobStatus = {};
    for (;;) {
      status = await call<JobStatus>('status', `${BASE}/speech-to-text/job/v1/${encodeURIComponent(jobId)}/status`, {
        method: 'GET',
        headers: { 'api-subscription-key': key },
      });
      if (status.job_state === 'Completed' || status.job_state === 'Failed') break;
      try {
        await sleep(pollMs, opts.signal);
      } catch (err) {
        throw networkError('sarvam', 'status', err);
      }
    }
    const detail = status.job_details?.[0];
    if (status.job_state === 'Failed' || (detail?.state && detail.state !== 'Success')) {
      const why = (detail?.error_message ?? status.error_message ?? detail?.state ?? 'failed').slice(0, 120);
      throw new SttError(`sarvam job failed: ${why}`, /internal server error/i.test(why));
    }
    const outName = detail?.outputs?.[0]?.file_name;
    if (!outName) throw new SttError('sarvam job completed without an output file', true);

    const dl = await call<{ download_urls?: Record<string, { file_url: string }> }>('download-links', `${BASE}/speech-to-text/job/v1/download-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_id: jobId, files: [outName] }),
    });
    const outUrl = dl.download_urls?.[outName]?.file_url;
    if (!outUrl) throw new SttError('sarvam download-links returned no URL', true);
    const output = await call<SarvamOutput>('download', outUrl, { method: 'GET' });

    const parsed = parseSarvamOutput(output);
    return {
      text: transcriptText(parsed.segments),
      segments: parsed.segments,
      language: parsed.language,
      durationMs: parsed.durationMs,
      provider: 'sarvam',
      model,
      channelSeparated: false,
    };
  },
};
