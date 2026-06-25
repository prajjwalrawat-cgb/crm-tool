import 'server-only';

import { and, eq } from 'drizzle-orm';
import { auth, clerkClient } from '@/lib/auth/server';

import { emailMessages } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import {
  getEmailProvider,
  getSenderIdentity,
} from '@/lib/email/providers/factory';
import { deliverEmail } from '@/lib/email/sender';
import { captureError, logger } from '@/lib/observability';

/**
 * Best-effort automated email send for operational events (owner
 * reassignment, task assignment, etc.). Differs from the user-driven
 * `sendEmailAction` in three ways:
 *
 *   1. Caller doesn't need a user session — looks up the recipient's
 *      email from Clerk directly using their user id.
 *   2. Never throws. A failure is captured and logged but the caller's
 *      business operation always completes. This is the email-layer
 *      analog to `recordNotificationSafe()`.
 *   3. Provider-mode aware. When `EMAIL_PROVIDER=console` (dev), the
 *      send is logged and treated as success without producing an
 *      email_messages row — automation noise stays out of the dev DB.
 *
 * Use sparingly: every call results in real outbound traffic in
 * production. Bulk operations (e.g. mass owner reassignment) should
 * coalesce into a single digest rather than calling this in a loop.
 */
export type AutomatedEmailInput = {
  tenantId: string;
  /** Clerk user id of the recipient. We look up their email from Clerk. */
  recipientUserId: string;
  /** Clerk user id of whoever triggered the event (for activity attribution). Null = system. */
  actorUserId: string | null;
  subject: string;
  textBody: string;
  /** Entity the email should attach to in the timeline. Required because
   * email_messages has a non-null tenant_id link semantic — emails always
   * surface against one record. */
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
  /** Free-form metadata for the row; merged with `{ automation: true }`. */
  metadata?: Record<string, unknown>;
};

export type AutomatedEmailResult =
  | { ok: true; emailId: string | null; skipped?: 'console' | 'no-email' }
  | { ok: false; reason: string };

export async function sendAutomatedEmailSafe(
  input: AutomatedEmailInput,
): Promise<AutomatedEmailResult> {
  try {
    return await sendInternal(input);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('email.automation.failed', {
      tenantId: input.tenantId,
      recipientUserId: input.recipientUserId,
      subject: input.subject,
      reason,
    });
    captureError(err instanceof Error ? err : new Error(reason), {
      category: 'email.automation.failed',
      severity: 'low',
      retryable: true,
      fields: {
        recipientUserId: input.recipientUserId,
        entityType: input.entityType,
      },
    });
    return { ok: false, reason };
  }
}

async function sendInternal(
  input: AutomatedEmailInput,
): Promise<AutomatedEmailResult> {
  // In dev (console provider) we don't want every reassignment to write
  // a fresh email_messages row — that'd flood the demo DB with noise.
  // Skip the persist + send, but log so the path is visible.
  const provider = getEmailProvider();
  if (provider.name === 'console') {
    logger.info('email.automation.console_skip', {
      subject: input.subject,
      recipientUserId: input.recipientUserId,
    });
    return { ok: true, emailId: null, skipped: 'console' };
  }

  // Resolve the recipient's primary email via Clerk.
  let recipientEmail: string | null = null;
  try {
    await auth(); // ensure Clerk is initialized in this request
    const client = await clerkClient();
    const user = await client.users.getUser(input.recipientUserId);
    recipientEmail =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : 'Clerk user lookup failed';
    logger.warn('email.automation.recipient_lookup_failed', {
      recipientUserId: input.recipientUserId,
      reason,
    });
    return { ok: false, reason: `Recipient lookup failed: ${reason}` };
  }

  if (!recipientEmail) {
    return { ok: true, emailId: null, skipped: 'no-email' };
  }

  // Idempotency key includes the entity + recipient + actor + a coarse
  // time bucket (minute) so a double-fire from the same trigger within
  // a minute dedupes through the unique index instead of producing two
  // emails.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `auto-${input.entityType}-${input.entityId}-${input.recipientUserId}-${minuteBucket}`;

  let queuedId: string;
  try {
    const inserted = await tenantTransaction(async (tx) => {
      const [row] = await tx
        .insert(emailMessages)
        .values({
          tenantId: input.tenantId,
          actorUserId: input.actorUserId ?? 'system',
          provider: provider.name,
          direction: 'outbound',
          status: 'queued',
          subject: input.subject,
          textBody: input.textBody,
          htmlBody: null,
          sender: getSenderIdentity(),
          toRecipients: [recipientEmail],
          ccRecipients: [],
          bccRecipients: [],
          entityType: input.entityType,
          entityId: input.entityId,
          idempotencyKey,
          metadata: { automation: true, ...(input.metadata ?? {}) },
        })
        .returning();
      return row ?? null;
    });
    if (!inserted) {
      return { ok: false, reason: 'Failed to queue automation email row' };
    }
    queuedId = inserted.id;
  } catch (err) {
    // Idempotency hit → another send within this minute already wrote
    // the row. Treat as success — don't fire a duplicate.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('email_messages_idempotency_idx')) {
      const [existing] = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.tenantId, input.tenantId),
              eq(emailMessages.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1),
      );
      return {
        ok: true,
        emailId: existing?.id ?? null,
      };
    }
    throw err;
  }

  const outcome = await deliverEmail(input.tenantId, queuedId);
  if (outcome.status === 'failed') {
    return {
      ok: false,
      reason: outcome.reason,
    };
  }
  return { ok: true, emailId: queuedId };
}
