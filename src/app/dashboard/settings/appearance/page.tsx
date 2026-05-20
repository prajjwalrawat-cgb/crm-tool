import { withTenantSession } from '@/lib/auth-guard';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { AppearanceExtrasForm } from './_components/appearance-extras-form';
import { ThemePicker } from './_components/theme-picker';

export const metadata = {
  title: 'Appearance · Settings',
};

export default async function AppearanceSettingsPage() {
  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    return (
      <div className="space-y-6">
        <section>
          <header className="mb-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Theme
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Light is the default. Your personal selection is remembered in
              this browser; the workspace-level fallback is configured below.
            </p>
          </header>
          <ThemePicker />
        </section>

        <AppearanceExtrasForm
          initial={{
            defaultTheme: settings.defaultTheme as 'light' | 'dark' | 'system',
            density: settings.density as 'comfortable' | 'compact',
            reducedMotion: settings.reducedMotion,
          }}
        />

        <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <header className="mb-2">
            <h3 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              Palette reference
            </h3>
            <p className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              The chrome colors each theme paints. Dark mode is true neutral
              black — no blue tint.
            </p>
          </header>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PaletteSample label="Background" light="#F8FAFC" dark="#000000" />
            <PaletteSample label="Surface" light="#FFFFFF" dark="#0A0A0A" />
            <PaletteSample label="Border" light="#E2E8F0" dark="#1F1F1F" />
            <PaletteSample label="Text" light="#0F172A" dark="#FAFAFA" />
          </dl>
        </section>
      </div>
    );
  });
}

function PaletteSample({
  label,
  light,
  dark,
}: {
  label: string;
  light: string;
  dark: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 p-2.5 dark:border-[#1F1F1F]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <div
          className="h-6 flex-1 rounded border border-slate-200"
          style={{ background: light }}
          title={`Light: ${light}`}
        />
        <div
          className="h-6 flex-1 rounded border border-[#1F1F1F]"
          style={{ background: dark }}
          title={`Dark: ${dark}`}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9.5px] text-slate-500 dark:text-[#A1A1AA]">
        <span>{light}</span>
        <span>{dark}</span>
      </div>
    </div>
  );
}
