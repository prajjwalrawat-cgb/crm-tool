import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  communicationParticipants,
  communicationThreads,
  type ParticipantRole,
} from '@/db/schema';

import { normalizeSubject } from './subject';

type DrizzleTx = Parameters<
  Parameters<typeof import('@/db').db.transaction>[0]
>[0];

/**
 * Upsert-or-attach a thread for an outbound message. Threading rules:
 *
 *   1. If a thread exists for `(tenant, subjectNormalized, entity?, …)`
 *      AND it has any participant overlap with the new participant set,
 *      attach to that thread.
 *   2. Otherwise, create a new thread.
 *
 * The match is intentionally conservative: subject AND participant
 * overlap. Subject alone is too greedy (a contact with the same
 * subject in two separate engagements gets crossed); participant
 * alone is too leaky (every email from CEO@foo would collapse into
 * one thread). The combination is what email clients do.
 *
 * MUST be called inside the caller's transaction so the participant
 * UPSERT and the thread INSERT/UPDATE are atomic. The realtime
 * publish (`communication.thread.updated`) is the caller's
 * responsibility — we don't fan out here.
 *
 * Idempotent on subject-only repeat sends: an already-existing thread
 * + new participant overlap will UPDATE the existing thread's
 * counters and return its id.
 */
export async function attachOrCreateThread(
  tx: DrizzleTx,
  input: {
    tenantId: string;
    subjectRaw: string;
    entityType: string | null;
    entityId: string | null;
    /** All distinct participant addresses, role-tagged. */
    participants: Array<{ address: string; role: ParticipantRole }>;
    messagePreview: string | null;
    hasAttachments: boolean;
    /** Send timestamp — used for last_message_at. */
    timestamp: Date;
    /** Mark the thread as having a failed delivery. */
    failedDelivery?: boolean;
  },
): Promise<{ threadId: string; created: boolean }> {
  const subjectNormalized = normalizeSubject(input.subjectRaw);
  const incomingAddresses = new Set(
    input.participants.map((p) => p.address.toLowerCase()),
  );

  // 1) Find candidates by subject within this tenant. Limit 25 — if
  //    a tenant has > 25 threads with the exact same normalized
  //    subject, scoring becomes meaningless and we should create
  //    fresh.
  const candidates = await tx
    .select({ id: communicationThreads.id })
    .from(communicationThreads)
    .where(
      and(
        eq(communicationThreads.tenantId, input.tenantId),
        eq(communicationThreads.subjectNormalized, subjectNormalized),
      ),
    )
    .limit(25);

  // 2) Pull participant addresses for those candidates in a single
  //    batch and check overlap.
  let matchedId: string | null = null;
  if (candidates.length > 0) {
    const candidateIds = candidates.map((c) => c.id);
    const candidateParticipants = await tx
      .select({
        threadId: communicationParticipants.threadId,
        emailAddress: communicationParticipants.emailAddress,
      })
      .from(communicationParticipants)
      .where(
        and(
          eq(communicationParticipants.tenantId, input.tenantId),
          inArray(communicationParticipants.threadId, candidateIds),
        ),
      );

    const byThread = new Map<string, Set<string>>();
    for (const cp of candidateParticipants) {
      const set = byThread.get(cp.threadId) ?? new Set<string>();
      set.add(cp.emailAddress.toLowerCase());
      byThread.set(cp.threadId, set);
    }
    for (const [threadId, set] of byThread.entries()) {
      for (const addr of incomingAddresses) {
        if (set.has(addr)) {
          matchedId = threadId;
          break;
        }
      }
      if (matchedId) break;
    }
  }

  // 3a) Match → UPDATE counters / preview / last_message_at.
  if (matchedId) {
    await tx
      .update(communicationThreads)
      .set({
        messagePreview: input.messagePreview,
        hasAttachments: sql`${communicationThreads.hasAttachments} OR ${input.hasAttachments}`,
        lastMessageAt: input.timestamp,
        messageCount: sql`${communicationThreads.messageCount} + 1`,
        failedCount: input.failedDelivery
          ? sql`${communicationThreads.failedCount} + 1`
          : communicationThreads.failedCount,
        updatedAt: input.timestamp,
      })
      .where(
        and(
          eq(communicationThreads.tenantId, input.tenantId),
          eq(communicationThreads.id, matchedId),
        ),
      );

    // Make sure every new participant is registered. UPSERT is on
    // the (tenant, thread, address, role) unique constraint.
    await upsertParticipants(tx, input.tenantId, matchedId, input.participants);
    return { threadId: matchedId, created: false };
  }

  // 3b) No match → INSERT a new thread row.
  const [created] = await tx
    .insert(communicationThreads)
    .values({
      tenantId: input.tenantId,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      subjectRaw: input.subjectRaw,
      subjectNormalized,
      messagePreview: input.messagePreview,
      hasAttachments: input.hasAttachments,
      lastMessageAt: input.timestamp,
      messageCount: 1,
      failedCount: input.failedDelivery ? 1 : 0,
    })
    .returning({ id: communicationThreads.id });

  if (!created) {
    throw new Error('thread INSERT returned no row (RLS?)');
  }

  await upsertParticipants(
    tx,
    input.tenantId,
    created.id,
    input.participants,
  );
  return { threadId: created.id, created: true };
}

async function upsertParticipants(
  tx: DrizzleTx,
  tenantId: string,
  threadId: string,
  participants: Array<{ address: string; role: ParticipantRole }>,
): Promise<void> {
  if (participants.length === 0) return;

  // Build rows; de-dup at the (address, role) level so duplicate
  // CCs in one send don't violate the unique index.
  const seen = new Set<string>();
  const rows = [] as Array<{
    tenantId: string;
    threadId: string;
    emailAddress: string;
    participantRole: string;
  }>;
  for (const p of participants) {
    const addr = p.address.trim().toLowerCase();
    if (!addr) continue;
    const key = `${addr}:${p.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      tenantId,
      threadId,
      emailAddress: addr,
      participantRole: p.role,
    });
  }
  if (rows.length === 0) return;

  await tx
    .insert(communicationParticipants)
    .values(rows)
    .onConflictDoNothing({
      target: [
        communicationParticipants.tenantId,
        communicationParticipants.threadId,
        communicationParticipants.emailAddress,
        communicationParticipants.participantRole,
      ],
    });
}
