import 'server-only';

import nodemailer, { type Transporter } from 'nodemailer';

import { captureError, logger } from '@/lib/observability';

import type { EmailMessageToSend, EmailProvider, SendResult } from './types';

/**
 * SMTP transport implemented with Nodemailer. Tagged with the existing
 * `smtp` provider name in the schema so we don't need a migration —
 * future SMTP-flavored providers (Mailgun, custom relay, etc.) can all
 * share this tag, or we can specialize later.
 *
 * The transporter is pooled and lazily constructed. Each `send` call
 * reuses the connection where possible. Failures are categorized:
 *   - retryable: connection / 4xx-transient / SMTP 421/450/451/452
 *   - permanent: auth failures, malformed addresses, "no such user"
 *
 * IMPORTANT: this is the first provider that actually relays real
 * mail. The deliverEmail() state machine still enforces the
 * queued → sending → sent/failed transitions, and recordNotification
 * never goes through here — we only respond to outbound transactional
 * sends.
 */

export type NodemailerProviderOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Use TLS straight away (port 465). For 587/STARTTLS pass false. */
  secure: boolean;
};

export class NodemailerEmailProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  private readonly opts: NodemailerProviderOptions;
  private transporter: Transporter | null = null;

  constructor(opts: NodemailerProviderOptions) {
    this.opts = opts;
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: {
        user: this.opts.user,
        pass: this.opts.password,
      },
      // Connection pooling keeps a few sockets open so consecutive
      // sends don't pay the TLS handshake cost. Default pool of 5 is
      // plenty for app traffic; raise if we hit bursty automated
      // sends.
      pool: true,
      maxConnections: 5,
      // Per-message timeout. 30s matches the Resend provider and is
      // generous for any reasonable SMTP path.
      connectionTimeout: 30_000,
      socketTimeout: 30_000,
    });
    return this.transporter;
  }

  /**
   * One-shot connection verification. Used by scripts/test-smtp.ts
   * and the ops settings page. Wraps the underlying verify() error
   * into a friendlier message so credential mistakes are obvious.
   */
  async verifyConnection(): Promise<
    { ok: true } | { ok: false; reason: string }
  > {
    try {
      await this.getTransporter().verify();
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  async send(message: EmailMessageToSend): Promise<SendResult> {
    try {
      const info = await this.getTransporter().sendMail({
        from: message.from,
        to: message.to,
        cc: message.cc.length > 0 ? message.cc : undefined,
        bcc: message.bcc.length > 0 ? message.bcc : undefined,
        subject: message.subject,
        text: message.text,
        html: message.html ?? undefined,
        // Nodemailer surfaces this as a Message-ID header which most
        // SMTP servers will forward, helping us correlate sends back
        // to our own row in the email_messages table.
        messageId: `<${message.idempotencyKey}@crm.local>`,
        headers: {
          'X-Idempotency-Key': message.idempotencyKey,
        },
      });

      // Some SMTP servers reject a subset of recipients while accepting
      // others. Nodemailer surfaces that via info.rejected.
      if (info.rejected && info.rejected.length > 0) {
        const reason = `SMTP rejected: ${info.rejected.join(', ')}`;
        logger.warn('email.smtp.partial_reject', {
          accepted: info.accepted?.length ?? 0,
          rejected: info.rejected.length,
        });
        return { status: 'rejected', reason, retryable: false };
      }

      return {
        status: 'accepted',
        providerMessageId: typeof info.messageId === 'string' ? info.messageId : null,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const retryable = classifyRetryable(reason);
      captureError(err, {
        category: 'email.smtp.send_failed',
        severity: retryable ? 'medium' : 'high',
        retryable,
        fields: {
          host: this.opts.host,
          // Never log credentials — only the username's local-part for
          // diagnostic correlation.
          user: maskUser(this.opts.user),
        },
      });
      return { status: 'rejected', reason, retryable };
    }
  }
}

/**
 * Heuristic: classify a Nodemailer/SMTP error message into retryable
 * (transient connection/protocol blip) vs. permanent (auth failure,
 * malformed message). We err on the side of retryable for unfamiliar
 * errors so a temporary outage doesn't permanently quarantine a row.
 */
function classifyRetryable(reason: string): boolean {
  const r = reason.toLowerCase();
  // Permanent — no amount of retry will fix these.
  if (r.includes('invalid login')) return false;
  if (r.includes('authentication failed')) return false;
  if (r.includes('username and password not accepted')) return false;
  if (r.includes('5.7.0')) return false; // SMTP "auth required / not authorized"
  if (r.includes('5.1.1')) return false; // "no such user"
  if (r.includes('5.5.1')) return false; // "command not implemented / malformed"
  // Transient — server overloaded, connection blip, greylisting.
  if (r.includes('etimedout')) return true;
  if (r.includes('econnrefused')) return true;
  if (r.includes('econnreset')) return true;
  if (r.includes('4.7.0')) return true; // SMTP "try again later"
  if (r.includes('421')) return true; // service not available, closing transmission
  if (r.includes('450')) return true; // mailbox busy
  if (r.includes('451')) return true; // local error processing
  if (r.includes('452')) return true; // insufficient system storage
  if (r.includes('timeout')) return true;
  // Default: assume retryable; deliverEmail() caps attempts at 3 anyway.
  return true;
}

/**
 * Mask an SMTP username for logging. Keeps the first 3 chars + domain
 * so we can correlate "the prod account is failing" without ever
 * surfacing the full address in logs that may ship to ops dashboards.
 */
function maskUser(user: string): string {
  if (!user.includes('@')) return user.slice(0, 3) + '***';
  const [local, domain] = user.split('@', 2);
  if (!local || !domain) return '***';
  return `${local.slice(0, 3)}***@${domain}`;
}
