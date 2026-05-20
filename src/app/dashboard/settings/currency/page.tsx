import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { CurrencyForm } from './_components/currency-form';

export const metadata = {
  title: 'Currency & Locale · Settings',
};

export default async function CurrencySettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    return (
      <CurrencyForm
        initial={{
          defaultCurrency: settings.defaultCurrency,
          currencyLocale: settings.currencyLocale,
          compactNumbers: settings.compactNumbers,
        }}
      />
    );
  });
}
