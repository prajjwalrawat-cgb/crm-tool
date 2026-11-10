import { AuthShell } from '@/components/auth/auth-shell';
import { connection, signedInAdmin } from '@/lib/askmira/connect';
import { HttpError } from '@/lib/askmira/core';

import { type Ask, ConnectAskMira } from './connect-askmira';

export const metadata = { title: 'Connect AskMiraa' };
export const dynamic = 'force-dynamic';

type Query = Partial<Record<keyof Ask, string | string[]>>;

/** What AskMiraa asks for, from the address; null unless every part is there. */
function askOf(query: Query): Ask | null {
  const one = (key: keyof Ask) => {
    const value = query[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };
  const ask: Ask = {
    tenant_id: one('tenant_id'),
    tenant_name: one('tenant_name'),
    redirect_uri: one('redirect_uri'),
    state: one('state'),
    challenge: one('challenge'),
  };
  return Object.values(ask).every(Boolean) ? ask : null;
}

/**
 * /connect/askmira — an AskMiraa workspace asks to connect to this one. An owner
 * or admin of the active workspace presses Allow; AskMiraa then gets a key that
 * reaches this workspace only. The middleware has already sent anyone signed
 * out to sign in and back here.
 */
export default async function ConnectAskMiraPage({ searchParams }: { searchParams: Promise<Query> }) {
  const ask = askOf(await searchParams);
  let refused: string | null = null;
  let current: Awaited<ReturnType<typeof connection>> | null = null;
  try {
    current = await connection(await signedInAdmin());
  } catch (err) {
    refused = err instanceof HttpError ? err.message : 'Could not load this workspace.';
  }
  return (
    <AuthShell subtitle="Connect AskMiraa, your company's HR system">
      <ConnectAskMira refused={refused} current={current} ask={ask} />
    </AuthShell>
  );
}
