/**
 * Pure self-test for call transcription (no DB, no network): provider
 * adapters against mocked HTTP, dual-channel merge, audio header probe,
 * error classification, WER.
 *
 *   tsx scripts/selftest-transcription.ts
 */
import { probeAudio } from '../src/lib/telephony/stt/audio-probe';
import { mergeSegments, SttError, transcriptText, type TranscriptSegment } from '../src/lib/telephony/stt/core';
import { buildDeepgramUrl, deepgramTranscriber, parseDeepgram } from '../src/lib/telephony/stt/deepgram';
import { parseSarvamOutput, sarvamTranscriber } from '../src/lib/telephony/stt/sarvam';
import { wordErrorRate } from '../src/lib/telephony/stt/wer';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

type Captured = { url: string; init: RequestInit };
function mockFetch(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return routes(url, init);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const roles: [TranscriptSegment['speaker'], TranscriptSegment['speaker']] = ['agent', 'customer'];
const audio = (channels: number | null) => ({ bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'audio/mpeg', channels });

async function expectError(p: Promise<unknown>): Promise<SttError | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof SttError ? err : new SttError(String(err), false);
  }
}

async function main() {
  // ------------------------------------------------------------ audio probe
  {
    const wav = new Uint8Array(44);
    const dv = new DataView(wav.buffer);
    wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    wav.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
    wav.set([...'fmt '].map((c) => c.charCodeAt(0)), 12);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); // channels
    dv.setUint32(24, 8000, true); // sample rate
    const p = probeAudio(wav);
    check('probe: stereo 8 kHz WAV', p.format === 'wav' && p.channels === 2 && p.sampleRate === 8000, p);

    const mono = probeAudio(new Uint8Array([0xff, 0xfb, 0x90, 0xc4, 0, 0, 0, 0]));
    check('probe: mono MPEG-1 L3 44.1 kHz', mono.format === 'mp3' && mono.channels === 1 && mono.sampleRate === 44100, mono);
    const stereo = probeAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]));
    check('probe: joint-stereo MP3 = 2 channels', stereo.channels === 2, stereo);

    // ID3v2 tag of 20 bytes, then an MPEG-2 (16 kHz) mono frame.
    const id3 = new Uint8Array(10 + 20 + 4);
    id3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20], 0);
    id3.set([0xff, 0xf3, 0x88, 0xc4], 30);
    const tagged = probeAudio(id3);
    check('probe: skips ID3v2, reads MPEG-2 16 kHz mono', tagged.channels === 1 && tagged.sampleRate === 16000, tagged);
    check('probe: unknown bytes -> channels null', probeAudio(new Uint8Array([1, 2, 3])).channels === null);
  }

  // ------------------------------------------------------------ merge
  {
    const agent: TranscriptSegment[] = [
      { speaker: 'agent', startMs: 0, endMs: 2000, text: 'Hello, Saleinx se bol raha hoon.', confidence: 0.9 },
      { speaker: 'agent', startMs: 2300, endMs: 4000, text: 'Do you have two minutes?', confidence: 0.8 },
      { speaker: 'agent', startMs: 9000, endMs: 10000, text: 'Great, I will send it.', confidence: 0.95 },
    ];
    const customer: TranscriptSegment[] = [
      { speaker: 'customer', startMs: 4500, endMs: 8000, text: 'Haan, budget around 12 lakh hai.', confidence: 0.7 },
      { speaker: 'customer', startMs: 8100, endMs: 8200, text: '   ', confidence: 0.1 },
    ];
    const merged = mergeSegments([customer, agent]);
    check('merge: ordered by time across channels', merged.map((s) => s.speaker).join(',') === 'agent,customer,agent', merged);
    check('merge: joins consecutive same-speaker turns under the gap', merged[0]!.text === 'Hello, Saleinx se bol raha hoon. Do you have two minutes?' && merged[0]!.endMs === 4000);
    check('merge: joined confidence is the minimum', merged[0]!.confidence === 0.8);
    check('merge: drops empty text', merged.length === 3);
    check('transcriptText: "Agent:" / "Customer:" lines', transcriptText(merged).split('\n')[1] === 'Customer: Haan, budget around 12 lakh hai.');
  }

  // ------------------------------------------------------------ deepgram
  process.env.DEEPGRAM_API_KEY = 'dg_test_key';
  {
    const url = new URL(buildDeepgramUrl({ dual: true, model: 'nova-3', language: 'multi' }));
    check('deepgram: dual -> multichannel=true, no diarize', url.searchParams.get('multichannel') === 'true' && !url.searchParams.has('diarize_model'));
    const urlMono = new URL(buildDeepgramUrl({ dual: false, model: 'nova-3', language: 'multi' }));
    check('deepgram: mono -> diarize_model=latest', urlMono.searchParams.get('diarize_model') === 'latest' && !urlMono.searchParams.has('multichannel'));

    const dualBody = {
      metadata: { duration: 12.5, channels: 2 },
      results: {
        channels: [{ detected_language: 'hi' }, {}],
        utterances: [
          { start: 4.5, end: 8, channel: 1, speaker: 0, transcript: 'Budget around 12 lakh hai.', confidence: 0.8 },
          { start: 0, end: 2, channel: 0, speaker: 0, transcript: 'Hello sir.', confidence: 0.9 },
        ],
      },
    };
    const m = mockFetch(() => json(dualBody));
    const r = await deepgramTranscriber.transcribe(audio(2), { languageHints: [], channelRoles: roles, fetch: m.fn });
    const req = m.calls[0]!;
    check('deepgram: POST with Token auth and raw audio body', req.init.method === 'POST' && (req.init.headers as Record<string, string>).Authorization === 'Token dg_test_key' && req.init.body instanceof Uint8Array);
    check('deepgram: dual-channel turns mapped to agent/customer', r!.segments.map((s) => s.speaker).join(',') === 'agent,customer', r!.segments);
    check('deepgram: duration + language + channelSeparated', r!.durationMs === 12500 && r!.language === 'hi' && r!.channelSeparated === true);
    check('deepgram: provider/model recorded', r!.provider === 'deepgram' && r!.model === 'nova-3');

    const mono = parseDeepgram(
      { results: { utterances: [{ start: 0, end: 1, speaker: 0, transcript: 'A' }, { start: 1.2, end: 2, speaker: 1, transcript: 'B' }] } },
      { dual: false, channelRoles: roles },
    );
    check('deepgram: mono diarisation -> unknown + Speaker N labels', mono.segments.every((s) => s.speaker === 'unknown') && mono.segments[1]!.label === 'Speaker 2', mono.segments);

    const e429 = await expectError(deepgramTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles, fetch: mockFetch(() => json({ err_msg: 'rate' }, 429)).fn }));
    check('deepgram: 429 is retryable', !!e429 && e429.retryable && e429.status === 429, e429?.message);
    const e400 = await expectError(deepgramTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles, fetch: mockFetch(() => json({ err_code: 'Bad Request', err_msg: 'bad audio' }, 400)).fn }));
    check('deepgram: 400 is not retryable', !!e400 && !e400.retryable, e400?.message);
    const eNet = await expectError(deepgramTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles, fetch: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch }));
    check('deepgram: timeout is retryable', !!eNet && eNet.retryable);
    check('deepgram: error messages carry no transcript text', !!e400 && !/hello|lakh/i.test(e400.message));

    delete process.env.DEEPGRAM_API_KEY;
    const noKey = await expectError(deepgramTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles }));
    check('deepgram: missing key -> non-retryable error, configured() false', !!noKey && !noKey.retryable && !deepgramTranscriber.configured());
  }

  // ------------------------------------------------------------ sarvam batch
  process.env.SARVAM_API_KEY = 'sv_test_key';
  process.env.SARVAM_POLL_MS = '1';
  {
    let polls = 0;
    const output = {
      transcript: 'x',
      language_code: 'hi-IN',
      diarized_transcript: {
        entries: [
          { transcript: 'Namaste, main Saleinx se.', start_time_seconds: 0, end_time_seconds: 2.5, speaker_id: 'SPEAKER_01' },
          { transcript: '15 December tak close karte hain.', start_time_seconds: 3, end_time_seconds: 6, speaker_id: 'SPEAKER_00' },
        ],
      },
    };
    const m = mockFetch((url, init) => {
      if (url.endsWith('/speech-to-text/job/v1') && init.method === 'POST') return json({ job_id: 'job-1', job_state: 'Accepted' });
      if (url.endsWith('/upload-files')) return json({ job_id: 'job-1', upload_urls: { 'call.mp3': { file_url: 'https://blob.example/up' } } });
      if (url === 'https://blob.example/up') return new Response(null, { status: 201 });
      if (url.endsWith('/job-1/start')) return json({ job_id: 'job-1', job_state: 'Pending' });
      if (url.endsWith('/job-1/status')) {
        polls++;
        return json(polls < 2 ? { job_state: 'Running' } : { job_state: 'Completed', job_details: [{ state: 'Success', outputs: [{ file_name: '0.json' }] }] });
      }
      if (url.endsWith('/download-files')) return json({ download_urls: { '0.json': { file_url: 'https://blob.example/out' } } });
      if (url === 'https://blob.example/out') return json(output);
      return json({ error: { message: 'unexpected ' + url } }, 404);
    });
    const r = await sarvamTranscriber.transcribe(audio(2), { languageHints: [], channelRoles: roles, fetch: m.fn });
    const urls = m.calls.map((c) => c.url.replace('https://api.sarvam.ai', ''));
    check('sarvam: init -> upload-links -> PUT -> start -> status -> download', urls[0] === '/speech-to-text/job/v1' && urls[1]!.endsWith('/upload-files') && urls[2] === 'https://blob.example/up' && urls[3]!.endsWith('/start') && urls.includes('https://blob.example/out'), urls);
    const initBody = JSON.parse(String(m.calls[0]!.init.body));
    check('sarvam: diarisation on, 2 speakers, saaras:v4', initBody.job_parameters.with_diarization === true && initBody.job_parameters.num_speakers === 2 && initBody.job_parameters.model === 'saaras:v4');
    check('sarvam: api-subscription-key header', (m.calls[0]!.init.headers as Record<string, string>)['api-subscription-key'] === 'sv_test_key');
    check('sarvam: upload is a BlockBlob PUT', m.calls[2]!.init.method === 'PUT' && (m.calls[2]!.init.headers as Record<string, string>)['x-ms-blob-type'] === 'BlockBlob');
    check('sarvam: polled until Completed', polls === 2);
    check('sarvam: diarised entries -> unknown speakers, labels by first appearance', r!.segments.length === 2 && r!.segments[0]!.label === 'Speaker 1' && r!.segments.every((s) => s.speaker === 'unknown'), r!.segments);
    check('sarvam: language + not channel-separated', r!.language === 'hi-IN' && r!.channelSeparated === false);

    const failing = mockFetch((url) => {
      if (url.endsWith('/speech-to-text/job/v1')) return json({ job_id: 'j2' });
      if (url.endsWith('/upload-files')) return json({ upload_urls: { 'call.mp3': { file_url: 'https://blob.example/up' } } });
      if (url === 'https://blob.example/up') return new Response(null, { status: 201 });
      if (url.endsWith('/start')) return json({});
      return json({ job_state: 'Failed', job_details: [{ state: 'API Error', error_message: 'Audio is corrupted' }] });
    });
    const ef = await expectError(sarvamTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles, fetch: failing.fn }));
    check('sarvam: failed job -> non-retryable error with reason', !!ef && !ef.retryable && /corrupted/.test(ef.message), ef?.message);

    const e503 = await expectError(sarvamTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles, fetch: mockFetch(() => json({ error: { code: 'unavailable' } }, 503)).fn }));
    check('sarvam: 503 on init is retryable', !!e503 && e503.retryable && e503.status === 503);

    const ctl = new AbortController();
    const hanging = mockFetch((url) => {
      if (url.endsWith('/speech-to-text/job/v1')) return json({ job_id: 'j3' });
      if (url.endsWith('/upload-files')) return json({ upload_urls: { 'call.mp3': { file_url: 'https://blob.example/up' } } });
      if (url === 'https://blob.example/up') return new Response(null, { status: 201 });
      if (url.endsWith('/start')) return json({});
      setTimeout(() => ctl.abort(), 0);
      return json({ job_state: 'Running' });
    });
    process.env.SARVAM_POLL_MS = '50';
    const eTimeout = await expectError(sarvamTranscriber.transcribe(audio(1), { languageHints: [], channelRoles: roles, fetch: hanging.fn, signal: ctl.signal }));
    check('sarvam: per-call timeout aborts polling (retryable)', !!eTimeout && eTimeout.retryable, eTimeout?.message);

    const fallback = parseSarvamOutput({ transcript: 'Only text', language_code: null });
    check('sarvam: no diarisation -> single segment from transcript', fallback.segments.length === 1 && fallback.segments[0]!.text === 'Only text');
  }

  // ------------------------------------------------------------ WER
  {
    check('wer: identical = 0', wordErrorRate('Close by 15 December.', 'close by 15 december').wer === 0);
    const w = wordErrorRate('budget is around 12 lakh', 'budget around 12 lakh rupees');
    check('wer: 1 deletion + 1 insertion over 5 words = 0.4', Math.abs(w.wer - 0.4) < 1e-9, w);
    check('wer: speaker prefixes ignored', wordErrorRate('hello sir', 'Agent: hello sir').wer === 0);
    check('wer: Devanagari tokens compare', wordErrorRate('नमस्ते सर', 'नमस्ते सर').wer === 0);
  }

  console.log(`\ntranscription selftest: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
