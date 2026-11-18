import type { DistributionStrategy } from '@/db/schema/lead-capture';

/**
 * Assignment strategies. Pure: every input (pool order, eligibility, loads,
 * profiles, rotation state) is passed in, and the pick plus the next rotation
 * state come back out. The DB engine supplies the inputs under a row lock and
 * persists the returned state.
 */

export type Candidate = {
  userId: string;
  /** Open leads assigned in the last 7 days (least_loaded / tie-break). */
  load: number;
  skills: string[];
  regions: string[];
};

export type StrategyInput = {
  strategy: DistributionStrategy;
  /** Full pool in configured order (eligible or not) — rotation order. */
  poolOrder: string[];
  /** Eligible candidates (subset of poolOrder), already filtered. */
  eligible: Candidate[];
  lastUserId: string | null;
  weights?: Record<string, number>;
  weightsState?: Record<string, number>;
  fixedOwnerId?: string;
  lead: { productInterest: string | null; city: string | null; state: string | null };
};

export type StrategyResult = {
  userId: string | null;
  reason: string;
  nextLastUserId: string | null;
  nextWeightsState: Record<string, number>;
};

const norm = (s: string) => s.trim().toLowerCase();

/** Fewest load wins; ties broken by pool order, so the result is deterministic. */
export function pickLeastLoaded(cands: Candidate[], poolOrder: string[]): Candidate | null {
  if (cands.length === 0) return null;
  const rank = new Map(poolOrder.map((u, i) => [u, i]));
  return [...cands].sort(
    (a, b) => a.load - b.load || (rank.get(a.userId) ?? 1e9) - (rank.get(b.userId) ?? 1e9),
  )[0]!;
}

/** Next eligible user after `lastUserId` in pool order, wrapping around. */
export function pickRoundRobin(
  poolOrder: string[],
  eligibleIds: Set<string>,
  lastUserId: string | null,
): string | null {
  if (poolOrder.length === 0 || eligibleIds.size === 0) return null;
  const start = lastUserId ? poolOrder.indexOf(lastUserId) : -1;
  for (let i = 1; i <= poolOrder.length; i++) {
    const u = poolOrder[(start + i + poolOrder.length) % poolOrder.length]!;
    if (eligibleIds.has(u)) return u;
  }
  return null;
}

/**
 * Smooth weighted round-robin (nginx): each eligible peer gains its weight;
 * the highest current weight wins and loses the total. Weights 5:1:1 give
 * a a b a c a a rather than a a a a a b c.
 */
export function pickSmoothWeighted(
  eligibleIds: string[],
  weights: Record<string, number>,
  state: Record<string, number>,
): { userId: string | null; state: Record<string, number> } {
  const next: Record<string, number> = { ...state };
  let total = 0;
  let best: string | null = null;
  for (const u of eligibleIds) {
    const w = Math.max(0, Math.floor(weights[u] ?? 1));
    if (w === 0) continue;
    next[u] = (next[u] ?? 0) + w;
    total += w;
    if (best === null || next[u]! > next[best]!) best = u;
  }
  if (best !== null) next[best] = next[best]! - total;
  return { userId: best, state: next };
}

export function runStrategy(input: StrategyInput): StrategyResult {
  const { strategy, poolOrder, eligible, lastUserId, lead } = input;
  const keep = {
    nextLastUserId: lastUserId,
    nextWeightsState: input.weightsState ?? {},
  };
  if (eligible.length === 0) {
    return { userId: null, reason: 'no eligible user', ...keep };
  }
  const eligibleIds = new Set(eligible.map((c) => c.userId));

  switch (strategy) {
    case 'round_robin': {
      const u = pickRoundRobin(poolOrder, eligibleIds, lastUserId);
      return { userId: u, reason: 'round robin', nextLastUserId: u ?? lastUserId, nextWeightsState: keep.nextWeightsState };
    }
    case 'weighted': {
      const ordered = poolOrder.filter((u) => eligibleIds.has(u));
      const r = pickSmoothWeighted(ordered, input.weights ?? {}, input.weightsState ?? {});
      return { userId: r.userId, reason: 'weighted round robin', nextLastUserId: r.userId ?? lastUserId, nextWeightsState: r.state };
    }
    case 'least_loaded': {
      const c = pickLeastLoaded(eligible, poolOrder);
      return { userId: c?.userId ?? null, reason: `least loaded (${c?.load ?? 0} open)`, ...keep };
    }
    case 'skill_match': {
      const want = lead.productInterest ? norm(lead.productInterest) : null;
      const matched = want
        ? eligible.filter((c) =>
            c.skills.some((s) => {
              const k = norm(s);
              return k && (want.includes(k) || k.includes(want));
            }),
          )
        : [];
      const c = pickLeastLoaded(matched, poolOrder);
      return c
        ? { userId: c.userId, reason: `skill match on "${lead.productInterest}"`, ...keep }
        : { userId: null, reason: want ? `no one skilled in "${lead.productInterest}"` : 'lead has no product interest', ...keep };
    }
    case 'geo_match': {
      const places = [lead.city, lead.state].filter((p): p is string => !!p).map(norm);
      const matched = eligible.filter((c) => c.regions.some((r) => places.includes(norm(r))));
      const c = pickLeastLoaded(matched, poolOrder);
      return c
        ? { userId: c.userId, reason: `region match on ${[lead.city, lead.state].filter(Boolean).join(', ')}`, ...keep }
        : { userId: null, reason: places.length ? 'no one covers this region' : 'lead has no city/state', ...keep };
    }
    case 'fixed_owner': {
      const u = input.fixedOwnerId && eligibleIds.has(input.fixedOwnerId) ? input.fixedOwnerId : null;
      return { userId: u, reason: u ? 'fixed owner' : 'fixed owner not eligible', ...keep };
    }
    default:
      return { userId: null, reason: `unknown strategy ${String(strategy)}`, ...keep };
  }
}
