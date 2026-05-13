'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { emailMessages, type EmailMessage } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
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
