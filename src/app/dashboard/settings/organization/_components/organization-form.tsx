'use client';

import { Building2 } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { SUPPORTED_LOCALES } from '@/lib/currency/format';

import { updateOrganizationSettingsAction } from '../../actions';
import {
  InputRow,
  SelectRow,
  SettingsForm,
  SettingsSection,
} from '../../_components/settings-form';

type Values = {
  displayName: string;
  locale: string;
  timezone: string;
};

export function OrganizationForm({
  initial,
  timezones,
  tenantName,
}: {
  initial: Values;
  timezones: string[];
  tenantName: string;
}) {
  const formRef = useRef<HTMLDivElement>(null);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const read = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)
        ?.value ?? '';
    return {
      displayName: read('displayName'),
      locale: read('locale'),
      timezone: read('timezone'),
    };
  }, [initial]);

  return (
    <div ref={formRef}>
      <SettingsForm
        initial={initial}
        action={updateOrganizationSettingsAction}
        collectChanges={collect}
      >
        <SettingsSection
          title="Organization"
          description={`Workspace identity and regional defaults. Connected to Clerk organization "${tenantName}".`}
          icon={Building2}
        >
          <InputRow
            name="displayName"
            label="Workspace display name"
            description="Shown in headers, emails, and reports. Defaults to the Clerk organization name if blank."
            defaultValue={initial.displayName}
            placeholder={tenantName}
          />
          <SelectRow
            name="locale"
            label="Organization locale"
            description="Drives date/number formatting outside the currency-specific surfaces."
            defaultValue={initial.locale}
            options={SUPPORTED_LOCALES.map((l) => ({ value: l.code, label: l.label }))}
          />
          <SelectRow
            name="timezone"
            label="Timezone"
            description="Used to render Stamps in reports and the activity feed."
            defaultValue={initial.timezone}
            options={timezones.map((tz) => ({ value: tz, label: tz }))}
          />
        </SettingsSection>
      </SettingsForm>
    </div>
  );
}
