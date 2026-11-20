'use client';

import { Plus, Trash2 } from 'lucide-react';

import { RichTextEditor } from '@/components/quotes/rich-text-editor';
import { EMPTY_PARTY, bpsToPercent, percentToBps, type EditorParty } from '@/lib/quotes/editor-form';
import { INDIAN_STATES } from '@/lib/invoices/india-geo';
import type { QuoteSection, SectionContent } from '@/lib/quotes/template-schema';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../../settings/lead-capture/_components/ui';

/* --------------------------------- shared --------------------------------- */

export const errorCls = (messages?: string[]) => (messages?.length ? 'border-rose-400 dark:border-rose-500/60' : undefined);

export function FieldErrors({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return <p className="mt-0.5 text-[11.5px] text-rose-600 dark:text-rose-400">{messages.join(' ')}</p>;
}

function TextField({
  label,
  value,
  onChange,
  errors,
  readOnly,
  multiline,
  type = 'text',
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  errors?: string[];
  readOnly: boolean;
  multiline?: boolean;
  type?: string;
  className?: string;
}) {
  const cls = cn(inputCls, 'py-1.5', errorCls(errors));
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">{label}</span>
      {multiline ? (
        <textarea rows={2} className={cn(cls, 'resize-y')} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type={type} className={cls} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
      )}
      <FieldErrors messages={errors} />
    </label>
  );
}

/* ----------------------------- client details ----------------------------- */

function PartyFields({
  prefix,
  party,
  onChange,
  errors,
  readOnly,
  withContact,
}: {
  prefix: 'buyer' | 'consignee';
  party: EditorParty;
  onChange: (p: EditorParty) => void;
  errors: Record<string, string[]>;
  readOnly: boolean;
  withContact: boolean;
}) {
  const set = (k: keyof EditorParty) => (v: string) => onChange({ ...party, [k]: v });
  const e = (k: keyof EditorParty) => errors[`${prefix}.${k}`];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <TextField label="Name" value={party.name} onChange={set('name')} errors={e('name')} readOnly={readOnly} className="sm:col-span-2" />
      {withContact ? (
        <>
          <TextField label="Contact person" value={party.contactName} onChange={set('contactName')} errors={e('contactName')} readOnly={readOnly} />
          <TextField label="Contact email" type="email" value={party.contactEmail} onChange={set('contactEmail')} errors={e('contactEmail')} readOnly={readOnly} />
        </>
      ) : null}
      <TextField label="Address" multiline value={party.address} onChange={set('address')} errors={e('address')} readOnly={readOnly} className="sm:col-span-2" />
      <TextField label="Locality" value={party.locality} onChange={set('locality')} errors={e('locality')} readOnly={readOnly} />
      <TextField label="City" value={party.city} onChange={set('city')} errors={e('city')} readOnly={readOnly} />
      <TextField label="PIN code" value={party.pincode} onChange={set('pincode')} errors={e('pincode')} readOnly={readOnly} />
      <TextField label="GSTIN" value={party.gstin} onChange={set('gstin')} errors={e('gstin')} readOnly={readOnly} />
      <label className="block space-y-1 sm:col-span-2">
        <span className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">State</span>
        <select
          className={cn(inputCls, 'py-1.5', errorCls(e('stateCode')))}
          value={party.stateCode}
          disabled={readOnly}
          onChange={(ev) => {
            const st = INDIAN_STATES.find((s) => s.code === ev.target.value);
            onChange({ ...party, stateCode: st?.code ?? '', state: st?.name ?? '' });
          }}
        >
          <option value="">Select a state</option>
          {INDIAN_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.code})
            </option>
          ))}
        </select>
        <FieldErrors messages={e('stateCode')} />
      </label>
    </div>
  );
}

export function ClientDetailsEditor({
  section,
  buyer,
  consignee,
  onBuyerChange,
  onConsigneeChange,
  errors,
  readOnly,
}: {
  section: Extract<QuoteSection, { type: 'client' }>;
  buyer: EditorParty;
  consignee: EditorParty | null;
  onBuyerChange: (p: EditorParty) => void;
  onConsigneeChange: (p: EditorParty | null) => void;
  errors: Record<string, string[]>;
  readOnly: boolean;
}) {
  const { billToLabel, shipToLabel, showShipTo } = section.settings;
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">{billToLabel || 'Bill to'}</h4>
        <PartyFields prefix="buyer" party={buyer} onChange={onBuyerChange} errors={errors} readOnly={readOnly} withContact />
      </div>
      {showShipTo ? (
        <div className="space-y-2">
          <label className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-[#D4D4D8]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-indigo-600"
              checked={consignee !== null}
              disabled={readOnly}
              onChange={(e) => onConsigneeChange(e.target.checked ? { ...EMPTY_PARTY } : null)}
            />
            Separate {(shipToLabel || 'Ship to').toLowerCase()} address
          </label>
          {consignee ? (
            <PartyFields prefix="consignee" party={consignee} onChange={onConsigneeChange} errors={errors} readOnly={readOnly} withContact={false} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- text / terms / schedule --------------------------- */

type EditableSection = Extract<QuoteSection, { type: 'text' | 'terms' | 'payment_schedule' }>;

/** Rep-editable content of one text, terms or payment schedule section. */
export function SectionContentEditor({
  section,
  content,
  onChange,
  errors,
  readOnly,
}: {
  section: EditableSection;
  content: SectionContent | undefined;
  onChange: (c: SectionContent) => void;
  errors: Record<string, string[]>;
  readOnly: boolean;
}) {
  const label = section.title.trim() || (section.type === 'terms' ? 'Terms' : section.type === 'text' ? 'Text' : 'Payment schedule');
  const errorsUnder = Object.entries(errors)
    .filter(([k]) => k === `content.${section.id}` || k.startsWith(`content.${section.id}.`))
    .flatMap(([, m]) => m);

  if (section.type === 'payment_schedule') {
    const milestones = content?.milestones ?? section.settings.defaultMilestones;
    const sum = milestones.reduce((a, m) => a + (Number.isFinite(m.percentBps) ? m.percentBps : 0), 0);
    const setMilestones = (next: typeof milestones) => onChange({ ...content, milestones: next });
    const patch = (i: number, p: Partial<(typeof milestones)[number]>) =>
      setMilestones(milestones.map((m, j) => (j === i ? { ...m, ...p } : m)));
    return (
      <div className="space-y-2">
        {milestones.map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              aria-label={`Milestone ${i + 1} label`}
              className={cn(inputCls, 'py-1.5')}
              value={m.label}
              placeholder="e.g. Advance with order"
              readOnly={readOnly}
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <div className="relative w-28 shrink-0">
              <input
                aria-label={`Milestone ${i + 1} percent`}
                inputMode="decimal"
                className={cn(inputCls, 'py-1.5 pr-7 text-right')}
                // NaN (unparseable) shows as empty; the schema then flags it.
                value={Number.isFinite(m.percentBps) ? bpsToPercent(m.percentBps) : ''}
                readOnly={readOnly}
                onChange={(e) => patch(i, { percentBps: percentToBps(e.target.value) })}
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">%</span>
            </div>
            {readOnly ? null : (
              <Button variant="ghost" aria-label={`Remove milestone ${i + 1}`} onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between">
          {readOnly ? (
            <span />
          ) : (
            <Button onClick={() => setMilestones([...milestones, { label: '', percentBps: Math.max(0, 10_000 - sum) }])}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add milestone
            </Button>
          )}
          <span
            className={cn(
              'text-[12px] font-medium',
              sum === 10_000 ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300',
            )}
          >
            Total {sum / 100}%
          </span>
        </div>
        <FieldErrors messages={errorsUnder} />
      </div>
    );
  }

  const key = section.type === 'text' ? 'text' : 'terms';
  const doc = content?.[key] ?? section.settings.defaultText;
  return (
    <div className="space-y-1">
      <RichTextEditor value={doc} onChange={(next) => onChange({ ...content, [key]: next })} ariaLabel={label} editable={!readOnly} />
      <FieldErrors messages={errorsUnder} />
    </div>
  );
}
