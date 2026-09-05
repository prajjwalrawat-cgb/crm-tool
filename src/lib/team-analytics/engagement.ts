/**
 * ENGAGEMENT — how much a rep is actually working the pipeline, as
 * distinct from what they have closed.
 *
 * Pure + client-safe. The scorecard renders these on the server; the
 * self-test drives them directly.
 *
 * ---------------------------------------------------------------
 * WHAT THESE NUMBERS ARE AND ARE NOT
 * ---------------------------------------------------------------
 * Every figure here is an ACTIVITY count. Activity is not achievement,
 * and a scorecard that ranks on it will get exactly what it measures —
 * deals logged to top the "new deals this week" column. So:
 *
 *   * The cadence figures (deals added per week, best week) are reported
 *     alongside the revenue those deals carry, never on their own.
 *   * Silence is reported as a COUNT OF DEALS not touched, not as a
 *     judgement of the rep. "6 open deals untouched for 14+ days" is
 *     actionable; "engagement score 42" is not.
 *   * There is no composite index. Two reps with the same made-up score
 *     can need opposite conversations, and the composite hides which.
 *
 * `deals.updated_at` is the freshness signal, matching `getStaleDeals`
 * on the dashboard so the two surfaces can't disagree about what stale
 * means. It moves on ANY write to the row, which overstates attention
 * slightly (a bulk owner change touches everything) and understates it
 * never — a deal with a recent note but no field change still reads as
 * stale. The complementary signal, the rep's own last logged activity,
 * is reported next to it rather than merged into it.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Days without a write before an open deal counts as untouched. Same
 * default as the dashboard's stale-deal widget and the stale-deals
 * report — deliberately one number across all three.
 */
export const STALE_DEAL_DAYS = 14;

/** Days of total silence from a rep before the row is flagged. */
export const SILENT_REP_DAYS = 7;

export type ActivityBand = 'active' | 'quiet' | 'silent';

/**
 * How long since this rep last touched any deal they own.
 * `null` days (no owned deals, or none ever updated) is its own case —
 * "no deals" is not "silent", and colouring it red would be a lie.
 */
export function activityBand(daysSinceLastTouch: number | null): ActivityBand | null {
  if (daysSinceLastTouch == null) return null;
  if (daysSinceLastTouch <= 2) return 'active';
  if (daysSinceLastTouch < SILENT_REP_DAYS) return 'quiet';
  return 'silent';
}

export const ACTIVITY_BAND_LABELS: Record<ActivityBand, string> = {
  active: 'Active',
  quiet: 'Quiet',
  silent: 'Silent',
};

/** Whole days between two moments, floored at 0. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Whole weeks in a window, floored at 1 — the denominator for "deals per
 * week". Floored so a window shorter than a week reports the count itself
 * rather than a per-week figure inflated by dividing by a fraction.
 */
export function weeksIn(from: Date, to: Date): number {
  return Math.max(1, Math.floor((to.getTime() - from.getTime()) / (7 * MS_PER_DAY)));
}

const weekFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * "Week of Aug 18" for a Monday-anchored week start. Postgres'
 * `date_trunc('week', …)` anchors on Monday, which is what the query
 * returns and what this formats — no second week convention anywhere.
 */
export function weekLabel(weekStartISO: string | null): string {
  if (!weekStartISO) return '—';
  const d = new Date(weekStartISO);
  if (Number.isNaN(d.getTime())) return '—';
  return `Week of ${weekFormatter.format(d)}`;
}

/** "3d ago" / "just now" / "never". Day precision is all this deserves. */
export function agoLabel(days: number | null): string {
  if (days == null) return 'never';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/**
 * The one-line note under a rep's silence figure. Null when nothing is
 * untouched — a clean row stays clean, the same contract the targets
 * card's footnotes use.
 */
export function silenceNote(
  staleCount: number,
  openCount: number,
  oldestUntouchedDays: number | null,
): string | null {
  if (staleCount <= 0 || openCount <= 0) return null;
  const oldest =
    oldestUntouchedDays != null ? `, oldest ${oldestUntouchedDays}d` : '';
  return `${staleCount} of ${openCount} open ${
    openCount === 1 ? 'deal' : 'deals'
  } untouched ${STALE_DEAL_DAYS}+ days${oldest}`;
}
