'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { saveQuoteSettingsAction } from '@/lib/quotes/actions';
import { fiscalYearLabel, formatQuoteNumber } from '@/lib/quotes/numbering-format';
import type { QuoteSettings } from '@/lib/quotes/types';

import { Button, Card, Field, inputCls, Toggle } from '../../lead-capture/_components/ui';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const numValue = (n: number) => (Number.isFinite(n) ? n : '');

function FieldErrors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return <p className="text-[11.5px] text-rose-600 dark:text-rose-400">{errors.join(' ')}</p>;
}

export function QuoteSettingsForm({
  initial,
  fiscalYearStartMonth,
}: {
  initial: QuoteSettings;
  fiscalYearStartMonth: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState<QuoteSettings>(initial);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const set = <K extends keyof QuoteSettings>(key: K, value: QuoteSettings[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const fyLabel = fiscalYearLabel(todayIso(), fiscalYearStartMonth);
  const padding = Number.isFinite(s.numberPadding) ? Math.min(Math.max(s.numberPadding, 1), 8) : 1;
  const example = formatQuoteNumber(
    { prefix: s.numberPrefix.trim(), separator: s.numberSeparator, includeFiscalYear: s.numberIncludeFy, padding },
    fyLabel,
    42,
  );

  function save() {
    startTransition(async () => {
      const res = await saveQuoteSettingsAction(s);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      setErrors({});
      toast.success('Quote settings saved');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card title="Quote numbers" description={`Example for the 42nd quote this fiscal year (${fyLabel}).`}>
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[14px] text-slate-900 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#FAFAFA]">
          {example}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Prefix" htmlFor="qs-prefix">
            <input id="qs-prefix" className={inputCls} value={s.numberPrefix} maxLength={20} onChange={(e) => set('numberPrefix', e.target.value)} />
            <FieldErrors errors={errors.numberPrefix} />
          </Field>
          <Field label="Separator" htmlFor="qs-sep" hint="Up to 3 characters; may be empty.">
            <input id="qs-sep" className={inputCls} value={s.numberSeparator} maxLength={3} onChange={(e) => set('numberSeparator', e.target.value)} />
            <FieldErrors errors={errors.numberSeparator} />
          </Field>
          <Field label="Digits" htmlFor="qs-pad" hint="The running number is zero-padded to this width.">
            <input
              id="qs-pad"
              type="number"
              min={1}
              max={8}
              className={inputCls}
              value={numValue(s.numberPadding)}
              onChange={(e) => set('numberPadding', e.target.valueAsNumber)}
            />
            <FieldErrors errors={errors.numberPadding} />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Toggle checked={s.numberIncludeFy} onChange={(v) => set('numberIncludeFy', v)} label="Include the fiscal year" />
          <span className="text-[12.5px] text-slate-700 dark:text-[#D4D4D8]">
            Include the fiscal year (numbering restarts each fiscal year)
          </span>
        </div>
      </Card>

      <Card title="Validity">
        <div className="max-w-xs">
          <Field label="Valid for (days)" htmlFor="qs-valid" hint="Sets the default “valid until” date on new quotes.">
            <input
              id="qs-valid"
              type="number"
              min={1}
              max={365}
              className={inputCls}
              value={numValue(s.defaultValidityDays)}
              onChange={(e) => set('defaultValidityDays', e.target.valueAsNumber)}
            />
            <FieldErrors errors={errors.defaultValidityDays} />
          </Field>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
