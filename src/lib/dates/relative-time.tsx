'use client';

import { useEffect, useState } from 'react';

import { formatDateTime, formatRelativeTime } from './format';

/**
 * Hydration-safe relative-time renderer. Renders the absolute date on
 * the server (no `Date.now()` involved, so server and client render
 * the same string) and after mount swaps to a live-updating relative
 * time. The tooltip always shows the absolute UTC timestamp for
 * unambiguous reference.
 *
 * Why this exists: a bare `formatRelativeTime(date)` call returns
 * "5m ago" on the server (computed at SSR time) and "6m ago" on the
 * client (computed at hydration time), which trips React's hydration
 * mismatch warning. This component eliminates the mismatch by holding
 * relative-time computation until after hydration.
 */
export function RelativeTime({
  date,
  /** How often to recompute on the client. Default 60s — relative time changes by minute. */
  intervalMs = 60_000,
  className,
}: {
  date: Date | string | number;
  intervalMs?: number;
  className?: string;
}) {
  // `null` means "we haven't hydrated yet" — keep SSR-stable absolute
  // output until then.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  const absolute = formatDateTime(date);
  const display = now === null ? absolute : formatRelativeTime(date, now);

  return (
    <time
      dateTime={
        date instanceof Date
          ? date.toISOString()
          : new Date(date).toISOString()
      }
      title={absolute}
      className={className}
    >
      {display}
    </time>
  );
}
