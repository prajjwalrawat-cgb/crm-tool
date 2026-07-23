import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth/server';
import { buildAuthUrl, gmailConfigured } from '@/lib/email/gmail/client';
import { signState } from '@/lib/email/gmail/oauth-state';

/**
 * Start the Gmail OAuth flow for the signed-in user. Redirects to Google's
 * consent screen with a signed `state`. The callback finishes the connection.
 */
export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.redirect(new URL('/sign-in', baseUrl()));
  }
  if (!gmailConfigured()) {
    return NextResponse.redirect(
      new URL('/dashboard/settings/email-sync?error=not_configured', baseUrl()),
    );
  }
  const state = signState({ tenantId: orgId, userId });
  return NextResponse.redirect(buildAuthUrl(state));
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.GMAIL_OAUTH_REDIRECT_URI?.replace(
      /\/api\/integrations\/gmail\/callback$/,
      '',
    ) ??
    'http://localhost:3000'
  );
}
