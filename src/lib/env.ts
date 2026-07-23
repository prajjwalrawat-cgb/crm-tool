import 'server-only';

import { z } from 'zod';

/**
 * Production env validation. Run via `pnpm env:check` before deploy
 * and lazily at app startup when `validateEnvOnBoot()` is called.
 *
 * Two tiers:
 *   - REQUIRED: app refuses to boot without these (database, auth)
 *   - RECOMMENDED: logs a warning; degraded mode still functional
 *
 * Keep the Zod schema in sync with the README's env example. The
 * goal is to fail fast in production rather than crash on the first
 * unauthenticated request because a Clerk key is empty.
 */

const requiredEnvSchema = z.object({
  /** Postgres URL. Must include sslmode=require in production. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL must be set')
    .refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a Postgres connection string',
    ),
  /** Clerk auth keys. Without these the app boots but every request 401s. */
  CLERK_SECRET_KEY: z.string().min(1, 'CLERK_SECRET_KEY must be set'),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .min(1, 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be set'),
});

const recommendedEnvSchema = z.object({
  /** Inngest signing key for production workflow dispatch. */
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  /** Webhook signing secret from Clerk dashboard. */
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
  /** OpenAI key for live AI (mock mode kicks in if absent). */
  OPENAI_API_KEY: z.string().min(1).optional(),
  /** Email provider selection — `nodemailer`/`resend`/`console` (default). */
  EMAIL_PROVIDER: z
    .enum(['resend', 'smtp', 'console', 'nodemailer'])
    .optional(),
  /** Resend API key. Required only when EMAIL_PROVIDER=resend. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Sender identity used as the `From:` header. */
  EMAIL_FROM: z.string().min(1).optional(),
  /** SMTP host (e.g. smtp.gmail.com). Required for EMAIL_PROVIDER=nodemailer. */
  SMTP_HOST: z.string().min(1).optional(),
  /** SMTP port — typically 465 (implicit TLS) or 587 (STARTTLS). */
  SMTP_PORT: z
    .string()
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, {
      message: 'SMTP_PORT must be a positive integer',
    })
    .optional(),
  /** SMTP username (often the same as the From address for Gmail). */
  SMTP_USER: z.string().min(1).optional(),
  /** SMTP password / app password. Never log this value. */
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** `true` for implicit TLS (port 465), `false` for STARTTLS (587). */
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  /** Google OAuth2 client for Gmail sync (Module 3). */
  GMAIL_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET: z.string().min(1).optional(),
  /** OAuth redirect, e.g. https://app.example.com/api/integrations/gmail/callback */
  GMAIL_OAUTH_REDIRECT_URI: z.string().url().optional(),
  /** AES-256-GCM secret for encrypting Gmail refresh tokens at rest. */
  EMAIL_SYNC_ENCRYPTION_KEY: z.string().min(16).optional(),
});

export type EnvValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Validate the active `process.env` against the schema. Returns a
 * structured result instead of throwing so callers can choose between
 * crash-on-boot and degraded-mode behavior.
 */
export function validateEnv(): EnvValidationResult {
  const requiredParsed = requiredEnvSchema.safeParse(process.env);
  const recommendedParsed = recommendedEnvSchema.safeParse(process.env);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!requiredParsed.success) {
    const flat = z.flattenError(requiredParsed.error);
    for (const [field, msgs] of Object.entries(flat.fieldErrors)) {
      if (msgs) {
        for (const m of msgs) errors.push(`[${field}] ${m}`);
      }
    }
  }

  // Production-only sanity checks beyond presence.
  if (process.env.NODE_ENV === 'production') {
    const db = process.env.DATABASE_URL ?? '';
    if (db && !db.includes('sslmode=require')) {
      warnings.push(
        'DATABASE_URL in production should include sslmode=require',
      );
    }
  }

  // Recommended fields fall through as warnings.
  if (!recommendedParsed.success) {
    const flat = z.flattenError(recommendedParsed.error);
    for (const [field, msgs] of Object.entries(flat.fieldErrors)) {
      if (msgs) {
        for (const m of msgs) warnings.push(`[${field}] ${m}`);
      }
    }
  } else {
    if (!recommendedParsed.data.OPENAI_API_KEY) {
      warnings.push(
        'OPENAI_API_KEY not set — AI features will run in mock mode.',
      );
    }
    if (!recommendedParsed.data.INNGEST_SIGNING_KEY) {
      warnings.push(
        'INNGEST_SIGNING_KEY not set — workflows fall back to the local dispatcher.',
      );
    }
    if (!recommendedParsed.data.CLERK_WEBHOOK_SIGNING_SECRET) {
      warnings.push(
        'CLERK_WEBHOOK_SIGNING_SECRET not set — Clerk org webhooks will reject signature verification.',
      );
    }
    if (
      recommendedParsed.data.EMAIL_PROVIDER === 'resend' &&
      !recommendedParsed.data.RESEND_API_KEY
    ) {
      warnings.push(
        'EMAIL_PROVIDER=resend but RESEND_API_KEY is unset — sends will fall back to the console provider.',
      );
    }
    if (recommendedParsed.data.EMAIL_PROVIDER === 'nodemailer') {
      const missing: string[] = [];
      if (!recommendedParsed.data.SMTP_HOST) missing.push('SMTP_HOST');
      if (!recommendedParsed.data.SMTP_PORT) missing.push('SMTP_PORT');
      if (!recommendedParsed.data.SMTP_USER) missing.push('SMTP_USER');
      if (!recommendedParsed.data.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
      if (missing.length > 0) {
        warnings.push(
          `EMAIL_PROVIDER=nodemailer but ${missing.join(', ')} not set — sends will fall back to the console provider.`,
        );
      }
    }
    if (!recommendedParsed.data.EMAIL_FROM) {
      warnings.push(
        'EMAIL_FROM not set — outgoing email will use the default onboarding@resend.dev sender. Configure a verified domain in production.',
      );
    }
    const gmailPartial =
      recommendedParsed.data.GMAIL_CLIENT_ID ||
      recommendedParsed.data.GMAIL_CLIENT_SECRET ||
      recommendedParsed.data.GMAIL_OAUTH_REDIRECT_URI;
    if (gmailPartial) {
      const missing: string[] = [];
      if (!recommendedParsed.data.GMAIL_CLIENT_ID) missing.push('GMAIL_CLIENT_ID');
      if (!recommendedParsed.data.GMAIL_CLIENT_SECRET) missing.push('GMAIL_CLIENT_SECRET');
      if (!recommendedParsed.data.GMAIL_OAUTH_REDIRECT_URI) missing.push('GMAIL_OAUTH_REDIRECT_URI');
      if (!recommendedParsed.data.EMAIL_SYNC_ENCRYPTION_KEY) missing.push('EMAIL_SYNC_ENCRYPTION_KEY');
      if (missing.length > 0) {
        warnings.push(
          `Gmail sync (Module 3) is partially configured — missing ${missing.join(', ')}. Connect Gmail will be disabled until all are set.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, warnings };
}

/**
 * Boot-time variant: prints warnings, throws on errors. Call from
 * the server entrypoint (e.g. a one-time check at app start) or
 * from `pnpm env:check`.
 */
export function validateEnvOrThrow(): void {
  const result = validateEnv();
  for (const w of result.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`env: ${w}`);
  }
  if (!result.ok) {
    for (const e of result.errors) {
      // eslint-disable-next-line no-console
      console.error(`env: ${e}`);
    }
    throw new Error(
      `Environment validation failed (${result.errors.length} error${
        result.errors.length === 1 ? '' : 's'
      }). See logs above.`,
    );
  }
}
