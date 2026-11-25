import { requirePermission, withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { getFieldSettings } from '@/lib/field/settings';

import { FieldSettingsForm } from './_components/field-settings-form';

export const metadata = { title: 'Field meetings · Settings' };

/** Owner/admin: check-in radius, grace, MOM due and tracking hours for Field meetings. */
export default async function FieldSettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    await requirePermission('manageFieldSettings');
    const settings = await tenantTransaction((tx) => getFieldSettings(tx, tenant.id));
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-[#FAFAFA]">Field meetings</h1>
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Check-in distance, how long before a missed visit is flagged, when meeting notes are due, and the hours
            location is tracked.
          </p>
        </header>
        <FieldSettingsForm initial={settings} />
      </div>
    );
  });
}
