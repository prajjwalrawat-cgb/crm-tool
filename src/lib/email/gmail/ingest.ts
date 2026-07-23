import 'server-only';

import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import {
  contacts,
  deals,
  emailMessages,
  relationshipSignals,
} from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { recordCommunicationEvent } from '@/lib/communications/events/recorder';
import { attachOrCreateThread } from '@/lib/communications/threads/writer';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';
import { queueDealScoreRecompute } from '@/lib/deals/scoring/queue';

import { counterpartyAddresses, type ParsedGmailMessage } from './parse';

export type IngestResult =
  | { status: 'created'; emailId: string; entityType: 'deal' | 'contact'; entityId: string; direction: 'inbound' | 'outbound'; needsReview: boolean }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: 'no_counterparty' | 'no_contact' };

export type IngestInput = {
  tenantId: string;
  /** The CRM user who owns the connected mailbox. */
  actorUserId: string;
  mailboxEmail: string;
  excludedDomains: string[];
  excludedAddresses: string[];
  message: ParsedGmailMessage;
  direction: 'inbound' | 'outbound';
};

/**
 * Ingest ONE synced Gmail message. The privacy-critical matching gate lives
 * here: a message is written ONLY when at least one workspace contact matches a
 * counterparty address. Non-matching mail is written nowhere — not even a
 * staging row. Idempotent: a re-sync of the same Gmail message id is a no-op.
 *
 * Deal resolution per the spec:
 *   - matched contact has exactly one open deal  → attach to that deal
 *   - multiple open deals → attach to the most recently active + needs_review
 *   - zero open deals → attach to the contact record only
 *
 * On a fresh write it mirrors the outbound fan-out: email_messages row +
 * activity_logs 'email_synced' (so Module 1 gates / Module 2 scoring count it) +
 * thread attach + communication_events 'received' + relationship_signals bump,
 * then queues a deal score recompute.
 */
export async function ingestSyncedMessage(
  input: IngestInput,
): Promise<IngestResult> {
  const {
    tenantId,
    actorUserId,
    mailboxEmail,
    message,
    direction,
  } = input;

  // 1. Counterparties (everyone but us + excluded).
  const counterparties = counterpartyAddresses(message, {
    mailboxEmail,
    excludedDomains: input.excludedDomains,
    excludedAddresses: input.excludedAddresses,
  });
  if (counterparties.length === 0) {
    return { status: 'skipped', reason: 'no_counterparty' };
  }

  return tenantTransaction(async (tx) => {
    // 2. Match counterparties → workspace contacts (case-insensitive email).
    const matched = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          inArray(
            sql`lower(${contacts.email})`,
            counterparties.map((e) => e.toLowerCase()),
          ),
          isNull(contacts.deletedAt),
        ),
      );

    // 3. Non-matching mail is written NOWHERE.
    if (matched.length === 0) {
      return { status: 'skipped', reason: 'no_contact' };
    }
    const contactIds = matched.map((c) => c.id);

    // 4. Resolve the target: open deals across the matched contacts, most
    //    recently active first.
    const openDeals = await tx
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          inArray(deals.contactId, contactIds),
          notInArray(deals.stage, ['won', 'lost'] as Array<'won' | 'lost'>),
          isNull(deals.deletedAt),
        ),
      )
      .orderBy(desc(deals.updatedAt));

    let entityType: 'deal' | 'contact';
    let entityId: string;
    let needsReview = false;
    if (openDeals.length === 0) {
      entityType = 'contact';
      entityId = contactIds[0]!;
    } else {
      entityType = 'deal';
      entityId = openDeals[0]!.id;
      needsReview = openDeals.length > 1;
    }

    // 5. Idempotent write of the email_messages row.
    const senderEmail = message.from[0]?.email ?? mailboxEmail;
    const [inserted] = await tx
      .insert(emailMessages)
      .values({
        tenantId,
        actorUserId,
        provider: 'gmail',
        direction,
        status: 'delivered',
        subject: message.subject,
        // PRIVACY: only the ≤200-char snippet is stored, never the body.
        textBody: message.snippet,
        htmlBody: null,
        sender: senderEmail,
        toRecipients: message.to.map((a) => a.email),
        ccRecipients: message.cc.map((a) => a.email),
        entityType,
        entityId,
        providerMessageId: message.externalId,
        sentAt: new Date(message.timestamp),
        metadata: {
          source: 'gmail_sync',
          needsReview,
          gmailThreadId: message.threadId,
          matchedContactIds: contactIds,
        },
      })
      .onConflictDoNothing({
        target: [emailMessages.tenantId, emailMessages.providerMessageId],
        // Must exactly match the partial unique index predicate from 0051.
        where: sql`${emailMessages.provider} = 'gmail' AND ${emailMessages.providerMessageId} IS NOT NULL`,
      })
      .returning({ id: emailMessages.id });

    // Conflict → already synced. No-op (idempotent re-sync).
    if (!inserted) return { status: 'duplicate' };
    const emailId = inserted.id;

    // 6. activity_logs 'email_synced' — makes synced email count as genuine
    //    activity for gates/scoring. metadata.emailId → timeline dedups it
    //    against the email_messages row it renders.
    await recordActivity(tx, {
      tenantId,
      actorUserId,
      entityType,
      entityId,
      action: 'email_synced',
      metadata: {
        emailId,
        direction,
        subject: message.subject,
        source: 'gmail_sync',
        via: 'gmail',
        needsReview,
      },
    });

    // 7. Thread attach + event + relationship signal (mirror outbound fan-out).
    const participants = [
      { address: senderEmail, role: 'from' as const },
      ...message.to.map((a) => ({ address: a.email, role: 'to' as const })),
      ...message.cc.map((a) => ({ address: a.email, role: 'cc' as const })),
    ];
    const thread = await attachOrCreateThread(tx, {
      tenantId,
      subjectRaw: message.subject,
      entityType,
      entityId,
      participants,
      messagePreview: message.snippet.slice(0, 140),
      hasAttachments: false,
      timestamp: new Date(message.timestamp),
    });
    await tx
      .update(emailMessages)
      .set({ threadId: thread.threadId })
      .where(and(eq(emailMessages.id, emailId), eq(emailMessages.tenantId, tenantId)));

    await recordCommunicationEvent(tx, {
      tenantId,
      threadId: thread.threadId,
      messageId: emailId,
      eventKind: direction === 'inbound' ? 'received' : 'sent',
      provider: 'gmail',
      metadata: { subject: message.subject, direction, source: 'gmail_sync' },
    });

    await bumpRelationshipSignals(tx, {
      tenantId,
      entityType,
      entityId,
      at: new Date(message.timestamp),
      direction,
    });

    // 8. Module 2 downstream: refresh the deal's health score.
    if (entityType === 'deal') {
      await queueDealScoreRecompute(tenantId, entityId, 'email_synced');
    }

    return {
      status: 'created',
      emailId,
      entityType,
      entityId,
      direction,
      needsReview,
    };
  });
}

/**
 * UPSERT-and-bump relationship_signals for a synced message. Inbound sets
 * lastInboundAt / totalInbound and answers an outstanding outbound (decrement
 * unansweredCount, floored at 0). Outbound mirrors the send path.
 */
async function bumpRelationshipSignals(
  tx: DbExecutor,
  input: {
    tenantId: string;
    entityType: string;
    entityId: string;
    at: Date;
    direction: 'inbound' | 'outbound';
  },
): Promise<void> {
  if (input.direction === 'inbound') {
    await tx
      .insert(relationshipSignals)
      .values({
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        lastInboundAt: input.at,
        totalInbound: 1,
        unansweredCount: 0,
        silentDays: 0,
      })
      .onConflictDoUpdate({
        target: [
          relationshipSignals.tenantId,
          relationshipSignals.entityType,
          relationshipSignals.entityId,
        ],
        set: {
          lastInboundAt: input.at,
          totalInbound: sql`${relationshipSignals.totalInbound} + 1`,
          unansweredCount: sql`GREATEST(0, ${relationshipSignals.unansweredCount} - 1)`,
          silentDays: 0,
          updatedAt: new Date(),
        },
      });
  } else {
    await tx
      .insert(relationshipSignals)
      .values({
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        lastOutboundAt: input.at,
        totalOutbound: 1,
        unansweredCount: 1,
        silentDays: 0,
      })
      .onConflictDoUpdate({
        target: [
          relationshipSignals.tenantId,
          relationshipSignals.entityType,
          relationshipSignals.entityId,
        ],
        set: {
          lastOutboundAt: input.at,
          totalOutbound: sql`${relationshipSignals.totalOutbound} + 1`,
          unansweredCount: sql`${relationshipSignals.unansweredCount} + 1`,
          silentDays: 0,
          updatedAt: new Date(),
        },
      });
  }
}
