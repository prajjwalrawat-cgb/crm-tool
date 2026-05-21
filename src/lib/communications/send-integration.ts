import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  emailMessages,
  relationshipSignals,
  type EmailMessage,
} from '@/db/schema';
import { recordObservation } from '@/lib/agents/observations/record';
import { tenantTransaction } from '@/lib/db-context';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

import { recordCommunicationEvent } from './events/recorder';
import { attachOrCreateThread } from './threads/writer';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Wire an outbound `email_messages` row into the communication graph
 * + agent learning loop. Called from `sendEmailAction` and from the
 * automation send path.
 *
 * Steps (atomic where it matters):
 *   1. Open a tenant transaction
 *   2. Attach the message to a thread (or create one)
 *   3. Stamp `email_messages.thread_id` and `thread.last_message_id`
 *   4. Append a `communication_events` row (sent | failed)
 *   5. Bump per-entity `relationship_signals` counters
 *   6. Record an `agent_observations` row (`email.sent` | `email.failed`)
 *   7. Outside the tx: publish realtime events for the inbox + thread
 *
 * Observation outcome_score: 0.1 on a successful outbound send (small
 * positive RL signal — outbound contact is generally good for
 * relationship health), -0.2 on a failed delivery (small negative
 * signal — failed sends harm health).
 */
export async function attachOutboundMessageToThread(input: {
  tenantId: string;
  actorUserId: string;
  message: EmailMessage;
  delivery: { status: 'sent' | 'failed'; providerName: string | null; reason?: string | null };
}): Promise<{ threadId: string }> {
  const { tenantId, actorUserId, message, delivery } = input;

  const { threadId } = await tenantTransaction(async (tx) => {
    const allParticipants = [
      { address: message.sender, role: 'from' as const },
      ...message.toRecipients.map((a: string) => ({ address: a, role: 'to' as const })),
      ...message.ccRecipients.map((a: string) => ({ address: a, role: 'cc' as const })),
      ...message.bccRecipients.map((a: string) => ({ address: a, role: 'bcc' as const })),
    ];

    const result = await attachOrCreateThread(tx, {
      tenantId,
      subjectRaw: message.subject,
      entityType: message.entityType ?? null,
      entityId: message.entityId ?? null,
      participants: allParticipants,
      messagePreview: (message.textBody ?? '').slice(0, 140),
      hasAttachments: false,
      timestamp: message.createdAt,
      failedDelivery: delivery.status === 'failed',
    });

    // Stamp thread_id on the email row + last_message_id on the thread.
    await tx
      .update(emailMessages)
      .set({ threadId: result.threadId })
      .where(
        and(
          eq(emailMessages.id, message.id),
          eq(emailMessages.tenantId, tenantId),
        ),
      );

    await tx.execute(sql`
      UPDATE communication_threads
      SET last_message_id = ${message.id}::uuid,
          updated_by      = ${actorUserId},
          updated_at      = now()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${result.threadId}::uuid
    `);

    // Append the delivery event to the ledger.
    await recordCommunicationEvent(tx, {
      tenantId,
      threadId: result.threadId,
      messageId: message.id,
      eventKind: delivery.status === 'sent' ? 'sent' : 'failed',
      provider: delivery.providerName,
      metadata: {
        subject: message.subject,
        recipientCount: message.toRecipients.length,
        reason: delivery.reason ?? null,
      },
    });

    // Bump relationship_signals for the linked entity (if any).
    if (message.entityType && message.entityId) {
      await bumpRelationshipSignals(tx, {
        tenantId,
        entityType: message.entityType,
        entityId: message.entityId,
        sentAt: message.createdAt,
        delivered: delivery.status === 'sent',
      });
    }

    // Record agent observation.
    await recordObservation(tx, tenantId, actorUserId, {
      observationType: delivery.status === 'sent' ? 'email.sent' : 'email.failed',
      entityType: message.entityType ?? undefined,
      entityId: message.entityId ?? undefined,
      metadata: {
        messageId: message.id,
        threadId: result.threadId,
        provider: delivery.providerName,
        reason: delivery.reason ?? null,
      },
      outcomeScore: delivery.status === 'sent' ? 0.1 : -0.2,
    });

    return result;
  });

  // Realtime fan-out lives OUTSIDE the transaction so a subscriber's
  // failure cannot roll back the write.
  if (delivery.status === 'sent') {
    await publishRealtimeEvent(db, {
      type: 'communication.message.sent',
      tenantId,
      threadId,
      messageId: message.id,
    });
  } else {
    await publishRealtimeEvent(db, {
      type: 'communication.message.failed',
      tenantId,
      threadId,
      messageId: message.id,
      reason: delivery.reason ?? null,
    });
  }
  await publishRealtimeEvent(db, {
    type: 'communication.thread.updated',
    tenantId,
    threadId,
    lastMessageAt: message.createdAt.toISOString(),
  });

  return { threadId };
}

/**
 * UPSERT-and-bump on `relationship_signals`. We compute the new value
 * in a single SQL statement so concurrent sends don't race.
 *
 * Heuristic for `silent_days`: 0 on every fresh outbound. For inbound
 * (CP#16C-E inbound webhook integration) we'll bump differently.
 */
async function bumpRelationshipSignals(
  tx: DrizzleTx,
  input: {
    tenantId: string;
    entityType: string;
    entityId: string;
    sentAt: Date;
    delivered: boolean;
  },
): Promise<void> {
  // Insert-or-update. The atomic-update math runs in PG so concurrent
  // sends don't read-modify-write each other.
  await tx
    .insert(relationshipSignals)
    .values({
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      lastOutboundAt: input.sentAt,
      totalOutbound: 1,
      unansweredCount: input.delivered ? 1 : 0,
      silentDays: 0,
    })
    .onConflictDoUpdate({
      target: [
        relationshipSignals.tenantId,
        relationshipSignals.entityType,
        relationshipSignals.entityId,
      ],
      set: {
        lastOutboundAt: input.sentAt,
        totalOutbound: sql`${relationshipSignals.totalOutbound} + 1`,
        unansweredCount: input.delivered
          ? sql`${relationshipSignals.unansweredCount} + 1`
          : relationshipSignals.unansweredCount,
        silentDays: 0,
        updatedAt: new Date(),
      },
    });
}
