import 'server-only';

import { logger } from '@/lib/observability';

import type { EmailMessageToSend, EmailProvider, SendResult } from './types';

/**
 * Dev fallback provider. Logs the message to the server console and
 * returns a synthetic accepted result. Used when no real provider is
 * configured (the env validator emits a warning, but the app stays
 * functional — useful for local dev + selftests).
 *
 * Identifies itself as 'console' on the `email_messages.provider`
 * column so the timeline can mark them as "logged locally, not
 * actually sent".
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console' as const;

  async send(message: EmailMessageToSend): Promise<SendResult> {
    logger.info('email.console.send', {
      from: message.from,
      to: message.to,
      subject: message.subject,
      idempotencyKey: message.idempotencyKey,
    });
    // Synthetic id with a `console-` prefix so it's easy to spot.
    return {
      status: 'accepted',
      providerMessageId: `console-${message.idempotencyKey}`,
    };
  }
}
