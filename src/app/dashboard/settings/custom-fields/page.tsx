import { withTenantSession } from '@/lib/auth-guard';
import { listAdminCustomFields } from '@/lib/custom-fields/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { CustomFieldsManager } from './_components/custom-fields-manager';

export const metadata = {
  title: 'Custom fields · Settings',
};

export default async function CustomFieldsSettingsPage() {
  // Owner + admin (the 'admin' persona).
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const fields = await listAdminCustomFields(tenant.id, 'deal');
    return (
      <CustomFieldsManager entityType="deal" entityLabel="Deal" initial={fields} />
    );
  });
}
