'use client';

import { AlertTriangle, CheckCircle2, Loader2, Mail } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { disconnectGmailAction, updateExclusionsAction } from '../actions';

type Connection = {
  email: string;
  syncStatus: string;
  lastSyncAt: string | null;
  lastError: string | null;
  excludedDomains: string[];
  excludedAddresses: string[];
};

const ERROR_LABELS: Record<string, string> = {
  not_configured: 'Gmail sync is not configured on this deployment.',
  access_denied: 'You declined the Google permission request.',
  invalid_state: 'The connection request expired or was invalid — try again.',
  no_refresh_token: 'Google did not return a refresh token — reconnect and allow offline access.',
  exchange_failed: 'Could not complete the Google connection — try again.',
};

export function EmailSyncManager({
  moduleEnabled,
  oauthConfigured,
  connection,
}: {
  moduleEnabled: boolean;
  oauthConfigured: boolean;
  connection: Connection | null;
}) {
  const params = useSearchParams();

  useEffect(() => {
    if (params.get('connected')) toast.success('Gmail connected — sync will begin shortly.');
    const err = params.get('error');
    if (err) toast.error(ERROR_LABELS[err] ?? 'Could not connect Gmail.');
  }, [params]);

  if (!moduleEnabled) {
    return (
      <Notice tone="muted">
        Email sync isn&apos;t enabled for this workspace. An admin can turn on the
        Email Sync feature flag.
      </Notice>
    );
  }
  if (!oauthConfigured) {
    return (
      <Notice tone="warn">
        Email sync isn&apos;t configured on this deployment yet — the Google OAuth
        credentials (GMAIL_CLIENT_ID / SECRET / redirect) and an encryption key
        must be set in the environment before anyone can connect.
      </Notice>
    );
  }

  return connection ? (
    <ConnectedCard connection={connection} />
  ) : (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="flex items-center gap-3">
        <Mail className="h-5 w-5 text-slate-400" />
        <div className="flex-1">
          <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
            Connect your Gmail
          </div>
          <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Read-only access. Emails with your deal contacts are captured
            automatically; everything else is ignored.
          </div>
        </div>
        <a
          href="/api/integrations/gmail/connect"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500"
        >
          Connect Gmail
        </a>
      </div>
    </div>
  );
}

function ConnectedCard({ connection }: { connection: Connection }) {
  const [pending, startTransition] = useTransition();

  function disconnect() {
    startTransition(async () => {
      const res = await disconnectGmailAction();
      if (!res.ok) toast.error(res.message);
      else toast.success('Gmail disconnected. Captured emails are kept.');
    });
  }

  const isError = connection.syncStatus === 'error';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-[#262626] dark:bg-[#0F0F0F]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {isError ? (
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            )}
            <div>
              <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
                {connection.email}
              </div>
              <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                {isError ? (
                  <span className="text-amber-600">Sync error: {connection.lastError}</span>
                ) : (
                  <>
                    Connected · last sync{' '}
                    {connection.lastSyncAt
                      ? new Date(connection.lastSyncAt).toLocaleString()
                      : 'pending (runs every 10 min)'}
                  </>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={disconnect}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 dark:border-[#333] dark:text-[#D4D4D8] dark:hover:bg-[#161616]"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Disconnect
          </button>
        </div>
        <p className="mt-3 text-[11px] text-slate-400">
          Captured emails show a &ldquo;via gmail&rdquo; label in the activity
          feed and count toward deal health + stage-gate activity requirements.
        </p>
      </div>

      <ExclusionEditor
        initialDomains={connection.excludedDomains}
        initialAddresses={connection.excludedAddresses}
      />
    </div>
  );
}

function ExclusionEditor({
  initialDomains,
  initialAddresses,
}: {
  initialDomains: string[];
  initialAddresses: string[];
}) {
  const [domains, setDomains] = useState(initialDomains.join('\n'));
  const [addresses, setAddresses] = useState(initialAddresses.join('\n'));
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await updateExclusionsAction({
        domains: domains.split('\n').map((s) => s.trim()).filter(Boolean),
        addresses: addresses.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      if (!res.ok) toast.error(res.message);
      else toast.success('Exclusions saved.');
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
        Never sync
      </div>
      <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
        Domains or addresses to always ignore (one per line). Your own mailbox
        domain is excluded automatically.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Domains
          <textarea
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            rows={4}
            placeholder="competitor.com"
            className="rounded-md border border-slate-200 px-2 py-1.5 text-[12px] text-slate-900 dark:border-[#333] dark:bg-[#161616] dark:text-[#FAFAFA]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Addresses
          <textarea
            value={addresses}
            onChange={(e) => setAddresses(e.target.value)}
            rows={4}
            placeholder="noreply@calendar.google.com"
            className="rounded-md border border-slate-200 px-2 py-1.5 text-[12px] text-slate-900 dark:border-[#333] dark:bg-[#161616] dark:text-[#FAFAFA]"
          />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500',
            pending && 'opacity-60',
          )}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'muted' | 'warn';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4 text-[12px]',
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-[#262626] dark:bg-[#0F0F0F] dark:text-[#A1A1AA]',
      )}
    >
      {children}
    </div>
  );
}
