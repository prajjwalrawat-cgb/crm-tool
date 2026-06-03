'use client';

import { Building2, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

// Sentinel substrings whose presence in `error.message` indicates a
// recoverable race we already have a recovery UI for. Everything else
// is treated as an opaque internal failure — we surface the digest
// reference but never the raw message, so DB schemas, query helper
// names, and library internals stay out of user-facing UI.
const MEMBERSHIP_HINTS = ['MembershipMissingError', 'No active membership'];

/**
 * Dashboard error boundary — owns the recovery UI for the membership-
 * sync failure mode ("Clerk says you're in this org, but our DB has
 * no row for you yet"). Previously this surface was a hard `throw new
 * Error(...)` that gave the user a black box stack trace; now it's a
 * polite "Refreshing workspace access…" with an auto-retry that
 * usually clears the mismatch on the second pass.
 *
 * Recognition: we sniff the error.message for the sentinel string
 * `MembershipMissingError` (added on the server). Any non-matching
 * error falls through to a generic "Something went wrong" panel
 * with the same retry primitives, so a thrown DB error doesn't bleed
 * into the recovery flow.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isMembershipMissing =
    error.name === 'MembershipMissingError' ||
    MEMBERSHIP_HINTS.some((h) => error.message.includes(h));

  // Always log the raw error to the console so the developer toolbar
  // and server logs retain the full stack — only the user-facing copy
  // is sanitized.
  useEffect(() => {
    console.error('[dashboard] route error:', error);
  }, [error]);

  // Auto-retry once on mount for membership-missing errors. Webhook
  // races and stale Next.js page caches usually clear in <1s.
  const triedAutoRetryRef = useRef(false);
  const [autoRetrying, setAutoRetrying] = useState(false);

  useEffect(() => {
    if (!isMembershipMissing || triedAutoRetryRef.current) return;
    triedAutoRetryRef.current = true;
    setAutoRetrying(true);
    const timer = setTimeout(() => {
      reset();
    }, 1200);
    return () => clearTimeout(timer);
  }, [isMembershipMissing, reset]);

  if (isMembershipMissing) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-500/10">
          {autoRetrying ? (
            <Loader2
              className="h-5 w-5 animate-spin text-indigo-600 dark:text-indigo-300"
              aria-hidden
            />
          ) : (
            <RefreshCw
              className="h-5 w-5 text-indigo-600 dark:text-indigo-300"
              aria-hidden
            />
          )}
        </div>
        <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          Refreshing workspace access…
        </h1>
        <p className="mt-2 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
          We&apos;re syncing your organization membership. This usually clears
          in a second — if not, try a manual refresh or switch organization.
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </button>
          <Link
            href="/select-org"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:bg-[#181818]"
          >
            <Building2 className="h-3.5 w-3.5" aria-hidden />
            Switch organization
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 dark:bg-rose-500/10">
        <RefreshCw className="h-5 w-5 text-rose-600 dark:text-rose-300" aria-hidden />
      </div>
      <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
        Something went wrong.
      </h1>
      <p className="mt-2 max-w-sm text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
        We hit an unexpected error loading this page. Try again — if it
        keeps happening, share the reference below with support.
      </p>
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Try again
        </button>
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:bg-[#181818]"
        >
          Back to dashboard
        </Link>
      </div>
      {error.digest ? (
        <p className="mt-4 font-mono text-[10px] text-slate-400 dark:text-[#71717A]">
          ref: {error.digest}
        </p>
      ) : null}
    </main>
  );
}
