import { redirect } from 'next/navigation';

/**
 * /dashboard/email is deprecated as of Phase 17-A. Communications is
 * the single inbox + threading surface. Bookmarks land on
 * /dashboard/communications.
 *
 * Admin Mail Ops (delivery monitoring, retries, provider analytics)
 * lives at /dashboard/ops and is reachable from the admin sidebar as
 * "Mail Ops".
 */
export default function EmailPage() {
  redirect('/dashboard/communications');
}
