'use client';

import { Palette } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { updateAppearanceSettingsAction } from '../../actions';
import {
  SelectRow,
  SettingsForm,
  SettingsSection,
  ToggleRow,
} from '../../_components/settings-form';

type Values = {
  defaultTheme: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'compact';
  reducedMotion: boolean;
};

/**
 * Workspace-level appearance defaults that complement the per-user
 * ThemePicker above. These persist into `organization_settings` so a
 * new teammate's first paint matches the workspace conventions.
 *
 * Notes:
 *   - `defaultTheme` is the workspace fallback. Personal next-themes
 *     selection still overrides for users who've picked one.
 *   - Density + reducedMotion are organisation-wide hints — UI
 *     consumers will read these via getOrgSettings in CP#16C-D when
 *     density gets wired into table chrome.
 */
export function AppearanceExtrasForm({ initial }: { initial: Values }) {
  const formRef = useRef<HTMLDivElement>(null);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const read = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)
        ?.value ?? '';
    const readCheck = (name: string) =>
      (root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.checked ?? false;
    return {
      defaultTheme: read('defaultTheme') as Values['defaultTheme'],
      density: read('density') as Values['density'],
      reducedMotion: readCheck('reducedMotion'),
    };
  }, [initial]);

  return (
    <div ref={formRef}>
      <SettingsForm
        initial={initial}
        action={updateAppearanceSettingsAction}
        collectChanges={collect}
        submitLabel="Save workspace defaults"
      >
        <SettingsSection
          title="Workspace defaults"
          description="What new teammates see on first paint. Your own theme picker above wins for you."
          icon={Palette}
        >
          <SelectRow
            name="defaultTheme"
            label="Default theme"
            description="Light is the recommended first-paint. Dark is true neutral black."
            defaultValue={initial.defaultTheme}
            options={[
              { value: 'light', label: 'Light (recommended)' },
              { value: 'dark', label: 'Dark — true neutral black' },
              { value: 'system', label: 'System — follow OS' },
            ]}
          />
          <SelectRow
            name="density"
            label="Density"
            description="Comfortable is the default. Compact reduces vertical padding in tables and lists (rolls out with CP#16C-D)."
            defaultValue={initial.density}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
          <ToggleRow
            name="reducedMotion"
            label="Reduce motion"
            description="Disables fades and slide animations across the app. Honored by client components opting into the preference."
            defaultChecked={initial.reducedMotion}
          />
        </SettingsSection>
      </SettingsForm>
    </div>
  );
}
