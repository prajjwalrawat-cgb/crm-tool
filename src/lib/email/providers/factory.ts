import 'server-only';

import { ConsoleEmailProvider } from './console-provider';
import { ResendEmailProvider } from './resend-provider';
import type { EmailProvider } from './types';

/**
 * Pick the provider based on env config.
 *
 *   - `EMAIL_PROVIDER=resend` and `RESEND_API_KEY` → Resend
 *   - otherwise → Console (logs the message, doesn't actually send)
 *
 * The factory is intentionally simple — per-tenant provider config
 * (custom SMTP per workspace, etc.) lives in a future settings
 * table. v1 ships with one provider per deployment.
 */
let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  const choice = (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase();
  const resendKey = process.env.RESEND_API_KEY;

  if (choice === 'resend' && resendKey) {
    cached = new ResendEmailProvider({ apiKey: resendKey });
    return cached;
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
