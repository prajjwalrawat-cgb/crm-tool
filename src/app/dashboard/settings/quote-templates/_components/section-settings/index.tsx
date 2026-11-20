'use client';

import type { QuoteSection } from '@/lib/quotes/template-schema';

import { ClientSettings } from './client';
import { Field, inputCls } from './controls';
import { CustomFieldsSettings, type DealFieldOption } from './custom-fields';
import { HeaderSettings } from './header';
import { LineItemsSettings } from './line-items';
import { PageBreakSettings } from './page-break';
import { PaymentScheduleSettings } from './payment-schedule';
import { SignatureSettings } from './signature';
import { TermsSettings } from './terms';
import { TextSettings } from './text';
import { TotalsSettings } from './totals';

export type { DealFieldOption };

/** Section types whose PDF renderer prints `title` as a heading. */
const PRINTS_TITLE = new Set<QuoteSection['type']>(['text', 'terms', 'payment_schedule', 'custom_fields']);

function TypeSettings({
  section,
  onChange,
  dealFields,
}: {
  section: QuoteSection;
  onChange: (next: QuoteSection) => void;
  dealFields: DealFieldOption[];
}) {
  switch (section.type) {
    case 'header':
      return <HeaderSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'client':
      return <ClientSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'text':
      return <TextSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'line_items':
      return <LineItemsSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'totals':
      return <TotalsSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'payment_schedule':
      return <PaymentScheduleSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'terms':
      return <TermsSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'custom_fields':
      return (
        <CustomFieldsSettings section={section} dealFields={dealFields} onChange={(settings) => onChange({ ...section, settings })} />
      );
    case 'signature':
      return <SignatureSettings section={section} onChange={(settings) => onChange({ ...section, settings })} />;
    case 'page_break':
      return <PageBreakSettings />;
  }
}

/** Title plus the per-type form for one section. */
export function SectionSettings({
  section,
  onChange,
  dealFields,
}: {
  section: QuoteSection;
  onChange: (next: QuoteSection) => void;
  dealFields: DealFieldOption[];
}) {
  return (
    <div className="space-y-4">
      {section.type !== 'page_break' ? (
        <Field
          label={PRINTS_TITLE.has(section.type) ? 'Section heading' : 'Section name'}
          htmlFor="section-title"
          hint={
            PRINTS_TITLE.has(section.type)
              ? 'Printed above the section; leave empty for none.'
              : 'Shown in the section list only; not printed.'
          }
        >
          <input
            id="section-title"
            className={inputCls}
            value={section.title}
            onChange={(e) => onChange({ ...section, title: e.target.value })}
          />
        </Field>
      ) : null}
      <TypeSettings section={section} onChange={onChange} dealFields={dealFields} />
    </div>
  );
}
