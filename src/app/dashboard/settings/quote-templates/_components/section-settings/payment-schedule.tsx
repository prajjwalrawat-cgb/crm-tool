'use client';

import { Plus, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import { Button } from '../../../lead-capture/_components/ui';
import { Field, inputCls, ToggleRow, type SectionFormProps } from './controls';

/** Percent with up to two decimals <-> basis points. */
const toPercent = (bps: number) => (Number.isFinite(bps) ? bps / 100 : '');
const toBps = (percent: number) => (Number.isFinite(percent) ? Math.round(percent * 100) : NaN);

export function PaymentScheduleSettings({ section, onChange }: SectionFormProps<'payment_schedule'>) {
  const s = section.settings;
  const milestones = s.defaultMilestones;
  const sum = milestones.reduce((a, m) => a + (Number.isFinite(m.percentBps) ? m.percentBps : 0), 0);

  const setMilestones = (next: typeof milestones) => onChange({ ...s, defaultMilestones: next });
  const patch = (i: number, p: Partial<(typeof milestones)[number]>) =>
    setMilestones(milestones.map((m, j) => (j === i ? { ...m, ...p } : m)));

  return (
    <div className="space-y-3">
      <Field label="Default milestones" hint="Percent of the quote total. Must add up to 100%.">
        <div className="space-y-1.5">
          {milestones.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                aria-label={`Milestone ${i + 1} label`}
                className={inputCls}
                value={m.label}
                placeholder="e.g. Advance with order"
                onChange={(e) => patch(i, { label: e.target.value })}
              />
              <div className="relative w-28 shrink-0">
                <input
                  aria-label={`Milestone ${i + 1} percent`}
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  className={cn(inputCls, 'pr-7')}
                  value={toPercent(m.percentBps)}
                  onChange={(e) => patch(i, { percentBps: toBps(e.target.valueAsNumber) })}
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">%</span>
              </div>
              <Button
                variant="ghost"
                aria-label={`Remove milestone ${i + 1}`}
                onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </Field>
      <div className="flex items-center justify-between">
        <Button onClick={() => setMilestones([...milestones, { label: '', percentBps: Math.max(0, 10_000 - sum) }])}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add milestone
        </Button>
        <span
          className={cn(
            'text-[12px] font-medium',
            sum === 10_000 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400',
          )}
        >
          Total {sum / 100}%
        </span>
      </div>
      <ToggleRow
        label="Reps can edit the schedule on a quote"
        checked={s.repEditable}
        onChange={(v) => onChange({ ...s, repEditable: v })}
      />
    </div>
  );
}
