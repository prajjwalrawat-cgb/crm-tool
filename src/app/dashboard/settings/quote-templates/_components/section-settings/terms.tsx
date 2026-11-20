'use client';

import { RichTextEditor } from '../rich-text-editor';
import { Field, ToggleRow, type SectionFormProps } from './controls';

export function TermsSettings({ section, onChange }: SectionFormProps<'terms'>) {
  const s = section.settings;
  return (
    <div className="space-y-3">
      <Field label="Default terms" hint="Placeholders are filled in from the deal when a quote is created.">
        <RichTextEditor
          key={section.id}
          ariaLabel="Default terms"
          value={s.defaultText}
          onChange={(doc) => onChange({ ...s, defaultText: doc })}
        />
      </Field>
      <ToggleRow
        label="Reps can edit the terms on a quote"
        checked={s.repEditable}
        onChange={(v) => onChange({ ...s, repEditable: v })}
      />
    </div>
  );
}
