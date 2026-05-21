import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { EmailForm } from './_components/email-form';

export const metadata = {
  title: 'Email · Settings',
};

export default async function EmailSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    return (
      <EmailForm
        initial={{
          senderName: settings.senderName ?? '',
          senderEmail: settings.senderEmail ?? '',
          defaultSignature: settings.defaultSignature ?? '',
          replyTo: settings.replyTo ?? '',
          autoBcc: settings.autoBcc ?? '',
          emailTracking: settings.emailTracking,
        }}
      />
    );
  });
}
