'use client';

import { useEffect, useRef, useState } from 'react';

import { AuthShell } from '@/components/auth/auth-shell';

/** Hands the one-time link to the server; what went wrong, or null once it is redirecting. */
async function signIn(token: string | null, next: string | null): Promise<string | null> {
  if (!token) return 'This AskMira link is not complete. Open Saleinx again from AskMira.';
  try {
    const res = await fetch('/api/integrations/askmira/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.redirect_to) {
      return data.error ?? 'Could not sign you in. Open Saleinx again from AskMira.';
    }
    window.location.replace(data.redirect_to);
    return null;
  } catch {
    return 'Could not reach Saleinx. Try again in a minute.';
  }
}

/**
 * /sso/askmira#token=… — someone opened Saleinx from AskMira. The one-time
 * link rides in the fragment, which never reaches a server log; this page
 * hands it to the server, which starts a normal session and says where to go.
 */
export default function AskMiraSignIn() {
  const [error, setError] = useState<string | null>(null);
  // The link works once: never send it twice (React runs effects twice in development).
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    // Take the link out of the address bar and history before using it.
    window.history.replaceState(null, '', window.location.pathname);
    void signIn(hash.get('token'), hash.get('next')).then((problem) => {
      if (problem) setError(problem);
    });
  }, []);

  return (
    <AuthShell subtitle="Signing you in from AskMira">
      {error ? (
        <p role="alert" className="text-[13px] text-amber-800 dark:text-amber-200">
          {error}
        </p>
      ) : (
        <p className="text-[13px] text-slate-500">One moment…</p>
      )}
    </AuthShell>
  );
}
