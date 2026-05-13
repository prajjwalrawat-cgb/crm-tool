import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { emailMessages, type EmailMessage } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { incr, observe } from '@/lib/observability';

import { getEmailProvider, getSenderIdentity } from './providers/factory';

/**
 * High-level send pipeline. Owns the state machine
 * (queued → sending → sent/failed), idempotency, retry counting,
 * and metric emission. Callers (server actions, workflows) hand off
 * the row id; we hydrate, validate, dispatch, and reconcile the
 * status in one place.
 */

export type SendOutcome =
  | {
      status: 'sent';
      providerMessageId: string | null;
      providerName: string;
    }
  | {
      status: 'failed';
      reason: string;
      retryable: boolean;
      providerName: string;
    };

/**
 * Attempt delivery of a single queued email row. Caller must have
 * already INSERTed the row in the same tenant transaction.
 *
 * The row stays in 'sending' for the duration of the provider call
 * — if the process dies mid-flight, a future retry worker can
 * detect orphans by querying status='sending' AND updated_at older
 * than ~5 minutes.
 */
export async function deliverEmail(
  tenantId: string,
  emailId: string,
): Promise<SendOutcome> {
  const provider = getEmailProvider();
  const sender = getSenderIdentity();
  const startedAt = Date.now();

  // Mark the row as in-flight before we touch the network. This
  // protects against double-sends if the same row gets picked up
  // twice (the next attempt sees status='sending' and bails).
  const row = await tenantTransaction(async (tx) => {
    const [r] = await tx
      .update(emailMessages)
      .set({
        status: 'sending',
        provider: provider.name,
        sender,
      })
      .where(
        and(
          eq(emailMessages.id, emailId),
          eq(emailMessages.tenantId, tenantId),
          eq(emailMessages.status, 'queued'),
        ),
      )
      .returning();
    return r ?? null;
  });

  if (!row) {
    // Already moved past 'queued' — either someone else picked it up
    // or it's already terminal. Look up and surface the terminal
    // state instead of double-sending.
    const [existing] = await tenantTransaction(async (tx) =>
      tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.id, emailId),
            eq(emailMessages.tenantId, tenantId),
          ),
        )
        .limit(1),
    );
    if (!existing) {
      return {
        status: 'failed',
        reason: 'Email row not found',
        retryable: false,
        providerName: provider.name,
      };
    }
    if (existing.status === 'sent' || existing.status === 'delivered') {
      return {
        status: 'sent',
        providerMessageId: existing.providerMessageId,
        providerName: existing.provider,
      };
    }
    return {
      status: 'failed',
      reason:
        existing.error ?? `Email was already in '${existing.status}' state`,
      retryable: false,
      providerName: existing.provider,
    };
  }

  const result = await provider.send({
    from: sender,
    to: row.toRecipients,
    cc: row.ccRecipients,
    bcc: row.bccRecipients,
    subject: row.subject,
    text: row.textBody,
    html: row.htmlBody,
    idempotencyKey: row.idempotencyKey ?? row.id,
  });

  observe('email.send_duration_ms', Date.now() - startedAt, {
    provider: provider.name,
    status: result.status,
  });

  if (result.status === 'accepted') {
    await tenantTransaction(async (tx) => {
      await tx
        .update(emailMessages)
        .set({
          status: 'sent',
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          error: null,
        })
        .where(
          and(
            eq(emailMessages.id, emailId),
            eq(emailMessages.tenantId, tenantId),
          ),
        );
    });
    incr('email.sent', 1, { provider: provider.name });
    return {
      status: 'sent',
      providerMessageId: result.providerMessageId,
      providerName: provider.name,
    };
  }

  await tenantTransaction(async (tx) => {
    await tx
      .update(emailMessages)
      .set({
        status: 'failed',
        error: result.reason,
        failedAt: new Date(),
        retryCount: sql`${emailMessages.retryCount} + 1`,
      })
      .where(
        and(
          eq(emailMessages.id, emailId),
          eq(emailMessages.tenantId, tenantId),
        ),
      );
  });
  incr('email.failed', 1, {
    provider: provider.name,
    retryable: String(result.retryable),
  });
  return {
    status: 'failed',
    reason: result.reason,
    retryable: result.retryable,
    providerName: provider.name,
  };
}

/**
 * Orphan-recovery helper. Selects rows stuck in 'sending' for too
 * long — useful as the body of a future cron. Not wired up yet;
 * exporting the predicate keeps the contract obvious if anyone adds
 * the cron later.
 */
export function staleSendingPredicate(staleMinutes: number) {
  return and(
    eq(emailMessages.status, 'sending'),
    isNull(emailMessages.sentAt),
    sql`${emailMessages.updatedAt} < NOW() - (${staleMinutes}::int * INTERVAL '1 minute')`,
  );
}

export type EmailMessageDTO = EmailMessage;
