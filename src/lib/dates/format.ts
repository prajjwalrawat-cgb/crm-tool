/**
 * Deterministic date formatters. The whole point of this module is to
 * be safe to call from BOTH server and client and always produce the
 * same output. Hydration mismatches caused by `Intl.DateTimeFormat`
 * picking up the browser's locale / timezone, or by `Date.now()`
 * differing between SSR and hydration, are the bug class this guards
 * against.
 *
 * Rules:
 *   - All formatters lock to `en-US` locale.
 *   - All formatters lock to `UTC` timezone. This means the rendered
 *     timestamp is the UTC clock, NOT the user's local clock — that's
 *     a deliberate trade. Rendering local time requires either passing
 *     the timezone through as a prop (which we currently don't track
 *     per user) or rendering on the client only. For audit / activity
 *     contexts we'd rather show one consistent clock than risk a
 *     mismatch.
 *   - `formatRelativeTime` requires an explicit `now`. Callers that
 *     want "live" relative time (e.g. "5m ago" updating) should use
 *     the `<RelativeTime />` component, which renders the absolute
 *     date during SSR and swaps to relative after hydration.
 *
 * Any new date formatting should go through this module — bare
 * `toLocaleString()` calls reintroduce the hydration risk and should
 * be avoided.
 */

const FULL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const DATE_SHORT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

const TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

function toDate(input: Date | string | number): Date {
  return input instanceof Date ? input : new Date(input);
}

/** "May 14, 2026, 5:32 PM" — full date + time, used for tooltips and detail rows. */
export function formatDateTime(input: Date | string | number): string {
  return FULL_FORMATTER.format(toDate(input));
}

/** "May 14, 2026" — date only. */
export function formatDate(input: Date | string | number): string {
  return DATE_FORMATTER.format(toDate(input));
}

/** "May 14" — short date for compact UIs. */
export function formatDateShort(input: Date | string | number): string {
  return DATE_SHORT_FORMATTER.format(toDate(input));
}

/** "5:32 PM" — time only. */
export function formatTime(input: Date | string | number): string {
  return TIME_FORMATTER.format(toDate(input));
}

/** Locale-stable number formatting; defaults to integer grouping. */
export function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

/**
 * Relative time from `now`. Pure function — `now` is REQUIRED so
 * server and client get identical output for the same inputs.
 *
 * Output: "just now" / "5m ago" / "3h ago" / "2d ago" / "May 14"
 * (after a week, falls back to the short date formatter).
 */
export function formatRelativeTime(
  input: Date | string | number,
  now: Date | number,
): string {
  const date = toDate(input);
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const diff = Math.max(0, nowMs - date.getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDateShort(date);
}
