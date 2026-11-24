'use client';

import type { QuoteTheme } from '@/lib/quotes/template-schema';

import { Field, inputCls, NumberInput, selectCls } from './section-settings/controls';

const HEX = /^#[0-9a-f]{6}$/i;

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          className="h-9 w-10 shrink-0 cursor-pointer rounded border border-slate-200 bg-white p-0.5 dark:border-[#2A2A2A] dark:bg-[#111111]"
          value={HEX.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
        />
        <input id={id} className={`${inputCls} font-mono`} value={value} maxLength={7} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Field>
  );
}

export function ThemeSettings({ theme, onChange }: { theme: QuoteTheme; onChange: (t: QuoteTheme) => void }) {
  const set = <K extends keyof QuoteTheme>(key: K, value: QuoteTheme[K]) => onChange({ ...theme, [key]: value });
  return (
    <div className="space-y-3">
      <Field
        label="Layout"
        htmlFor="th-layout"
        hint={
          theme.layout === 'classic'
            ? 'Boxed GST proforma grid. Sections fill fixed boxes: payment schedule and terms sit in the top-right grid, text blocks in the bottom-left box, so section order is ignored.'
            : 'Sections stack top to bottom in the order on the left.'
        }
      >
        <select
          id="th-layout"
          className={selectCls}
          value={theme.layout ?? 'modern'}
          onChange={(e) => set('layout', e.target.value as NonNullable<QuoteTheme['layout']>)}
        >
          <option value="modern">Modern</option>
          <option value="classic">Classic (boxed proforma)</option>
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColorField id="th-primary" label="Primary colour" value={theme.primaryColor} onChange={(v) => set('primaryColor', v)} />
        <ColorField id="th-accent" label="Accent colour" value={theme.accentColor} onChange={(v) => set('accentColor', v)} />
        <Field label="Font" htmlFor="th-font">
          <select
            id="th-font"
            className={selectCls}
            value={theme.fontFamily}
            onChange={(e) => set('fontFamily', e.target.value as QuoteTheme['fontFamily'])}
          >
            <option value="noto-sans">Noto Sans</option>
            <option value="inter">Inter</option>
            <option value="roboto">Roboto</option>
          </select>
        </Field>
        <Field label="Base font size (pt)" htmlFor="th-size" hint="8 to 12">
          <NumberInput id="th-size" min={8} max={12} step={0.5} value={theme.baseFontSize} onChange={(v) => set('baseFontSize', v)} />
        </Field>
        <Field label="Page size" htmlFor="th-page">
          <select
            id="th-page"
            className={selectCls}
            value={theme.pageSize}
            onChange={(e) => set('pageSize', e.target.value as QuoteTheme['pageSize'])}
          >
            <option value="A4">A4</option>
            <option value="LETTER">US Letter</option>
          </select>
        </Field>
        <Field label="Margins (mm)" htmlFor="th-margin" hint="10 to 30">
          <NumberInput id="th-margin" min={10} max={30} value={theme.marginsMm} onChange={(v) => set('marginsMm', v)} />
        </Field>
        <Field label="Logo" htmlFor="th-logo">
          <select
            id="th-logo"
            className={selectCls}
            value={theme.logoSource === 'none' ? 'none' : 'org'}
            onChange={(e) => set('logoSource', e.target.value as QuoteTheme['logoSource'])}
          >
            <option value="org">Organisation logo</option>
            <option value="none">No logo</option>
          </select>
        </Field>
      </div>
      <p className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
        The logo is uploaded in Settings → Organization. The preview uses sample data with this workspace&apos;s logo.
      </p>
    </div>
  );
}
