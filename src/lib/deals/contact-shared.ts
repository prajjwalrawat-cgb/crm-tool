import type { DealContactRole } from '@/db/schema';

/**
 * Client-safe deal-contact helpers and types. Kept out of `contacts.ts`
 * (which is `server-only`) so client components can import the labels and the
 * row type without pulling the DB layer into the browser bundle.
 */

export type DealContactRow = {
  id: string;
  contactId: string;
  role: DealContactRole;
  isPrimary: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
};

export function dealContactName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const parts = [row.firstName, row.lastName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' ');
  return row.email ?? '(unnamed)';
}

export const DEAL_CONTACT_ROLE_LABELS: Record<DealContactRole, string> = {
  decision_maker: 'Decision Maker',
  influencer: 'Influencer',
  champion: 'Champion',
  blocker: 'Blocker',
  other: 'Other',
};
