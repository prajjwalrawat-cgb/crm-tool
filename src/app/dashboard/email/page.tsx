import { Mail } from 'lucide-react';
import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import {
  listAllEmails,
  type EmailStatusFilter,
  type GlobalEmailRow,
} from '@/lib/email/queries';
import { formatRelativeTime } from '@/lib/activity/format';
import { formatDateTime } from '@/lib/dates/format';
import { cn } from '@/lib/utils';

import { EmailRetryButton } from '../_components/email-retry-button';

export const metadata = { title: 'Email' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATUS_FILTERS: { key: EmailStatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'queued', label: 'In flight' },
  { key: 'failed', label: 'Failed' },
];

const STATUS_TINT: Record<string, string> = {
  sent: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  delivered: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  queued: 'bg-slate-50 text-slate-700 ring-slate-200',
  sending: 'bg-blue-50 text-blue-700 ring-blue-200',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200',
};

const ENTITY_HREF: Record<string, (id: string) => string> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: (id) => `/dashboard/companies/${id}`,
  contact: (id) => `/dashboard/contacts/${id}`,
};

/**
 * Centralized email visibility surface — inbox-style list of every
 * outbound email in this tenant. Each row links back to the related
 * entity, surfaces delivery status + retry count, and exposes the
 * retry control inline for failed rows with budget left.
 */
export default async function EmailPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const rawStatus =
      typeof sp.status === 'string' ? sp.status : undefined;
    const status: EmailStatusFilter = (
      ['all', 'sent', 'failed', 'queued'] as const
    ).includes(rawStatus as EmailStatusFilter)
      ? (rawStatus as EmailStatusFilter)
      : 'all';
    const search =
      typeof sp.q === 'string' ? sp.q.trim().slice(0, 200) : undefined;

    const rows = await listAllEmails(tenant.id, { status, search, limit: 100 });

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-900">
            <Mail className="h-5 w-5 text-slate-500" aria-hidden />
            Email
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            All outbound email in {tenant.name}. Click an entity to open its
            detail timeline or use the inline retry control for failed sends.
          </p>
        </header>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((f) => {
            const params = new URLSearchParams();
            if (f.key !== 'all') params.set('status', f.key);
            if (search) params.set('q', search);
            const href = params.toString()
              ? `/dashboard/email?${params}`
              : '/dashboard/email';
            const active = status === f.key;
            return (
              <Link
                key={f.key}
                href={href}
                className={cn(
                  'rounded-full px-3 py-1 text-[12px] font-medium ring-1 transition',
                  active
                    ? 'bg-indigo-600 text-white ring-indigo-600'
                    : 'bg-white text-slate-700 ring-slate-200 hover:border-indigo-300 hover:text-indigo-700',
                )}
              >
                {f.label}
              </Link>
            );
          })}

          <form action="/dashboard/email" className="ml-auto flex items-center gap-2">
            <input type="hidden" name="status" value={status === 'all' ? '' : status} />
            <input
              type="search"
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search subject or recipient…"
              className="w-64 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </form>
        </div>

        {rows.length === 0 ? (
          <EmptyState status={status} search={search} />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {rows.map((row) => (
              <EmailRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </main>
    );
  });
}

function EmailRow({ row }: { row: GlobalEmailRow }) {
  const failed = row.status === 'failed';
  const entityHref =
    row.entityType && row.entityId && ENTITY_HREF[row.entityType]
      ? ENTITY_HREF[row.entityType]!(row.entityId)
      : null;
  const recipientPreview =
    row.toRecipients.length === 0
      ? '(no recipients)'
      : row.toRecipients.length === 1
        ? row.toRecipients[0]!
        : `${row.toRecipients[0]} +${row.toRecipients.length - 1}`;

  return (
    <li className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50/70">
      <Mail
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          failed ? 'text-rose-500' : 'text-slate-400',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[13px] font-semibold text-slate-800">
            {row.subject || '(no subject)'}
          </p>
          <span
            className="shrink-0 cursor-default text-[10.5px] tabular-nums text-slate-400"
            title={formatDateTime(row.createdAt)}
          >
            {formatRelativeTime(row.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-slate-500">
          to <span className="font-mono">{recipientPreview}</span>
          {entityHref ? (
            <>
              {' · '}
              <Link
                href={entityHref}
                className="font-medium text-slate-600 hover:text-indigo-700 hover:underline"
              >
                {row.entityType}: {row.entityLabel ?? row.entityId?.slice(0, 8)}
              </Link>
            </>
          ) : null}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide">
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 font-medium ring-1',
              STATUS_TINT[row.status] ?? STATUS_TINT.queued,
            )}
          >
            {row.status}
          </span>
          <span className="text-slate-400">via {row.provider}</span>
          {row.retryCount > 0 ? (
            <span className="text-slate-500">· {row.retryCount} retries</span>
          ) : null}
          {failed && row.error ? (
            <span className="truncate text-rose-600">· {row.error}</span>
          ) : null}
          {failed ? (
            <EmailRetryButton
              emailId={row.id}
              retryCount={row.retryCount}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function EmptyState({
  status,
  search,
}: {
  status: EmailStatusFilter;
  search?: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
      <Mail className="mx-auto h-7 w-7 text-slate-400" aria-hidden />
      <p className="mt-3 text-[13px] font-medium text-slate-700">
        {search
          ? `No emails matching "${search}"`
          : status === 'all'
            ? 'No emails yet'
            : `No ${status} emails`}
      </p>
      <p className="mt-1 text-[12px] text-slate-500">
        Send an email from a deal, contact, or company to see it here.
      </p>
    </div>
  );
}
