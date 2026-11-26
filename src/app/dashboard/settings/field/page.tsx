import { requirePermission, withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { getFieldSettings } from '@/lib/field/settings';
import { can } from '@/lib/rbac';

import { FieldSettingsForm } from './_components/field-settings-form';

export const metadata = { title: 'Field meetings · Settings' };

/**
 * Field meetings settings. Owner/admin edit everything; managers see the page
 * and edit only the check-in window (the rest is read-only for them).
 */
export default async function FieldSettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    const { membership } = await requirePermission('manageFieldCheckinWindow');
    const canManageAll = can(membership.role, 'manageFieldSettings');
    const settings = await tenantTransaction((tx) => getFieldSettings(tx, tenant.id));
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-[#FAFAFA]">Field meetings</h1>
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Check-in distance and time window, how long before a missed visit is flagged, when meeting notes are due, and the hours
            location is tracked.
          </p>
        </header>
        <FieldSettingsForm initial={settings} canManageAll={canManageAll} />
      </div>
    );
  });
}
