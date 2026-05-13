import 'server-only';

import { captureError, logger } from '@/lib/observability';

import type { EmailMessageToSend, EmailProvider, SendResult } from './types';

/**
 * Resend HTTP API client. We deliberately don't take an npm
 * dependency on `resend` — a single `fetch` call is enough and
 * keeps the bundle slim. If Resend's contract changes we update
 * here.
 *
 * Errors are categorized into retryable (5xx, network) vs.
 * permanent (4xx body-validation, auth failure). Permanent errors
 * never re-enter the retry queue.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.resend.com';
  }

  async send(message: EmailMessageToSend): Promise<SendResult> {
    const body = {
      from: message.from,
      to: message.to,
      cc: message.cc.length > 0 ? message.cc : undefined,
      bcc: message.bcc.length > 0 ? message.bcc : undefined,
      subject: message.subject,
      text: message.text,
      html: message.html ?? undefined,
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify(body),
        // Resend usually responds in <500ms; cap to 30s to keep a
        // hung provider from blocking the user's perceived send.
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'Network failure';
      captureError(err, {
        category: 'email.resend.network',
        severity: 'medium',
        retryable: true,
      });
      return { status: 'rejected', reason, retryable: true };
    }

    if (response.ok) {
      type ResendOk = { id?: string };
      const data = (await response
        .json()
        .catch(() => ({}))) as ResendOk;
      return {
        status: 'accepted',
        providerMessageId: data.id ?? null,
      };
    }

    // Non-2xx — pull a useful reason from the body.
    let reason = `Resend returned ${response.status}`;
    try {
      const text = await response.text();
      if (text) reason = text.slice(0, 500);
    } catch {
      // ignore body-read failures; the status code is enough
    }
    const retryable = response.status >= 500 || response.status === 429;

    logger.warn('email.resend.rejected', {
      status: response.status,
      retryable,
    });
    return { status: 'rejected', reason, retryable };
  }
}
