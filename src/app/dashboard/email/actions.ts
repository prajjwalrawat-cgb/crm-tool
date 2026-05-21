'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { emailMessages, type EmailMessage } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { attachOutboundMessageToThread } from '@/lib/communications/send-integration';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { getEmailProvider, getSenderIdentity } from '@/lib/email/providers/factory';
import { deliverEmail } from '@/lib/email/sender';

const ENTITY_TYPES = ['deal', 'company', 'contact'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const PERMISSION_FOR: Record<EntityType, 'manageDeals' | 'manageCompanies' | 'manageContacts'> = {
  deal: 'manageDeals',
  company: 'manageCompanies',
  contact: 'manageContacts',
};

const PATH_FOR: Record<EntityType, (id: string) => string> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: (id) => `/dashboard/companies/${id}`,
  contact: (id) => `/dashboard/contacts/${id}`,
};

const sendEmailSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.uuid(),
  subject: z.string().min(1, 'Subject is required').max(998),
  textBody: z.string().min(1, 'Email body is required').max(50_000),
  toRecipients: z
    .array(z.email('Invalid recipient email'))
    .min(1, 'At least one recipient is required')
    .max(50),
  ccRecipients: z.array(z.email()).max(50).optional(),
  bccRecipients: z.array(z.email()).max(50).optional(),
  /**
   * Client-generated idempotency key. The server's unique partial
   * index on (tenant_id, idempotency_key) catches duplicate POSTs
   * even if the user double-clicks Send through a slow network.
   */
  idempotencyKey: z.string().min(8).max(120),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;

export type SendEmailResult =
  | { ok: true; email: EmailMessage }
  | {
      ok: false;
      message: string;
      retryable?: boolean;
      fieldErrors?: Record<string, string[]>;
    };

export async function sendEmailAction(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const parsed = sendEmailSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const gate = await checkPermission(PERMISSION_FOR[parsed.data.entityType]);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      // Insert the queued row first. The unique partial index on
      // (tenant_id, idempotency_key) returns a constraint error
      // on duplicate POSTs; we trap that and return the existing
      // row instead of double-sending.
      const provider = getEmailProvider();
      let queuedId: string | null = null;
      try {
        const inserted = await tenantTransaction(async (tx) => {
          const [row] = await tx
            .insert(emailMessages)
            .values({
              tenantId: tenant.id,
              actorUserId: membership.userId,
              provider: provider.name,
              direction: 'outbound',
              status: 'queued',
              subject: parsed.data.subject,
              textBody: parsed.data.textBody,
              htmlBody: null,
              sender: getSenderIdentity(),
              toRecipients: parsed.data.toRecipients,
              ccRecipients: parsed.data.ccRecipients ?? [],
              bccRecipients: parsed.data.bccRecipients ?? [],
              entityType: parsed.data.entityType,
              entityId: parsed.data.entityId,
              idempotencyKey: parsed.data.idempotencyKey,
            })
            .returning();
          return row ?? null;
        });
        queuedId = inserted?.id ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Postgres constraint violation = duplicate idempotency key.
        if (msg.includes('email_messages_idempotency_idx')) {
          const [existing] = await tenantTransaction(async (tx) =>
            tx
              .select()
              .from(emailMessages)
              .where(
                and(
                  eq(emailMessages.tenantId, tenant.id),
                  eq(
                    emailMessages.idempotencyKey,
                    parsed.data.idempotencyKey,
                  ),
                ),
              )
              .limit(1),
          );
          if (existing) {
            return { ok: true, email: existing };
          }
        }
        return { ok: false, message: msg };
      }

      if (!queuedId) {
        return { ok: false, message: 'Failed to queue email' };
      }

      // Dispatch via the provider. The sender pipeline updates the
      // row's status and emits metrics; we just need its outcome.
      const outcome = await deliverEmail(tenant.id, queuedId);

      // Log activity in either direction so the timeline reflects
      // every send attempt — not just successes.
      await tenantTransaction(async (tx) => {
        const recipientLabel = parsed.data.toRecipients.join(', ');
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          action: outcome.status === 'sent' ? 'email_sent' : 'email_failed',
          metadata: {
            emailId: queuedId,
            subject: parsed.data.subject,
            recipientLabel,
            provider: outcome.providerName,
            error: outcome.status === 'failed' ? outcome.reason : undefined,
          },
        });
      });

      const [finalRow] = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.id, queuedId),
              eq(emailMessages.tenantId, tenant.id),
            ),
          )
          .limit(1),
      );

      // Wire the message into the communication graph + agent
      // learning loop. Threading, event ledger, relationship counters,
      // observation, and realtime fan-out all happen here. Wrapped in
      // a try/catch so a side-effect failure cannot mask the
      // user-facing send outcome — the email was already delivered (or
      // not) by `deliverEmail()` above.
      if (finalRow) {
        try {
          await attachOutboundMessageToThread({
            tenantId: tenant.id,
            actorUserId: membership.userId,
            message: finalRow,
            delivery: {
              status: outcome.status === 'sent' ? 'sent' : 'failed',
              providerName: outcome.providerName ?? null,
              reason: outcome.status === 'failed' ? outcome.reason : null,
            },
          });
        } catch (err) {
          console.error(
            '[communications] thread attach failed for message',
            finalRow.id,
            err,
          );
        }
      }

      revalidatePath(
        PATH_FOR[parsed.data.entityType](parsed.data.entityId),
      );

      if (outcome.status === 'failed') {
        return {
          ok: false,
          message: outcome.reason,
          retryable: outcome.retryable,
        };
      }

      if (!finalRow) {
        return { ok: false, message: 'Email row missing after send' };
      }
      return { ok: true, email: finalRow };
    },
  );
}

const retryEmailSchema = z.object({
  emailId: z.uuid(),
});

export type RetryEmailResult =
  | { ok: true; email: EmailMessage }
  | { ok: false; message: string; retryable?: boolean };

const MAX_RETRY_ATTEMPTS = 3;

/**
 * Re-dispatch a previously failed email. Resets the row's status back
 * to `queued` (only if it is currently `failed` AND has retry budget
 * left) so `deliverEmail()` will pick it up; the state machine still
 * guards against double-sends on a `sent` row. The retry counter on
 * the row is incremented by the sender pipeline itself.
 *
 * Permission is gated by the entity type the email is linked to so a
 * user with `manageContacts` only can retry contact emails but not
 * deal emails.
 */
export async function retryEmailAction(input: {
  emailId: string;
}): Promise<RetryEmailResult> {
  const parsed = retryEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid email id' };
  }

  // First read the row to figure out which entity-type permission applies
  // before re-checking permission and triggering the send.
  const tenantInfo = await checkPermission('manageDeals');
  // checkPermission gives us the tenant context even if the role grant
  // is wrong for this specific email; we'll re-gate after we know the
  // entity type. Bail out early if the session is unauthenticated.
  if (!tenantInfo.ok) return { ok: false, message: tenantInfo.message };

  return await runWithTenantContext(
    {
      tenantId: tenantInfo.tenant.id,
      userId: tenantInfo.membership.userId,
    },
    async () => {
      const [existing] = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.id, parsed.data.emailId),
              eq(emailMessages.tenantId, tenantInfo.tenant.id),
            ),
          )
          .limit(1),
      );

      if (!existing) return { ok: false, message: 'Email not found' };
      if (existing.status === 'sent' || existing.status === 'delivered') {
        return { ok: false, message: 'Email already delivered — nothing to retry' };
      }
      if (existing.status === 'sending') {
        return {
          ok: false,
          message: 'Email is currently sending — wait for the in-flight attempt to finish',
        };
      }
      if (existing.retryCount >= MAX_RETRY_ATTEMPTS) {
        return {
          ok: false,
          message: `Retry budget exhausted (${existing.retryCount}/${MAX_RETRY_ATTEMPTS}). Edit the row or contact the provider.`,
        };
      }

      // Re-gate permission on the actual entity type.
      const entityType = existing.entityType as EntityType | null;
      if (!entityType || !PERMISSION_FOR[entityType]) {
        return { ok: false, message: 'Email not linked to an entity — cannot retry' };
      }
      const gate = await checkPermission(PERMISSION_FOR[entityType]);
      if (!gate.ok) return { ok: false, message: gate.message };

      // Reset to queued. The `deliverEmail()` state-machine guard will
      // only transition from `queued` → `sending`, so this is the right
      // hand-off point.
      await tenantTransaction(async (tx) => {
        await tx
          .update(emailMessages)
          .set({
            status: 'queued',
            error: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailMessages.id, existing.id),
              eq(emailMessages.tenantId, tenantInfo.tenant.id),
            ),
          );
      });

      const outcome = await deliverEmail(tenantInfo.tenant.id, existing.id);

      await tenantTransaction(async (tx) => {
        await recordActivity(tx, {
          tenantId: tenantInfo.tenant.id,
          actorUserId: tenantInfo.membership.userId,
          entityType: entityType,
          entityId: existing.entityId ?? '',
          action: outcome.status === 'sent' ? 'email_sent' : 'email_failed',
          metadata: {
            emailId: existing.id,
            subject: existing.subject,
            recipientLabel: existing.toRecipients.join(', '),
            provider: outcome.providerName,
            retryAttempt: existing.retryCount + 1,
            error: outcome.status === 'failed' ? outcome.reason : undefined,
          },
        });
      });

      const [finalRow] = await tenantTransaction(async (tx) =>
        tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.id, existing.id),
              eq(emailMessages.tenantId, tenantInfo.tenant.id),
            ),
          )
          .limit(1),
      );

      if (existing.entityType && existing.entityId) {
        revalidatePath(
          PATH_FOR[existing.entityType as EntityType](existing.entityId),
        );
      }

      if (outcome.status === 'failed') {
        return {
          ok: false,
          message: outcome.reason,
          retryable: outcome.retryable,
        };
      }
      if (!finalRow) {
        return { ok: false, message: 'Email row missing after retry' };
      }
      return { ok: true, email: finalRow };
    },
  );
}
