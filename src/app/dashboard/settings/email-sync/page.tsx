import { withTenantSession } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { gmailConfigured } from '@/lib/email/gmail/client';
import { getConnection } from '@/lib/email/gmail/connections';
import { getWorkspaceSettings } from '@/lib/workspace-settings/queries';

import { EmailSyncManager } from './_components/email-sync-manager';

export const metadata = { title: 'Email Sync · Settings' };

/**
 * Per-user Email Sync page. Each rep connects/disconnects their OWN Gmail — not
 * a workspace-admin setting. Gated by the workspace EMAIL_SYNC_ENABLED flag.
 */
export default async function EmailSyncSettingsPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const [settings, connection] = await Promise.all([
      getWorkspaceSettings(tenant.id),
      runWithTenantContext({ tenantId: tenant.id, userId }, () =>
        getConnection(tenant.id, userId),
      ),
    ]);

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Email sync
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Connect your Gmail so emails with your deal contacts appear
            automatically in the right deal&apos;s activity feed. We store only
            the subject and a short snippet — never full message bodies or
            attachments.
          </p>
        </header>

        <EmailSyncManager
          moduleEnabled={settings.emailSyncEnabled}
          oauthConfigured={gmailConfigured()}
          connection={
            connection
              ? {
                  email: connection.email,
                  syncStatus: connection.syncStatus,
                  lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
                  lastError: connection.lastError,
                  excludedDomains: connection.excludedDomains,
                  excludedAddresses: connection.excludedAddresses,
                }
              : null
          }
        />
      </main>
    );
  });
}
