/**
 * Minimal header probe for call recordings: format, channel count and sample
 * rate, read from the first bytes only (no decoder, no ffprobe dependency).
 *
 * - WAV: RIFF/WAVE `fmt ` chunk (channels at +10, sample rate at +12).
 * - MP3: skips an ID3v2 tag, finds the first frame sync and reads the MPEG
 *   version, sample-rate index and channel mode (11 = mono, else 2 channels).
 *
 * Anything else returns channels = null and callers treat it as mono.
 */

export type AudioProbe = {
  format: 'wav' | 'mp3' | 'unknown';
  channels: number | null;
  sampleRate: number | null;
};

const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}

function probeWav(b: Uint8Array): AudioProbe | null {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = ascii(b, off, 4);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 16 <= b.length) {
      return { format: 'wav', channels: dv.getUint16(off + 10, true), sampleRate: dv.getUint32(off + 12, true) };
    }
    off += 8 + size + (size % 2);
  }
  return { format: 'wav', channels: null, sampleRate: null };
}

function probeMp3(b: Uint8Array): AudioProbe | null {
  let off = 0;
  if (b.length >= 10 && ascii(b, 0, 3) === 'ID3') {
    // Syncsafe 28-bit size, plus 10 header bytes (+10 more if a footer flag is set).
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    off = 10 + size + (b[5]! & 0x10 ? 10 : 0);
  }
  const limit = Math.min(b.length - 4, off + 64 * 1024);
  for (let i = off; i <= limit; i++) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1]! >> 3) & 0x03; // 0 = 2.5, 1 = reserved, 2 = MPEG-2, 3 = MPEG-1
    const layer = (b[i + 1]! >> 1) & 0x03;
    const rateIdx = (b[i + 2]! >> 2) & 0x03;
    const bitrateIdx = (b[i + 2]! >> 4) & 0x0f;
    if (version === 1 || layer === 0 || rateIdx === 3 || bitrateIdx === 0x0f) continue;
    const mode = (b[i + 3]! >> 6) & 0x03;
    return { format: 'mp3', channels: mode === 3 ? 1 : 2, sampleRate: MP3_RATES[version]?.[rateIdx] ?? null };
  }
  return null;
}

export function probeAudio(bytes: Uint8Array): AudioProbe {
  return probeWav(bytes) ?? probeMp3(bytes) ?? { format: 'unknown', channels: null, sampleRate: null };
}
