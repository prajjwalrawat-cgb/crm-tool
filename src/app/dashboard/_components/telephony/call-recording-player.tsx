'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { formatDuration } from '@/lib/telephony/serialize';
import { cn } from '@/lib/utils';

/**
 * Deterministic pseudo-waveform from the call id: decoration only, it does
 * not represent the actual audio.
 */
function pseudoWaveform(seed: string): number[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < 48; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out.push(25 + ((h >>> 16) % 75) * (0.6 + 0.4 * Math.sin(i / 3)));
  }
  return out;
}

/**
 * Recording player with a "waveform-lite" scrubber. Audio comes from
 * /api/calls/:id/recording (access-checked, audit-logged, Range-capable), so
 * seeking to the middle of a long call fetches only that part.
 */
export function CallRecordingPlayer({ callId, durationSec }: { callId: string; durationSec: number | null }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(durationSec ?? 0);

  const bars = useMemo(() => pseudoWaveform(callId), [callId]);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onTime = () => setPos(a.currentTime);
    const onMeta = () => Number.isFinite(a.duration) && setDur(a.duration);
    const onEnd = () => setPlaying(false);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, []);

  function toggle() {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
  return (
    <div className="flex items-center gap-2">
      <audio ref={audio} preload="none" src={`/api/calls/${callId}/recording`} />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        className="rounded-full bg-indigo-600 p-1.5 text-white hover:bg-indigo-500"
      >
        {playing ? <Pause className="h-3 w-3" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
      </button>
      <div className="relative flex h-7 flex-1 items-center gap-[2px]">
        {bars.map((b, i) => (
          <span
            key={i}
            aria-hidden
            className={cn('w-full rounded-sm', i / bars.length <= pct ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-[#27272A]')}
            style={{ height: `${b}%` }}
          />
        ))}
        <input
          type="range"
          min={0}
          max={dur || 1}
          step={0.1}
          value={pos}
          aria-label="Seek"
          onChange={(e) => {
            const a = audio.current;
            const v = Number(e.target.value);
            if (a) a.currentTime = v;
            setPos(v);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <span className="w-20 text-right font-mono text-[11px] text-slate-500 dark:text-[#A1A1AA]">
        {formatDuration(Math.round(pos))} / {formatDuration(Math.round(dur))}
      </span>
    </div>
  );
}
