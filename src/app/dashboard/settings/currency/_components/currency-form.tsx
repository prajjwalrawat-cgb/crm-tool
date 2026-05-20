'use client';

import { Banknote } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LOCALES,
} from '@/lib/currency/format';

import { updateCurrencySettingsAction } from '../../actions';
import {
  SelectRow,
  SettingsForm,
  SettingsSection,
  ToggleRow,
} from '../../_components/settings-form';

type Values = {
  defaultCurrency: string;
  currencyLocale: string;
  compactNumbers: boolean;
};

/**
 * Currency + locale picker with a LIVE preview. Selecting a new
 * currency immediately re-renders the preview tiles below so the
 * user can see exactly how reports / dashboards will display before
 * saving.
 */
export function CurrencyForm({ initial }: { initial: Values }) {
  const formRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Values>(initial);

  const refreshPreview = useCallback(() => {
    const root = formRef.current;
    if (!root) return;
    const read = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)
        ?.value ?? '';
    const compact =
      (root.querySelector('input[name="compactNumbers"]') as HTMLInputElement | null)
        ?.checked ?? false;
    setPreview({
      defaultCurrency: read('defaultCurrency') || initial.defaultCurrency,
      currencyLocale: read('currencyLocale') || initial.currencyLocale,
      compactNumbers: compact,
    });
  }, [initial.currencyLocale, initial.defaultCurrency]);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const read = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)
        ?.value ?? '';
    return {
      defaultCurrency: read('defaultCurrency') || initial.defaultCurrency,
      currencyLocale: read('currencyLocale') || initial.currencyLocale,
      compactNumbers:
        (root.querySelector('input[name="compactNumbers"]') as HTMLInputElement | null)
          ?.checked ?? false,
    };
  }, [initial]);

  return (
    <div ref={formRef} onChange={refreshPreview}>
      <SettingsForm
        initial={initial}
        action={updateCurrencySettingsAction}
        collectChanges={collect}
      >
        <SettingsSection
          title="Currency & Locale"
          description="The selected currency drives every money display across the platform — dashboards, reports, AI summaries, exec view, deal detail."
          icon={Banknote}
        >
          <SelectRow
            name="defaultCurrency"
            label="Default currency"
            description="ISO 4217 code. Backwards-compatible: existing deals with their own currency keep it."
            defaultValue={initial.defaultCurrency}
            options={SUPPORTED_CURRENCIES.map((c) => ({
              value: c.code,
              label: `${c.code} — ${c.label}`,
            }))}
          />
          <SelectRow
            name="currencyLocale"
            label="Currency locale"
            description="Drives grouping (1,234,567 vs 12,34,567) and symbol placement."
            defaultValue={initial.currencyLocale}
            options={SUPPORTED_LOCALES.map((l) => ({
              value: l.code,
              label: l.label,
            }))}
          />
          <ToggleRow
            name="compactNumbers"
            label="Compact number formatting"
            description="Render large amounts as ₹51L / $1.2M / €84.5K in cards and reports."
            defaultChecked={initial.compactNumbers}
          />
        </SettingsSection>

        {/*
         * Live preview tiles. Render four amounts at typical CRM
         * scales (small / medium / large / very large) so the user
         * sees both standard and compact formatting before saving.
         */}
        <section className="mt-3 rounded-md border border-slate-200 bg-slate-50/40 px-3 py-3 dark:border-[#1F1F1F] dark:bg-[#111111]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Preview
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <PreviewTile label="Small deal" amountMinor={5_000_00} ctx={preview} />
            <PreviewTile label="Mid pipeline" amountMinor={84_500_00} ctx={preview} />
            <PreviewTile label="Enterprise" amountMinor={1_200_000_00} ctx={preview} />
            <PreviewTile label="Portfolio" amountMinor={51_20_000_00} ctx={preview} />
          </div>
        </section>
      </SettingsForm>
    </div>
  );
}

function PreviewTile({
  label,
  amountMinor,
  ctx,
}: {
  label: string;
  amountMinor: number;
  ctx: Values;
}) {
  const standard = formatTenantCurrency(amountMinor, ctx);
  const compact = formatCompactTenantCurrency(amountMinor, ctx, { force: true });
  return (
    <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
        {ctx.compactNumbers ? compact : standard}
      </div>
      <div className="mt-0.5 font-mono text-[10.5px] tabular-nums text-slate-400 dark:text-[#71717A]">
        {ctx.compactNumbers ? `→ ${standard}` : `compact: ${compact}`}
      </div>
    </div>
  );
}
