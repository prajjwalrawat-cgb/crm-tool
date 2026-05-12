import 'server-only';

import { clerkClient } from '@clerk/nextjs/server';

/**
 * Shared author/display-name resolver for notes, comments, and
 * timeline entries. Three layers, matching the activity feed's
 * defense-in-depth:
 *
 *   1. `seed-actor-<first>-<last>` ids → derive the friendly name
 *      from the id pattern itself; no Clerk call needed.
 *   2. Real Clerk user ids → one batched Clerk lookup per page.
 *   3. Anything else → falls back to "Teammate" at the call site
 *      (this function just omits the entry).
 *
 * Server-only because it imports clerkClient. Detail pages call it
 * once with a pooled id set from across notes + comments + activity.
 */
export async function resolveAuthorLookup(
  authorIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (authorIds.length === 0) return out;

  const realIds = authorIds.filter((id) => !id.startsWith('seed-actor-'));

  for (const id of authorIds) {
    if (id.startsWith('seed-actor-')) {
      const rest = id.slice('seed-actor-'.length);
      const parts = rest
        .split('-')
        .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : ''));
      out[id] = parts.join(' ');
    }
  }

  if (realIds.length > 0) {
    try {
      const client = await clerkClient();
      const list = await client.users.getUserList({
        userId: realIds,
        limit: 500,
      });
      for (const u of list.data) {
        const parts = [u.firstName, u.lastName].filter(Boolean) as string[];
        out[u.id] =
          parts.length > 0
            ? parts.join(' ')
            : u.primaryEmailAddress?.emailAddress ?? 'Teammate';
      }
    } catch {
      // Tolerate Clerk failure — caller's fallback handles missing ids.
    }
  }
  return out;
}
