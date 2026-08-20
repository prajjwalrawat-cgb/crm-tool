/**
 * The `?view=` contract — who a dashboard is scoped to.
 *
 * Pure and client-safe (the filter components need the type). Shared
 * by `/dashboard` and `/dashboard/executive` so the two parse the URL
 * identically; a second hand-rolled copy of this parser is exactly how
 * one view would end up honouring a scope the other ignores.
 *
 * SECURITY NOTE, carried over from the original parser: the userId is
 * left as an opaque string and is NOT checked against the tenant's
 * membership list here. It doesn't need to be. Every downstream query
 * filters on `tenant_id` first and adds `owner_id = <this>` second, so
 * a hand-typed `?view=rep:someone-elses-id` returns an empty funnel
 * rather than another tenant's data. Persona is resolved server-side
 * before this is even consulted, so a sales user cannot reach the
 * manager surface by guessing a param.
 */

export type ViewScope = { mode: 'team' } | { mode: 'rep'; userId: string };

/** Longest plausible external user id (Clerk ids are ~32 chars). */
const MAX_USER_ID_LENGTH = 128;

/**
 * `?view=team` (default) or `?view=rep:<userId>`. Anything else falls
 * back to team — a hand-edited URL should degrade to the safe, wider
 * view rather than throw.
 */
export function parseViewScope(
  raw: string | string[] | undefined,
): ViewScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return { mode: 'team' };
  if (value === 'team') return { mode: 'team' };
  if (value.startsWith('rep:')) {
    const userId = value.slice(4).trim();
    if (userId.length > 0 && userId.length <= MAX_USER_ID_LENGTH) {
      return { mode: 'rep', userId };
    }
  }
  return { mode: 'team' };
}

/** The owner id to filter deal queries by. `null` = org-wide. */
export function scopeOwnerId(scope: ViewScope): string | null {
  return scope.mode === 'rep' ? scope.userId : null;
}

/** Serialize back into the `view` param value. */
export function viewScopeParam(scope: ViewScope): string {
  return scope.mode === 'rep' ? `rep:${scope.userId}` : 'team';
}
