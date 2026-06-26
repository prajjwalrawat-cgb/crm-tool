import 'server-only';

import { clerkClient } from '@/lib/auth/server';
import { eq } from 'drizzle-orm';

import { memberships, type MembershipRole } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Lightweight teammate picker source — returns the union of:
 *   1. Local `memberships` rows for the active tenant (source of truth
 *      for who's actually a member of this CRM tenant).
 *   2. Seeded actors from the Test 1 fixture, so the owner picker on
 *      that tenant offers Priya / Rahul / Sarah / etc. without those
 *      ids needing to be real Clerk users.
 *
 * Clerk hydrates the local membership ids with `firstName`,
 * `lastName`, `imageUrl`, `primaryEmailAddress`. Failures fall through
 * gracefully — the picker shows raw ids rather than crashing.
 */

export type Teammate = {
  id: string;
  displayName: string;
  email: string | null;
  imageUrl: string | null;
  /** Membership role in the tenant, for assign-permission filtering. */
  role: MembershipRole | null;
  /** "seed" for the demo personas, "user" for real Clerk users. */
  source: 'seed' | 'user';
};

// Same persona pool the seed script writes. Kept duplicated here (a
// short list, not worth a shared import that would pull node-only
// scripts into the app bundle). If you edit one, edit both.
const SEED_PERSONAS: Teammate[] = [
  { id: 'seed-actor-priya-sharma',    displayName: 'Priya Sharma',   email: 'priya.sharma@test1.example',   imageUrl: null, role: 'member', source: 'seed' },
  { id: 'seed-actor-rahul-mehta',     displayName: 'Rahul Mehta',    email: 'rahul.mehta@test1.example',    imageUrl: null, role: 'member', source: 'seed' },
  { id: 'seed-actor-meera-iyer',      displayName: 'Meera Iyer',     email: 'meera.iyer@test1.example',     imageUrl: null, role: 'member', source: 'seed' },
  { id: 'seed-actor-arjun-rao',       displayName: 'Arjun Rao',      email: 'arjun.rao@test1.example',      imageUrl: null, role: 'member', source: 'seed' },
  { id: 'seed-actor-sarah-chen',      displayName: 'Sarah Chen',     email: 'sarah.chen@test1.example',     imageUrl: null, role: 'member', source: 'seed' },
  { id: 'seed-actor-michael-torres',  displayName: 'Michael Torres', email: 'michael.torres@test1.example', imageUrl: null, role: 'member', source: 'seed' },
  { id: 'seed-actor-emma-wilson',     displayName: 'Emma Wilson',    email: 'emma.wilson@test1.example',    imageUrl: null, role: 'member', source: 'seed' },
];

/**
 * Return the picker list for the active tenant. The seeded personas
 * are included when the tenant is "Test 1" so the demo tenant has a
 * realistic team to assign to; real tenants get only their actual
 * Clerk org members.
 */
export async function listTeammates(
  tenantId: string,
  tenantName: string,
): Promise<Teammate[]> {
  const localRows = await tenantTransaction(async (tx) =>
    tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId)),
  );

  const realIds = localRows.map((r) => r.userId);
  const roleByUser = new Map(localRows.map((r) => [r.userId, r.role]));
  const realTeammates: Teammate[] = [];

  if (realIds.length > 0) {
    try {
      const client = await clerkClient();
      const userList = await client.users.getUserList({
        userId: realIds,
        limit: 500,
      });
      for (const u of userList.data) {
        const parts = [u.firstName, u.lastName].filter(Boolean) as string[];
        realTeammates.push({
          id: u.id,
          displayName:
            parts.length > 0
              ? parts.join(' ')
              : u.primaryEmailAddress?.emailAddress ?? u.id,
          email: u.primaryEmailAddress?.emailAddress ?? null,
          imageUrl: u.imageUrl ?? null,
          role: roleByUser.get(u.id) ?? null,
          source: 'user',
        });
      }
    } catch {
      // Tolerate Clerk failure — fall through with raw ids so the
      // picker still works (degraded names).
      for (const id of realIds) {
        realTeammates.push({
          id,
          displayName: id,
          email: null,
          imageUrl: null,
          role: roleByUser.get(id) ?? null,
          source: 'user',
        });
      }
    }
  }

  // Only the Test 1 demo tenant gets the seeded picker entries.
  const seedEntries = tenantName === 'Test 1' ? SEED_PERSONAS : [];

  // Dedup by id (real Clerk users take precedence over a hypothetical
  // collision with a seed prefix, even though that can't happen in
  // practice — defense in depth).
  const seen = new Set<string>();
  const merged: Teammate[] = [];
  for (const t of [...realTeammates, ...seedEntries]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push(t);
  }
  merged.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return merged;
}
