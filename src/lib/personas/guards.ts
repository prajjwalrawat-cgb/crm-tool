import 'server-only';

import { redirect } from 'next/navigation';

import { getCurrentMembership } from '@/lib/membership';

import { personaOf, type Persona } from './index';

/**
 * Server-side persona guard for admin/manager-only routes.
 *
 * Resolves the current user's persona from their membership row and
 * redirects to `/dashboard` if it isn't in the allowed set. Sidebar
 * filtering hides these routes from the nav for the wrong personas;
 * this guard is the actual gate — it catches deep-links, bookmarks,
 * and crafted URLs.
 *
 * Usage at the top of a server-rendered page:
 *
 *   export default async function Page() {
 *     await requirePersonas(['admin']);
 *     // ...
 *   }
 *
 * No-membership and unresolvable-role cases fall to 'sales' via
 * `personaOf`, so they redirect away from anything elevated — no
 * accidental privilege escalation through a missing row.
 */
export async function requirePersonas(allowed: readonly Persona[]): Promise<void> {
  const membership = await getCurrentMembership();
  const persona = personaOf(membership?.role ?? null);
  if (!allowed.includes(persona)) {
    redirect('/dashboard');
  }
}
