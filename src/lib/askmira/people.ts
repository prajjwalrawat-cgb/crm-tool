import 'server-only';

// AskMiraa sends the company's people (users/sync, use=provision).
//
// Saleinx admits who its own owners and admins invite, with the role they
// give: AskMiraa never adds anyone here and never changes a role. What the
// sync does:
//
// * links each active member of this workspace whose email is in AskMiraa's
//   list (askmira_people), so AskMiraa knows their role here and can sign them
//   in from AskMiraa;
// * switches off a member AskMiraa linked once who has since left the company
//   in AskMiraa (membership "suspended"; their deals and history stay). An
//   owner is never switched off. Someone AskMiraa never linked is never
//   touched;
// * switches a member back on if AskMiraa switched them off and they are in
//   the list again (rehired).
//
// The answer lists each linked member's role here, which is what AskMiraa
// offers them in its assistant.

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { askmiraPeople, memberships, users } from '@/db/schema';

import { EMAIL_RE, clean, httpError, normEmail, type Linked } from './core';

type Incoming = { id: string | null; email: string };

export async function syncPeople(found: Linked, body: Record<string, unknown>) {
  const list = Array.isArray(body.users) ? body.users : null;
  // An empty list would switch everybody off: refused, nothing changed.
  if (!list || list.length === 0) {
    throw httpError(422, 'AskMiraa sent nobody. Nothing was changed.');
  }
  const roster = new Map<string, Incoming>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const email = normEmail(item.email);
    if (EMAIL_RE.test(email)) roster.set(email, { id: clean(item.id, 64), email });
  }
  if (roster.size === 0) throw httpError(422, 'AskMiraa sent nobody with an email. Nothing was changed.');

  const tenantId = found.link.tenantId;
  const members = await db
    .select({
      userId: users.id,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId));
  const managed = new Map(
    (
      await db
        .select({ userId: askmiraPeople.userId, suspendedAt: askmiraPeople.suspendedAt })
        .from(askmiraPeople)
        .where(eq(askmiraPeople.tenantId, tenantId))
    ).map((row) => [row.userId, row]),
  );

  let linked = 0;
  let suspended = 0;
  let restored = 0;
  const kept: Array<{ email: string; role: string }> = [];
  const known = new Set<string>();
  const now = new Date();

  for (const member of members) {
    const email = normEmail(member.email);
    known.add(email);
    const incoming = roster.get(email);
    const row = managed.get(member.userId);
    if (incoming) {
      await db
        .insert(askmiraPeople)
        .values({ tenantId, userId: member.userId, askmiraUserId: incoming.id, linkedAt: now })
        .onConflictDoUpdate({
          target: [askmiraPeople.tenantId, askmiraPeople.userId],
          set: { askmiraUserId: incoming.id, suspendedAt: null },
        });
      if (!row) linked += 1;
      let status = member.status;
      // Only AskMiraa's own switch-off is undone here, never one made in Saleinx.
      if (row?.suspendedAt && member.status === 'suspended') {
        await db
          .update(memberships)
          .set({ status: 'active' })
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, member.userId)));
        status = 'active';
        restored += 1;
      }
      if (status === 'active') kept.push({ email, role: member.role });
      continue;
    }
    if (row && !row.suspendedAt && member.role !== 'owner' && member.status === 'active') {
      await db
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, member.userId)));
      await db
        .update(askmiraPeople)
        .set({ suspendedAt: now })
        .where(and(eq(askmiraPeople.tenantId, tenantId), eq(askmiraPeople.userId, member.userId)));
      suspended += 1;
    }
  }

  const outsiders = [...roster.keys()].filter((email) => !known.has(email));
  console.log(
    `[AskMiraa] people sync for ${found.workspace.name}: ${kept.length} linked, ` +
      `${suspended} switched off, ${restored} back on, ${outsiders.length} not members`,
  );
  return {
    created: 0,
    updated: linked + restored,
    deactivated: suspended,
    restored,
    not_members: outsiders.length,
    // A few, so AskMiraa can show why someone has no access; the count says the rest.
    skipped: outsiders.slice(0, 20).map((email) => ({
      email,
      reason: `Not a member of ${found.workspace.name} in Saleinx; an owner or admin there invites them.`,
    })),
    members: kept,
  };
}
