import { withTenantSession } from '@/lib/auth-guard';
import { listAdminCustomFields } from '@/lib/custom-fields/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { CustomFieldsTabs } from './_components/custom-fields-tabs';

export const metadata = {
  title: 'Custom fields · Settings',
};

export default async function CustomFieldsSettingsPage() {
  // Owner + admin (the 'admin' persona).
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [deal, company, contact] = await Promise.all([
      listAdminCustomFields(tenant.id, 'deal'),
      listAdminCustomFields(tenant.id, 'company'),
      listAdminCustomFields(tenant.id, 'contact'),
    ]);
    return <CustomFieldsTabs deal={deal} company={company} contact={contact} />;
  });
}
