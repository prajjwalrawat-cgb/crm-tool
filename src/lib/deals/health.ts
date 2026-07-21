/**
 * Deal "health" signal rendered as a colored left border on kanban/list
 * cards. Computed server-side (see `shapeDealRow` / `loadSerializedDeal`)
 * and shipped as a precomputed enum on the deal object so the client never
 * recomputes it — the card just reads `deal.health`.
 *
 *   on_track — last activity < 7 days AND close date not overdue  (green)
 *   stale    — last activity 7–14 days                            (yellow)
 *   at_risk  — last activity > 14 days OR close date passed        (red)
 *
 * "Last activity" uses the deal's `updatedAt` — every logged call/meeting,
 * stage move, field edit, or owner change bumps it, so it tracks real
 * engagement without a second query. Closed deals (won/lost) get 'on_track'
 * as a neutral value; the card renders them with their own stage border.
 */
export type DealHealth = 'on_track' | 'stale' | 'at_risk';

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

export function computeDealHealth(input: {
  updatedAt: Date | string;
  expectedCloseDate: string | null;
  stage: string;
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: Date;
}): DealHealth {
  const now = input.now ?? new Date();
  const isClosed = input.stage === 'won' || input.stage === 'lost';
  if (isClosed) return 'on_track';

  // A passed close date on an open deal is an immediate red flag.
  if (input.expectedCloseDate) {
    const close = new Date(`${input.expectedCloseDate}T00:00:00`);
    if (close.getTime() < startOfDay(now).getTime()) return 'at_risk';
  }

  const updated =
    typeof input.updatedAt === 'string'
      ? new Date(input.updatedAt)
      : input.updatedAt;
  const days = (now.getTime() - updated.getTime()) / 86_400_000;
  if (days > 14) return 'at_risk';
  if (days >= 7) return 'stale';
  return 'on_track';
}
