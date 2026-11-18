import { config } from 'dotenv';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

config({ path: '.env.local' });
config();

/**
 * Compare speech-to-text providers on YOUR recordings.
 *
 *   pnpm stt:eval -- --dir ./recordings [--providers sarvam,deepgram] [--out results.json] [--save-transcripts ./out]
 *
 * For every audio file in --dir (.mp3 .wav .m4a .ogg .opus .flac), runs each
 * provider that has its API key set (SARVAM_API_KEY, DEEPGRAM_API_KEY) and
 * prints latency, audio length, word count, estimated cost and, when a
 * reference transcript `<same name>.txt` sits next to the audio, WER.
 *
 * Cost: set STT_COST_PER_MIN_SARVAM / STT_COST_PER_MIN_DEEPGRAM to your
 * contracted per-minute rate (any currency; shown as-is). Without them the
 * cost column is "n/a". Rates are not hard-coded because they change.
 *
 * Privacy: audio goes to each provider you run. Transcripts are printed only
 * when --save-transcripts is given (written to that folder, not stdout).
 * This script never touches the database.
 */

const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.flac']);
const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Row = {
  file: string;
  provider: string;
  model: string;
  channels: number | null;
  audioSec: number | null;
  latencyMs: number;
  words: number;
  segments: number;
  speakerSeparated: boolean;
  cost: number | null;
  wer: number | null;
  error: string | null;
};

async function main() {
  const dir = arg('dir');
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error('usage: pnpm stt:eval -- --dir <folder of recordings> [--providers sarvam,deepgram] [--out results.json] [--save-transcripts <folder>]');
    process.exit(2);
  }
  const { listTranscribers, channelRolesFromEnv, LANGUAGE_HINTS } = await import('../src/lib/telephony/transcriber');
  const { probeAudio } = await import('../src/lib/telephony/stt/audio-probe');
  const { wordErrorRate, normaliseForWer } = await import('../src/lib/telephony/stt/wer');

  const wanted = arg('providers')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const providers = listTranscribers().filter((t) => (!wanted || wanted.includes(t.name)) && t.configured());
  if (providers.length === 0) {
    console.error('No provider configured. Set SARVAM_API_KEY and/or DEEPGRAM_API_KEY (and check --providers).');
    process.exit(2);
  }
  const saveDir = arg('save-transcripts');
  if (saveDir) mkdirSync(saveDir, { recursive: true });

  const files = readdirSync(dir).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort();
  if (files.length === 0) {
    console.error(`No audio files in ${dir}.`);
    process.exit(2);
  }
  console.log(`${files.length} recording(s) x ${providers.map((p) => p.name).join(', ')}\n`);

  const timeoutMs = Number(process.env.TELEPHONY_STT_TIMEOUT_MS ?? 600_000);
  const rows: Row[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const bytes = new Uint8Array(readFileSync(path));
    const probe = probeAudio(bytes.subarray(0, 128 * 1024));
    const refPath = join(dir, `${basename(f, extname(f))}.txt`);
    const reference = existsSync(refPath) ? readFileSync(refPath, 'utf8') : null;
    for (const p of providers) {
      const t0 = Date.now();
      try {
        const r = await p.transcribe(
          { bytes, contentType: MIME[extname(f).toLowerCase()] ?? 'application/octet-stream', channels: probe.channels },
          { languageHints: LANGUAGE_HINTS, channelRoles: channelRolesFromEnv(), signal: AbortSignal.timeout(timeoutMs) },
        );
        const latencyMs = Date.now() - t0;
        const text = r?.text ?? '';
        const audioSec = r?.durationMs != null ? r.durationMs / 1000 : null;
        const rate = Number(process.env[`STT_COST_PER_MIN_${p.name.toUpperCase()}`]);
        rows.push({
          file: f,
          provider: p.name,
          model: r?.model ?? p.model,
          channels: probe.channels,
          audioSec,
          latencyMs,
          words: normaliseForWer(text).length,
          segments: r?.segments.length ?? 0,
          speakerSeparated: r?.channelSeparated ?? false,
          cost: Number.isFinite(rate) && rate > 0 && audioSec != null ? (audioSec / 60) * rate : null,
          wer: reference != null ? wordErrorRate(reference, text).wer : null,
          error: null,
        });
        if (saveDir) writeFileSync(join(saveDir, `${basename(f, extname(f))}.${p.name}.txt`), text, 'utf8');
      } catch (err) {
        rows.push({
          file: f,
          provider: p.name,
          model: p.model,
          channels: probe.channels,
          audioSec: null,
          latencyMs: Date.now() - t0,
          words: 0,
          segments: 0,
          speakerSeparated: false,
          cost: null,
          wer: null,
          error: (err as Error).message.slice(0, 120),
        });
      }
      const last = rows[rows.length - 1]!;
      console.log(`  ${f} · ${p.name}: ${last.error ? `ERROR ${last.error}` : `${(last.latencyMs / 1000).toFixed(1)}s, ${last.words} words${last.wer != null ? `, WER ${(last.wer * 100).toFixed(1)}%` : ''}`}`);
    }
  }

  const fmt = (n: number | null, d = 1, suffix = '') => (n == null ? 'n/a' : `${n.toFixed(d)}${suffix}`);
  console.log('\nPer recording');
  console.table(
    rows.map((r) => ({
      file: r.file,
      provider: r.provider,
      ch: r.channels ?? '?',
      'audio s': fmt(r.audioSec),
      'latency s': fmt(r.latencyMs / 1000),
      words: r.words,
      turns: r.segments,
      'agent/customer': r.speakerSeparated ? 'yes' : 'no',
      cost: r.cost == null ? 'n/a' : r.cost.toFixed(3),
      WER: r.wer == null ? 'n/a' : `${(r.wer * 100).toFixed(1)}%`,
      error: r.error ?? '',
    })),
  );

  console.log('Per provider');
  console.table(
    providers.map((p) => {
      const mine = rows.filter((r) => r.provider === p.name);
      const ok = mine.filter((r) => !r.error);
      const wers = ok.map((r) => r.wer).filter((w): w is number => w != null);
      const costs = ok.map((r) => r.cost).filter((c): c is number => c != null);
      const audio = ok.reduce((a, r) => a + (r.audioSec ?? 0), 0);
      const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
      return {
        provider: p.name,
        model: p.model,
        ok: `${ok.length}/${mine.length}`,
        'audio min': (audio / 60).toFixed(1),
        'median latency s': lat.length ? (lat[Math.floor(lat.length / 2)]! / 1000).toFixed(1) : 'n/a',
        'mean WER': wers.length ? `${((wers.reduce((a, w) => a + w, 0) / wers.length) * 100).toFixed(1)}% (${wers.length} refs)` : 'n/a',
        'total cost': costs.length === ok.length && costs.length ? costs.reduce((a, c) => a + c, 0).toFixed(2) : 'n/a',
      };
    }),
  );

  const out = arg('out');
  if (out) {
    writeFileSync(out, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`wrote ${out}`);
  }
}

main().catch((err) => {
  console.error('stt-eval fatal:', err);
  process.exit(1);
});
