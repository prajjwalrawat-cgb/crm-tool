import { CheckCircle2, Cog, Mail, ShieldAlert } from 'lucide-react';

import { cn } from '@/lib/utils';

import { Section } from './primitives';

export type EmailProviderStatus = {
  provider: 'nodemailer' | 'resend' | 'console';
  /** Sender identity that will appear on the `From:` header. */
  senderIdentity: string;
  /** SMTP details when provider === 'nodemailer'. Always non-credential. */
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    /** Masked username — never the raw value. */
    userMasked: string;
  };
  /** Resend key presence (boolean only — never the key itself). */
  resendKeyPresent?: boolean;
  /** Configuration warnings derived from env validation. */
  warnings: string[];
};

/**
 * Read-only operational card showing which email provider is active,
 * what sender identity it uses, and any configuration warnings the
 * env validator surfaced. Designed to answer "is my outbound email
 * provider set up correctly?" at a glance.
 *
 * Does NOT expose credentials. Username is masked, password is never
 * read into render output, and the Resend key is reduced to a boolean.
 */
export function EmailProviderSection({ status }: { status: EmailProviderStatus }) {
  const banner =
    status.provider === 'console'
      ? 'warn'
      : status.warnings.length > 0
        ? 'warn'
        : 'success';

  return (
    <Section
      title="Email provider"
      description="Active outbound transport. Credentials never appear in this view."
      action={
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ring-1',
            banner === 'success' && 'bg-emerald-50 text-emerald-700 ring-emerald-200',
            banner === 'warn' && 'bg-amber-50 text-amber-800 ring-amber-200',
          )}
        >
          {banner === 'success' ? (
            <CheckCircle2 className="h-3 w-3" aria-hidden />
          ) : (
            <ShieldAlert className="h-3 w-3" aria-hidden />
          )}
          {status.provider === 'console'
            ? 'Dev fallback'
            : banner === 'success'
              ? 'Configured'
              : 'Check config'}
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Cell label="Provider" icon={<Mail className="h-3.5 w-3.5" aria-hidden />}>
          <span className="font-mono text-[12.5px]">{status.provider}</span>
        </Cell>
        <Cell label="From" icon={<Mail className="h-3.5 w-3.5" aria-hidden />}>
          <span className="font-mono text-[12.5px]">{status.senderIdentity}</span>
        </Cell>
        {status.smtp ? (
          <>
            <Cell label="SMTP host" icon={<Cog className="h-3.5 w-3.5" aria-hidden />}>
              <span className="font-mono text-[12.5px]">
                {status.smtp.host}:{status.smtp.port}
              </span>
            </Cell>
            <Cell label="SMTP user" icon={<Cog className="h-3.5 w-3.5" aria-hidden />}>
              <span className="font-mono text-[12.5px]">{status.smtp.userMasked}</span>
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-600">
                {status.smtp.secure ? 'TLS' : 'STARTTLS'}
              </span>
            </Cell>
          </>
        ) : null}
        {status.resendKeyPresent !== undefined && status.provider === 'resend' ? (
          <Cell label="Resend key" icon={<Cog className="h-3.5 w-3.5" aria-hidden />}>
            {status.resendKeyPresent ? (
              <span className="font-mono text-[12.5px] text-emerald-700">
                ********** (set)
              </span>
            ) : (
              <span className="font-mono text-[12.5px] text-rose-600">
                (missing)
              </span>
            )}
          </Cell>
        ) : null}
      </div>

      {status.warnings.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-900">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            Configuration warnings
          </div>
          <ul className="space-y-1 leading-tight">
            {status.warnings.map((w, i) => (
              <li key={i} className="font-mono text-[11.5px]">
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status.provider === 'nodemailer' ? (
        <p className="mt-3 text-[11.5px] text-slate-500">
          Run{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10.5px]">
            pnpm tsx scripts/test-smtp.ts --to your-email@example.com
          </code>{' '}
          to send a live diagnostic email.
        </p>
      ) : null}
    </Section>
  );
}

function Cell({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-slate-700">{children}</div>
    </div>
  );
}
