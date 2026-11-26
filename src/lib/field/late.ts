/**
 * Pure, client-safe: how late a meeting's check-in was.
 *
 * Minutes from `start_at` to the first accepted check-in, when that check-in came
 * after start + the tenant's no-check-in grace (`no_checkin_grace_min`). Null when
 * on time (up to and including start + grace), not checked in, a walk-in (which
 * starts at its own check-in) or a virtual meeting (no check-in).
 */
export function lateBy(
  m: { type: 'physical' | 'virtual'; source: string; startAt: Date | string },
  firstAcceptedCheckinAt: Date | string | null | undefined,
  graceMin: number,
): number | null {
  if (m.type !== 'physical' || m.source === 'walk_in' || !firstAcceptedCheckinAt) return null;
  const late = new Date(firstAcceptedCheckinAt).getTime() - new Date(m.startAt).getTime();
  if (!Number.isFinite(late) || late <= graceMin * 60_000) return null;
  return Math.floor(late / 60_000);
}
