import 'server-only';

import { getEmailProvider, getSenderIdentity } from '@/lib/email/providers/factory';
import { logger } from '@/lib/observability';

/**
 * Auth-related transactional emails (password reset, workspace invite).
 * Unlike CRM email, these are NOT tenant-scoped — a reset can fire before
 * the user has any workspace — so we dispatch straight through the
 * provider instead of the tenant-scoped `email_messages` pipeline.
 */

function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

async function send(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}): Promise<void> {
  const provider = getEmailProvider();
  const result = await provider.send({
    from: getSenderIdentity(),
    to: [input.to],
    cc: [],
    bcc: [],
    subject: input.subject,
    text: input.text,
    html: input.html,
    idempotencyKey: input.idempotencyKey,
  });
  if (result.status === 'rejected') {
    logger.warn('auth.email.rejected', {
      to: input.to,
      subject: input.subject,
      reason: result.reason,
    });
  }
}

export async function sendPasswordResetEmail(input: {
  to: string;
  token: string;
  /** First-time password set (migrated user) vs. a reset. Tweaks copy. */
  initial?: boolean;
}): Promise<void> {
  const link = `${appUrl()}/reset-password?token=${encodeURIComponent(input.token)}`;
  const heading = input.initial ? 'Set your password' : 'Reset your password';
  const intro = input.initial
    ? 'Your account has moved to a new sign-in. Set a password to continue.'
    : 'We received a request to reset your password.';
  await send({
    to: input.to,
    subject: `${heading} · Saleinx`,
    text: `${intro}\n\nOpen this link to ${heading.toLowerCase()} (valid for 1 hour):\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>${intro}</p><p><a href="${link}">${heading}</a> (valid for 1 hour).</p><p style="color:#64748b;font-size:12px">If you didn't request this, you can ignore this email.</p>`,
    idempotencyKey: `pwreset-${input.token}`,
  });
}

export async function sendInviteEmail(input: {
  to: string;
  token: string;
  tenantName: string;
  inviterName?: string | null;
}): Promise<void> {
  const link = `${appUrl()}/accept-invite?token=${encodeURIComponent(input.token)}`;
  const by = input.inviterName ? ` by ${input.inviterName}` : '';
  const intro = `You've been invited${by} to join the “${input.tenantName}” workspace on Saleinx.`;
  await send({
    to: input.to,
    subject: `Join ${input.tenantName} · Saleinx`,
    text: `${intro}\n\nAccept your invite (valid for 7 days):\n${link}\n\nIf you weren't expecting this, you can ignore this email.`,
    html: `<p>${intro}</p><p><a href="${link}">Accept your invite</a> (valid for 7 days).</p><p style="color:#64748b;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`,
    idempotencyKey: `invite-${input.token}`,
  });
}
