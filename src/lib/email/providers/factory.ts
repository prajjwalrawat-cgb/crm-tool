import 'server-only';

import { logger } from '@/lib/observability';

import { ConsoleEmailProvider } from './console-provider';
import {
  NodemailerEmailProvider,
  type NodemailerProviderOptions,
} from './nodemailer-provider';
import { ResendEmailProvider } from './resend-provider';
import type { EmailProvider } from './types';

/**
 * Pick the provider based on env config.
 *
 *   - `EMAIL_PROVIDER=nodemailer` + valid `SMTP_*` → Nodemailer SMTP
 *   - `EMAIL_PROVIDER=resend` + `RESEND_API_KEY`   → Resend HTTP
 *   - otherwise (or `console`)                     → console (logs only)
 *
 * Default behavior:
 *   - production (NODE_ENV=production) — prefers nodemailer if SMTP
 *     vars are present; otherwise falls back to console + logs a
 *     warning so the gap is loud.
 *   - dev — defaults to console unless explicitly opted in.
 *
 * Per-tenant provider config (custom SMTP per workspace, OAuth tokens
 * per workspace) lives in a future settings table; v1 ships with one
 * provider per deployment.
 */
let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  const choice = (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase();

  if (choice === 'nodemailer') {
    const cfg = readNodemailerConfig();
    if (cfg) {
      cached = new NodemailerEmailProvider(cfg);
      return cached;
    }
    logger.warn('email.provider.nodemailer.incomplete', {
      message:
        'EMAIL_PROVIDER=nodemailer but SMTP_* env vars are missing — falling back to console.',
    });
  }

  if (choice === 'resend') {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      cached = new ResendEmailProvider({ apiKey: resendKey });
      return cached;
    }
    logger.warn('email.provider.resend.incomplete', {
      message:
        'EMAIL_PROVIDER=resend but RESEND_API_KEY is missing — falling back to console.',
    });
  }

  cached = new ConsoleEmailProvider();
  return cached;
}

/**
 * Sender identity. Read from env; falls back to a clearly-fake
 * address that surfaces config gaps without breaking compose.
 */
export function getSenderIdentity(): string {
  return (
    process.env.EMAIL_FROM ??
    'CRM <onboarding@resend.dev>'
  );
}

/** Test seam — drop the cached provider so the next call re-reads env. */
export function _resetEmailProviderCache(): void {
  cached = null;
}

/**
 * Parse + validate the SMTP block from process.env. Returns null when
 * any required field is missing so the factory can fall back gracefully.
 * Exported for the scripts/test-smtp.ts diagnostic.
 */
export function readNodemailerConfig(): NodemailerProviderOptions | null {
  const host = process.env.SMTP_HOST?.trim();
  const portRaw = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const secureRaw = (process.env.SMTP_SECURE ?? '').trim().toLowerCase();

  if (!host || !portRaw || !user || !password) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) return null;

  // Default rule: 465 → secure=true (implicit TLS), other ports → false
  // (STARTTLS). Allow explicit override via SMTP_SECURE=true/false.
  const secure =
    secureRaw === 'true'
      ? true
      : secureRaw === 'false'
        ? false
        : port === 465;

  return { host, port, user, password, secure };
}
