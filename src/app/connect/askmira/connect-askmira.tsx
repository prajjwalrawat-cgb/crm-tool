'use client';

import { useState } from 'react';

type Current = {
  can_connect: boolean;
  workspace: { id: string; name: string };
  connected: boolean;
  askmira_workspace_id: string | null;
  askmira_workspace: string | null;
  askmira_origin: string | null;
  connected_at: string | null;
};

export type Ask = {
  tenant_id: string;
  tenant_name: string;
  redirect_uri: string;
  state: string;
  challenge: string;
};

/** What AskMira will be able to do once allowed. */
const GRANTS = [
  'Open Saleinx for your members from AskMira, without a second password.',
  'Let Ask Mira read and change deals for a member with that member’s own access here: a rep’s Won still waits for a manager, a viewer still only reads.',
  'Switch off a member AskMira linked when they leave the company in AskMira. Their deals stay.',
  'AskMira never adds anyone here and never changes a role: your owners and admins still decide both.',
];

function originOf(uri: string) {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

const button =
  'inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-[13.5px] font-medium shadow-sm transition focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';

export function ConnectAskMira({
  refused,
  current,
  ask,
}: {
  refused: string | null;
  current: Current | null;
  ask: Ask | null;
}) {
  const [state, setState] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (refused) return <Message tone="warning" text={refused} />;
  if (!state) return <Message tone="warning" text="Could not load this workspace." />;
  if (!state.can_connect) {
    return <Message tone="warning" text="This Saleinx is not set up to connect to AskMira yet. Ask the person who runs it." />;
  }

  const elsewhere =
    Boolean(state.connected) && (!ask || state.askmira_workspace_id !== ask.tenant_id.toLowerCase());

  const allow = async () => {
    if (!ask) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/askmira/connect/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ask),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.redirect_to) {
        setError(data.error ?? 'Could not connect. Try again.');
        setBusy(false);
        return;
      }
      window.location.assign(data.redirect_to);
    } catch {
      setError('Could not reach Saleinx. Try again.');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/askmira/connection', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? 'Could not disconnect. Try again.');
      else setState(data as Current);
    } catch {
      setError('Could not reach Saleinx. Try again.');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[16px] font-semibold text-slate-900 dark:text-[#FAFAFA]">Connect AskMira</h1>
        <p className="mt-1 text-[13px] text-slate-600 dark:text-[#A1A1AA]">
          {ask ? (
            <>
              The AskMira workspace <strong>{ask.tenant_name}</strong>
              {originOf(ask.redirect_uri) ? <> at {originOf(ask.redirect_uri)}</> : null} wants to connect to{' '}
              <strong>{state.workspace.name}</strong>.
            </>
          ) : (
            <>
              <strong>{state.workspace.name}</strong>
              {state.connected ? (
                <> is connected to the AskMira workspace {state.askmira_workspace ?? ''}.</>
              ) : (
                <> is not connected to AskMira. Start from Settings → Connectors in AskMira.</>
              )}
            </>
          )}
        </p>
      </div>

      {ask ? (
        <ul className="space-y-1.5 text-[12.5px] text-slate-600 dark:text-[#A1A1AA]">
          {GRANTS.map((g) => (
            <li key={g} className="flex gap-2">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
              <span>{g}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {elsewhere && ask ? (
        <Message
          tone="warning"
          text={`${state.workspace.name} is already connected to the AskMira workspace ${state.askmira_workspace ?? ''}. Disconnect it first to connect another.`}
        />
      ) : null}
      {error ? <Message tone="warning" text={error} /> : null}

      {ask && !elsewhere ? (
        <button
          type="button"
          onClick={allow}
          disabled={busy}
          className={`${button} bg-indigo-600 text-white hover:bg-indigo-500 focus:ring-indigo-500/30`}
        >
          {busy ? 'Please wait…' : `Allow AskMira to connect`}
        </button>
      ) : null}
      {state.connected ? (
        <button
          type="button"
          onClick={disconnect}
          disabled={busy}
          className={`${button} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-300 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA]`}
        >
          Disconnect AskMira
        </button>
      ) : null}
      <p className="text-center text-[12px] text-slate-500">
        <a className="font-medium hover:text-slate-700" href="/dashboard">
          Back to Saleinx
        </a>
      </p>
    </div>
  );
}

function Message({ text, tone }: { text: string; tone: 'warning' | 'info' }) {
  return (
    <p
      role={tone === 'warning' ? 'alert' : undefined}
      className={
        tone === 'warning'
          ? 'rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
          : 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700'
      }
    >
      {text}
    </p>
  );
}
