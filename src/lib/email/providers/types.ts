/**
 * Email provider abstraction. The CRM doesn't care which transport
 * actually relays a message — only that the contract is preserved:
 *
 *   - `send` accepts a fully-formed message and returns either an
 *     `accepted` result with the provider's message id, or a
 *     `rejected` result with a human-readable reason.
 *   - Providers are stateless: configuration lives in env vars (v1)
 *     or eventually in a per-tenant settings table (v2).
 *
 * Adding Gmail / Outlook later is a matter of implementing this
 * interface and registering it in `factory.ts`.
 */

import type { EmailProviderName } from '@/db/schema';

export type EmailMessageToSend = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  /**
   * Idempotency key the caller has already persisted on the
   * email_messages row. Providers may surface this to their own
   * dedup systems (Resend, for example, accepts it as
   * `Idempotency-Key` HTTP header).
   */
  idempotencyKey: string;
};

export type SendResult =
  | {
      status: 'accepted';
      providerMessageId: string | null;
    }
  | {
      status: 'rejected';
      /** Best-effort human-readable reason for `email_messages.error`. */
      reason: string;
      /** True if a retry could plausibly succeed (transient failure). */
      retryable: boolean;
    };

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(message: EmailMessageToSend): Promise<SendResult>;
}
