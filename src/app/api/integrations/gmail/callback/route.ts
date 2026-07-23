import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import {
  exchangeCodeForTokens,
  getProfile,
  gmailConfigured,
} from '@/lib/email/gmail/client';
import { upsertConnection } from '@/lib/email/gmail/connections';
import { verifyState } from '@/lib/email/gmail/oauth-state';

/**
 * OAuth callback — exchanges the auth code for tokens, encrypts + stores the
 * refresh token, records the mailbox + initial historyId, then returns the user
 * to the Email Sync settings page. Cross-checks the signed `state` against the
 * live session so a connection can only be made for the current user/tenant.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const settings = new URL('/dashboard/settings/email-sync', url.origin);

  const err = url.searchParams.get('error');
  if (err) {
    settings.searchParams.set('error', 'access_denied');
    return NextResponse.redirect(settings);
  }
  if (!gmailConfigured()) {
    settings.searchParams.set('error', 'not_configured');
    return NextResponse.redirect(settings);
  }

  const code = url.searchParams.get('code');
  const decoded = verifyState(url.searchParams.get('state'));
  const { userId, orgId } = await auth();

  // State must be valid AND match the live session (CSRF + wrong-account guard).
  if (
    !code ||
    !decoded ||
    !userId ||
    !orgId ||
    decoded.userId !== userId ||
    decoded.tenantId !== orgId
  ) {
    settings.searchParams.set('error', 'invalid_state');
    return NextResponse.redirect(settings);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refreshToken) {
      // No refresh token → user previously granted; force re-consent.
      settings.searchParams.set('error', 'no_refresh_token');
      return NextResponse.redirect(settings);
    }
    const profile = await getProfile(tokens.accessToken);

    await runWithTenantContext({ tenantId: orgId, userId }, async () => {
      await upsertConnection({
        tenantId: orgId,
        userId,
        email: profile.email,
        refreshToken: tokens.refreshToken!,
        historyId: profile.historyId,
      });
    });

    settings.searchParams.set('connected', '1');
    return NextResponse.redirect(settings);
  } catch {
    settings.searchParams.set('error', 'exchange_failed');
    return NextResponse.redirect(settings);
  }
}
