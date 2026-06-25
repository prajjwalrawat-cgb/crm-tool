import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, verifySession } from '@/lib/auth/jwt';

/**
 * Self-hosted session gate (replaces Clerk middleware). Verifies the
 * signed session cookie (HS256 via jose — Edge-safe), redirects
 * unauthenticated users to /sign-in, and users without an active
 * workspace to /select-org. Authorization (roles) is enforced deeper,
 * against the memberships table.
 */

// Exact paths or path-prefixes that never require a session.
const PUBLIC_PATHS = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
];
// Inngest verifies its own requests via signed headers — auth here is the
// wrong layer.
const PUBLIC_PREFIXES = ['/api/inngest'];

function isPublic(pathname: string): boolean {
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return true;
  }
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function isOrgFree(pathname: string): boolean {
  return pathname === '/select-org' || pathname.startsWith('/select-org/');
}

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const claims = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );

  if (!claims) {
    const url = new URL('/sign-in', request.url);
    if (pathname && pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (!claims.tid && !isOrgFree(pathname)) {
    return NextResponse.redirect(new URL('/select-org', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets unless they appear in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API and tRPC routes.
    '/(api|trpc)(.*)',
  ],
};
