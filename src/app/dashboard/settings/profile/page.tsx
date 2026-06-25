import { currentUser } from '@/lib/auth/server';

import { withTenantSession } from '@/lib/auth-guard';

export const metadata = {
  title: 'Profile · Settings',
};

/**
 * Profile section — read-only summary for v1. Editing (display name,
 * avatar) goes through the Clerk user dashboard until we wire an
 * in-app form. Surfacing the fields here means the user knows what
 * Saleinx sees as their identity.
 */
export default async function ProfileSettingsPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const user = await currentUser();
    const primaryEmail =
      user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      user?.emailAddresses[0]?.emailAddress ??
      null;
    const displayName =
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
      user?.username ||
      primaryEmail ||
      'Unnamed';

    return (
      <div className="space-y-6">
        <section>
          <header className="mb-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Profile
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              The identity Saleinx attaches to your activity, comments, and
              ownership. Edits go through your account provider for now.
            </p>
          </header>

          <div className="rounded-lg border border-slate-200 bg-white dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            <Row label="Display name" value={displayName} />
            <Row label="Email" value={primaryEmail ?? '—'} />
            <Row label="User id" value={<span className="font-mono text-[11px]">{userId}</span>} />
            <Row label="Workspace" value={tenant.name} />
          </div>
        </section>
      </div>
    );
  });
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0 dark:border-[#1F1F1F]">
      <span className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">{label}</span>
      <span className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{value}</span>
    </div>
  );
}
